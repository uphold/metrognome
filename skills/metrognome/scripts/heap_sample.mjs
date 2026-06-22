#!/usr/bin/env node
/**
 * heap_sample.mjs — CDP JS-heap sampler for metrognome
 *
 * Connects to a running Metro/Expo dev server via raw WebSocket CDP (no metro-mcp),
 * correctly targeting the live Hermes JS page on New Arch (nativePageReloads:true).
 * Works on iOS Simulator, iOS device, Android emulator/device.
 *
 * What it measures: Hermes JS-object heap (Runtime.getHeapUsage).
 * Note: TypedArray backing buffers are tracked separately by Hermes and are NOT
 * included in usedSize. For leak detection, watch for JS-object heap growth that
 * survives HeapProfiler.collectGarbage — that is the retained-object signal.
 *
 * Usage:
 *   node heap_sample.mjs --once
 *     → prints JSON { usedSize, totalSize, timestamp } once; exits 0
 *
 *   node heap_sample.mjs --cycles 5
 *     → GC-bracketed readings × 5; prints comma-sep usedSize bytes (CSV)
 *       ready to pipe into stats.mjs --direction lower --unit bytes.
 *     NOTE: readings are taken consecutively with no workload between them.
 *     For real leak detection, use --once AFTER each agent-device nav cycle,
 *     collecting the series manually. --cycles N is best for establishing a
 *     post-GC noise floor (what idle heap looks like across N reads).
 *
 * Options:
 *   --host <h>   Metro host (default: localhost)
 *   --port <p>   Metro port (default: 8081)
 *   --settle <ms>  ms to wait between collectGarbage and the reading (default: 400)
 *   --json         always emit full JSON objects rather than bare CSV
 *
 * Exit codes: 0 = success, 1 = connection/CDP failure
 *
 * Example — feed into stats gate:
 *   BASELINE=$(node heap_sample.mjs --cycles 5 --csv)
 *   # apply fix, drive cycles with agent-device
 *   CANDIDATE=$(node heap_sample.mjs --cycles 5 --csv)
 *   node stats.mjs --baseline "$BASELINE" --candidate "$CANDIDATE" \
 *     --min-effect 2000000 --k 2 --direction lower --unit bytes
 */

import http from 'node:http';
import { createRequire } from 'node:module';
import process from 'node:process';

// ── arg parsing ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : def;
};

const MODE_ONCE   = flag('--once');
const MODE_CYCLES = flag('--cycles');
const CYCLES      = MODE_CYCLES ? parseInt(opt('--cycles', '3'), 10) : 1;
const HOST        = opt('--host', 'localhost');
const PORT        = opt('--port', '8081');
const SETTLE_MS   = parseInt(opt('--settle', '400'), 10);
const EMIT_JSON   = flag('--json');
const EMIT_CSV    = flag('--csv');  // bare comma-sep usedSize for stats.mjs piping

if (!MODE_ONCE && !MODE_CYCLES) {
  console.error('Usage: heap_sample.mjs --once | --cycles <N> [options]');
  process.exit(1);
}

// ── CDP helpers ──────────────────────────────────────────────────────────────
function getJsonList(host, port) {
  return new Promise((resolve, reject) => {
    http.get(`http://${host}:${port}/json/list`, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('Could not parse /json/list: ' + e.message)); }
      });
    }).on('error', (e) => reject(new Error(`/json/list unreachable at ${host}:${port} — is Metro running? (${e.message})`)));
  });
}

/**
 * Select the live Hermes JS-runtime page from /json/list.
 * On New Arch (RN 0.83+) page 1 has nativePageReloads:true + prefersFuseboxFrontend:true.
 * Exclude the synthetic ghost target (id === "-1", vm === "don't use").
 */
function selectTarget(pages) {
  // Exclude ghosts
  const real = pages.filter(p =>
    p.id !== '-1' &&
    (p.reactNative?.capabilities?.vm ?? p.vm) !== "don't use"
  );
  if (real.length === 0) throw new Error('No real CDP pages found — ensure the app is running and Metro is reachable.');

  // Prefer the Fusebox/Bridgeless JS page (New Arch indicator)
  const fuseboxPage = real.find(p => p.reactNative?.capabilities?.nativePageReloads === true);
  if (fuseboxPage) return fuseboxPage;

  // Fallback: first real page
  return real[0];
}

function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    // Resolve ws from the plugin's own node_modules (ws is a declared dependency).
    // Falls back to the target RN app's node_modules (commonly present transitively via Metro).
    let WS;
    const scriptDir = new URL('.', import.meta.url).pathname;
    const pluginRoot = scriptDir.replace(/\/skills\/metrognome\/scripts\/?$/, '');
    for (const base of [pluginRoot, process.cwd()]) {
      try { WS = createRequire(`${base}/package.json`)('ws'); break; } catch (_) {}
    }
    if (!WS) { reject(new Error('ws package not found — ensure npm install has been run in the metrognome plugin directory')); return; }

    const ws = new WS(wsUrl);
    let msgId = 1;
    const pending = new Map();

    ws.on('open', () => {
      ws._cdpSend = (method, params = {}) => {
        const id = msgId++;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`CDP timeout: ${method}`));
          }, 10_000);
          pending.set(id, { resolve: res, reject: rej, timer });
          ws.send(JSON.stringify({ id, method, params }));
        });
      };
      resolve(ws);
    });
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── sampling ─────────────────────────────────────────────────────────────────
async function readHeap(ws) {
  return ws._cdpSend('Runtime.getHeapUsage');
}

async function gcAndRead(ws, settleMs) {
  try {
    await ws._cdpSend('HeapProfiler.collectGarbage');
  } catch (e) {
    // collectGarbage is critical for leak detection (releases transient garbage so only retained
    // objects remain). If it fails, readings will over-count normal allocations as "leaks".
    process.stderr.write(`heap_sample: HeapProfiler.collectGarbage failed — readings may include transient allocations (${e.message})\n`);
  }
  await sleep(settleMs);
  return readHeap(ws);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Connect
  const pages = await getJsonList(HOST, PORT);
  const target = selectTarget(pages);
  const ws = await cdpConnect(target.webSocketDebuggerUrl);

  try {
    if (MODE_ONCE) {
      const r = await readHeap(ws);
      const out = { usedSize: r.usedSize, totalSize: r.totalSize, timestamp: Date.now() };
      console.log(JSON.stringify(out));
    } else {
      // --cycles N: for each cycle, GC → settle → read
      const readings = [];
      for (let i = 0; i < CYCLES; i++) {
        const r = await gcAndRead(ws, SETTLE_MS);
        readings.push({ cycle: i + 1, usedSize: r.usedSize, totalSize: r.totalSize, timestamp: Date.now() });
        if (i < CYCLES - 1) await sleep(200); // brief gap between cycles
      }

      if (EMIT_CSV || (!EMIT_JSON && !EMIT_CSV)) {
        // Default for --cycles: bare CSV of usedSize bytes, ready for stats.mjs
        console.log(readings.map(r => r.usedSize).join(','));
      }
      if (EMIT_JSON) {
        console.log(JSON.stringify(readings, null, 2));
      }
    }
  } finally {
    ws.close();
  }
}

main().catch((e) => {
  console.error('heap_sample error:', e.message);
  process.exit(1);
});
