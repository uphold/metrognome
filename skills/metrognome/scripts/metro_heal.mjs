#!/usr/bin/env node
/**
 * metro_heal.mjs — reap stale metro-mcp daemons.
 *
 * metro-mcp runs one shared `serve` daemon per project (records in
 * ~/.config/metro-mcp/daemon-*.json). A daemon pins the first Metro target it
 * attaches to and never clears the pin, so after a simulator/device switch it
 * stays disconnected forever while every session keeps it alive.
 *
 * Reaps: records whose pid is dead, and live daemons that stay cdpConnected:false
 * (own get_connection_status, after a forced reconnect) while their own Metro
 * (the status' metroUrl — the pinned server) has an attachable target. A fresh daemon
 * spawns on the next metro-mcp (re)connect and attaches to the current target.
 *
 * Usage:
 *   node metro_heal.mjs          # print actions
 *   node metro_heal.mjs --hook   # silent unless something was reaped
 * Env: METRO_HEAL_GRACE_MS (default 60000), METRO_MCP_DAEMON_CONFIG_DIR.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Grace covers daemon startup + reconnect backoff (30s); raise via env if healthy daemons get reaped.
export const GRACE_MS = Number(process.env.METRO_HEAL_GRACE_MS) || 60_000;

/**
 * @param {{alive:boolean, connected:boolean|null, startedAt:string}} d  connected null = probe failed
 * @returns {'dead'|'stale'|null}
 */
export function verdict(d, { metroHasTarget, now = Date.now() }) {
  if (!d.alive) return 'dead';
  if (!metroHasTarget || d.connected !== false) return null;
  return now - Date.parse(d.startedAt) > GRACE_MS ? 'stale' : null;
}

const configDir = () =>
  process.env.METRO_MCP_DAEMON_CONFIG_DIR || path.join(os.homedir(), '.config', 'metro-mcp');

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Daemon records and MCP output are untrusted: only ever talk to loopback.
const isLocal = (url) => /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url);

async function metroHasTarget(metroUrl) {
  try {
    if (!isLocal(metroUrl)) return false;
    const res = await fetch(new URL('/json/list', metroUrl), { signal: AbortSignal.timeout(1500) });
    return (await res.json()).some((t) => t.id !== '-1'); // '-1' = synthetic reloadable-page ghost
  } catch { return false; }
}

/**
 * Ask the daemon itself over its local MCP endpoint.
 * @returns {Promise<{connected:boolean|null, metroHasTarget:boolean}>}  connected null = can't answer
 */
async function probe(url) {
  const failed = { connected: null, metroHasTarget: false };
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const post = (body) => fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...body }), signal: AbortSignal.timeout(5000) });
  const json = async (res) => {
    const text = await res.text();
    return JSON.parse(text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5)).pop() ?? text);
  };
  try {
    if (!isLocal(url)) return failed;
    const init = await post({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'metrognome-heal', version: '1' } } });
    await init.text();
    const sid = init.headers.get('mcp-session-id');
    if (sid) headers['mcp-session-id'] = sid;
    headers['mcp-protocol-version'] = '2025-06-18';
    await (await post({ method: 'notifications/initialized' })).text();
    const call = async (id, name, args = {}) => json(await post({ id, method: 'tools/call', params: { name, arguments: args } }));
    const status = async (id) => JSON.parse((await call(id, 'get_connection_status')).result.content[0].text);
    let { cdpConnected: connected, metroUrl } = await status(2);
    // Only the daemon's own Metro counts — another project's Metro having a target says nothing.
    const hasTarget = connected === false && await metroHasTarget(metroUrl);
    // Disconnected may just be reconnect backoff (e.g. Metro restarted): evaluate_js forces an
    // immediate attempt. A valid pin recovers here; a pin to a gone device stays down.
    if (hasTarget) { await call(3, 'evaluate_js', { expression: '0' }); connected = (await status(4)).cdpConnected; }
    if (sid) fetch(url, { method: 'DELETE', headers }).catch(() => {});
    return { connected: typeof connected === 'boolean' ? connected : null, metroHasTarget: hasTarget };
  } catch { return failed; }
}

export async function heal() {
  const dir = configDir();
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^daemon-[a-f0-9]+\.json$/.test(f)); } catch { return []; }
  // Parallel: runs inside the blocking SessionStart hook, so one hung daemon must not stack up.
  const actions = await Promise.all(files.map(async (f) => {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; }
    const isAlive = alive(rec.pid);
    const { connected, metroHasTarget: hasTarget } = isAlive ? await probe(rec.url) : { connected: null, metroHasTarget: false };
    const v = verdict({ ...rec, alive: isAlive, connected }, { metroHasTarget: hasTarget });
    if (!v) return null;
    try {
      if (v === 'stale') try { process.kill(rec.pid, 'SIGTERM'); } catch {}
      fs.rmSync(path.join(dir, f), { force: true });
      fs.rmSync(path.join(dir, f.replace(/\.json$/, '.lock')), { force: true });
    } catch { return null; } // EPERM/EBUSY: leave it for the next run
    return { verdict: v, pid: rec.pid, cwd: rec.cwd };
  }));
  return actions.filter(Boolean);
}

// realpath: argv[1] keeps symlinks (/tmp → /private/tmp, linked plugin dirs), import.meta.url doesn't
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const actions = await heal();
  if (process.argv.includes('--hook')) {
    if (actions.some((a) => a.verdict === 'stale'))
      console.log(`[metrognome] Reaped a stale metro-mcp daemon (pinned to a device no longer on its Metro). If metro-mcp tools report "Not connected", run /mcp → reconnect metro-mcp.`);
  } else {
    for (const a of actions) console.log(`  reaped ${a.verdict} metro-mcp daemon pid ${a.pid} (${a.cwd})`);
    if (!actions.length) console.log('  metro-mcp daemons healthy');
  }
}
