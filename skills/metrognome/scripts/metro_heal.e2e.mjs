#!/usr/bin/env node
/**
 * metro_heal.e2e.mjs — sandbox e2e for metro_heal.mjs against a REAL metro-mcp
 * daemon (the pinned plugin dependency) and a fake Metro that serves CDP.
 *
 * Fully isolated from live sessions: own daemon config dir, TMPDIR (proxy lock),
 * project cwd, and Metro port. Reproduces the device-switch pin bug and checks
 * heal reaps only the stale daemon. ~30s.
 *
 * Usage: node metro_heal.e2e.mjs   (exit 0/1)
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
const MCP = path.join(here, '../../../node_modules/metro-mcp/dist/bin/metro-mcp.js'); // same path .mcp.json launches
const HEAL = path.join(here, 'metro_heal.mjs');
const GRACE = 4000;

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-heal-'));
const CFG = path.join(SB, 'cfg'), TMP = path.join(SB, 'tmp'), PROJ = path.join(SB, 'proj');
for (const d of [CFG, TMP, PROJ]) fs.mkdirSync(d);

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms, step = 500) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(step); } return false; };

// ── fake Metro: /json/list + CDP websocket that refuses devices no longer listed ──
let device = 'A', metroUp = true;
const target = (d) => ({
  id: `${d}${d}${d}-1`, title: `com.example.app (Sim ${d})`, description: 'React Native Bridgeless [C++ connection]',
  appId: 'com.example.app', type: 'node', deviceName: `Sim ${d}`,
  webSocketDebuggerUrl: `ws://localhost:${PORT}/inspector/debug?device=${d}&page=1`,
  reactNative: { logicalDeviceId: `${d}${d}${d}`, capabilities: { nativePageReloads: true, supportsMultipleDebuggers: true } },
});
const server = http.createServer((req, res) => {
  if (!metroUp) return req.socket.destroy();
  if (req.url.startsWith('/json')) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify([target(device)]));
  }
  if (req.url === '/status') return res.end('packager-status:running');
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  const d = new URL(req.url, 'http://x').searchParams.get('device');
  if (!metroUp || (d && d !== device)) return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => ws.on('message', (m) => {
    try {
      const { id, method } = JSON.parse(m);
      if (id != null) ws.send(JSON.stringify({ id, result: method === 'Runtime.evaluate' ? { result: { type: 'number', value: 2 } } : {} }));
    } catch {}
  }));
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;
const env = { ...process.env, METRO_MCP_DAEMON_CONFIG_DIR: CFG, TMPDIR: TMP, METRO_PORT: String(PORT), METRO_HEAL_GRACE_MS: String(GRACE) };

// ── real metro-mcp stdio client (spawns the managed daemon) ──────────────────
function startClient() {
  const c = spawn(process.execPath, [MCP], { cwd: PROJ, env, stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '', next = 1;
  const waiters = new Map();
  c.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
      try { const msg = JSON.parse(buf.slice(0, i)); waiters.get(msg.id)?.(msg); } catch {}
    }
  });
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    waiters.set(id, resolve);
    c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`rpc timeout ${method}`)), 15000);
  });
  return {
    c,
    init: async () => {
      await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
      c.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    },
    connected: async () => JSON.parse((await rpc('tools/call', { name: 'get_connection_status', arguments: {} })).result.content[0].text).cdpConnected,
  };
}
const records = () => fs.readdirSync(CFG).filter((f) => /^daemon-.*\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(CFG, f), 'utf8')));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// async on purpose: a sync exec would block the fake Metro living in this process
let extraEnv = {};
const run = async (...args) => (await promisify(execFile)(process.execPath, [HEAL, ...args], { cwd: PROJ, env: { ...env, ...extraEnv } })).stdout.trim();
const HEALTHY = 'metro-mcp daemons healthy';

const clients = [];
try {
  console.log('\n1. healthy daemon on device A');
  let cl = startClient(); clients.push(cl); await cl.init();
  check('daemon record written', await waitFor(() => records().length === 1, 15000));
  const pid1 = records()[0].pid;
  check('daemon CDP-connected', await waitFor(cl.connected, 20000, 1000));
  check('heal leaves connected daemon alone', (await run()) === HEALTHY && alive(pid1));

  console.log('\n2. simulator switch A → B (pin bug)');
  device = 'B';
  for (const ws of wss.clients) ws.terminate();
  await sleep(1500);
  check('daemon stays disconnected (bug reproduced)', (await cl.connected()) === false);
  const left = GRACE + 500 - (Date.now() - Date.parse(records()[0].startedAt));
  if (left > 0) await sleep(left);
  check('still disconnected after grace', (await cl.connected()) === false);
  check('--hook announces the reap', /Reaped a stale metro-mcp daemon/.test(await run('--hook')));
  check('stale daemon process gone', await waitFor(() => !alive(pid1), 5000));
  check('stale record removed', records().length === 0);
  cl.c.kill();

  console.log('\n3. reconnect → fresh daemon attaches to device B');
  cl = startClient(); clients.push(cl); await cl.init();
  check('new daemon record', await waitFor(() => records().length === 1 && records()[0].pid !== pid1, 15000));
  check('new daemon CDP-connected to B', await waitFor(cl.connected, 20000, 1000));
  const pid2 = records()[0].pid;
  await sleep(GRACE);
  check('heal leaves it alone past grace', (await run()) === HEALTHY && alive(pid2));
  check('--hook silent when healthy', (await run('--hook')) === '');

  console.log('\n4. Metro down → never reap');
  metroUp = false;
  for (const ws of wss.clients) ws.terminate();
  await sleep(9000); // backoff grows to an 8s wait, so it can't recover on its own before heal runs
  check('heal with Metro down keeps daemon', (await run()) === HEALTHY && alive(pid2));
  // Another project's Metro with a live target must not count for this daemon's Metro.
  const other = http.createServer((req, res) => res.end(JSON.stringify([target('C')])));
  await new Promise((r) => other.listen(0, r));
  extraEnv = { RCT_METRO_PORT: String(other.address().port) };
  check('other Metro live, own Metro down → keep', (await run()) === HEALTHY && alive(pid2));
  extraEnv = {};
  other.close();
  metroUp = true;
  check('Metro back up: disconnected daemon still in backoff', (await cl.connected()) === false);
  check('heal forces reconnect instead of reaping', (await run()) === HEALTHY && alive(pid2));
  check('daemon reconnected to B', await cl.connected());

  console.log('\n5. record of a dead daemon');
  fs.writeFileSync(path.join(CFG, 'daemon-deadbeef.json'), JSON.stringify({ pid: 2 ** 22 + 1, cwd: '/gone', startedAt: new Date(0).toISOString() }));
  fs.writeFileSync(path.join(CFG, 'daemon-deadbeef.lock'), '');
  const out = await run();
  check('dead record + lock reaped', /reaped dead/.test(out) && !fs.existsSync(path.join(CFG, 'daemon-deadbeef.lock')), `(${out})`);
  check('live daemon untouched', alive(pid2));
} catch (e) {
  console.log('  ERROR', e.message); fail++;
} finally {
  for (const cl of clients) cl.c.kill();
  for (const r of records()) try { process.kill(r.pid); } catch {}
  server.close();
  fs.rmSync(SB, { recursive: true, force: true });
}
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
