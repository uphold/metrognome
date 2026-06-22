#!/usr/bin/env node
/**
 * build_run_report.mjs — inject run-state.json into the report template to
 * produce a standalone .metrognome/report.html live progress dashboard.
 *
 * The template auto-refreshes every 3 s; call this script after each loop
 * iteration to update the report in place.
 *
 * Usage:
 *   node build_run_report.mjs <run-state.json> [--out report.html] [--open]
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(__dirname, '..', 'assets');
const TEMPLATE = path.join(ASSETS, 'report.template.html');

const DATA_MARKER = '/*__RUN_DATA__*/';

function main() {
  const args = process.argv.slice(2);
  const open = args.includes('--open');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : 'report.html';
  const outValIdx = outIdx >= 0 ? outIdx + 1 : -1;
  const dataFile = args.find((a, i) => !a.startsWith('--') && i !== outValIdx);

  if (!dataFile) {
    console.error('usage: node build_run_report.mjs <run-state.json> [--out report.html] [--open]');
    process.exit(1);
  }
  if (!fs.existsSync(dataFile)) { console.error(`missing run-state: ${dataFile}`); process.exit(1); }
  if (!fs.existsSync(TEMPLATE)) { console.error(`missing template: ${TEMPLATE}`); process.exit(1); }

  const rawData = fs.readFileSync(dataFile, 'utf8');
  try {
    JSON.parse(rawData);
  } catch (e) {
    console.error(`invalid JSON in run-state: ${e.message}`);
    process.exit(1);
  }
  const template = fs.readFileSync(TEMPLATE, 'utf8');

  if (!template.includes(DATA_MARKER)) {
    console.error(`template is missing injection marker: ${DATA_MARKER}`);
    process.exit(1);
  }

  // Escape </script> so it can't close the script block if it appears in data values
  const safeData = rawData.replace(/<\/script>/gi, '<\\/script>');
  const [before, after] = template.split(DATA_MARKER);
  const out = before + safeData + after;

  const absOut = path.resolve(outFile);
  fs.writeFileSync(absOut, out, 'utf8');

  const data = JSON.parse(rawData);
  const kept = (data.iterations || []).filter(i => i.decision === 'KEEP').length;
  const total = (data.iterations || []).length;
  console.log(`metrognome run-report`);
  console.log(`  wrote ${absOut}`);
  console.log(`  ${data.preset || '?'} · ${data.target || '?'} · status: ${data.status || '?'}`);
  if (total) console.log(`  ${kept}/${total} iterations kept · net: ${data.netDelta || '—'}`);

  if (open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execFile(opener, [absOut]);
    console.log(`  opened: ${absOut}`);
  }
}

main();
