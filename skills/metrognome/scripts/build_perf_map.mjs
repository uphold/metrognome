#!/usr/bin/env node
/**
 * build_perf_map.mjs — merge graph.json into the HTML template to produce a
 * single, fully standalone perf-map.html.
 *
 * "Standalone" is a hard requirement: the vendored 3d-force-graph build (which
 * bundles three.js) and the graph payload are both INLINED into the output, so
 * perf-map.html renders from file:// with the network disabled and no sibling
 * files. That's what makes it safe to hand to anyone / open on a plane.
 *
 * Usage:
 *   node build_perf_map.mjs <graph.json> [--out perf-map.html] [--open]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(__dirname, '..', 'assets');
const TEMPLATE = path.join(ASSETS, 'perf-map.template.html');
const LIB = path.join(ASSETS, '3d-force-graph.min.js');

const LIB_MARKER = '/*__FORCE_GRAPH_LIB__*/';
const DATA_MARKER = '/*__GRAPH_DATA__*/';

function main() {
  const args = process.argv.slice(2);
  const open = args.includes('--open');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : 'perf-map.html';
  const outValIdx = outIdx >= 0 ? outIdx + 1 : -1; // index of --out's value, if any
  const graphFile = args.find((a, i) => !a.startsWith('--') && i !== outValIdx);

  if (!graphFile) {
    console.error('usage: node build_perf_map.mjs <graph.json> [--out perf-map.html] [--open]');
    process.exit(1);
  }
  for (const [p, what] of [[graphFile, 'graph'], [TEMPLATE, 'template'], [LIB, 'vendored lib']]) {
    if (!fs.existsSync(p)) { console.error(`missing ${what}: ${p}`); process.exit(1); }
  }

  const graphRaw = fs.readFileSync(graphFile, 'utf8');
  const graph = JSON.parse(graphRaw); // validate it parses before embedding
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const lib = fs.readFileSync(LIB, 'utf8');

  if (!template.includes(LIB_MARKER) || !template.includes(DATA_MARKER)) {
    console.error('template is missing an injection marker — did the template change?');
    process.exit(1);
  }

  // Literal split/join (not regex) so the 1.3MB minified lib can't be
  // misinterpreted as a replacement pattern.
  const html = template
    .split(LIB_MARKER).join(lib)
    .split(DATA_MARKER).join(graphRaw.trim());

  fs.writeFileSync(outFile, html);
  const outAbs = path.resolve(outFile);
  const kb = (fs.statSync(outAbs).size / 1024).toFixed(0);

  const s = graph.meta?.stats || {};
  console.log(`\nmetrognome perf-map`);
  console.log(`  wrote ${outAbs} (${kb} KB, standalone)`);
  console.log(`  ${s.nodes ?? '?'} modules · ${s.hotspots ?? '?'} hotspot(s) · ${s.findings ?? '?'} findings`);
  if (graph.top3?.length) {
    console.log(`  Top-3:`);
    for (const t of graph.top3) console.log(`    ${t.rank}. ${t.paste}  (debt ${t.debt})`);
  }
  console.log(`  open with:  open ${outAbs}\n`);

  if (open) {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const oArgs = process.platform === 'win32' ? ['/c', 'start', '', outAbs] : [outAbs];
    execFile(opener, oArgs, (err) => { if (err) console.error('could not auto-open:', err.message); });
  }
}

main();
