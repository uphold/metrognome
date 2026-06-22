#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const SCRIPTS = new URL('../skills/metrognome/scripts/', import.meta.url);

const MAP = {
  scan:     'perf_scan.mjs',
  map:      'build_perf_map.mjs',
  report:   'build_run_report.mjs',
  playbook: 'build_playbook.mjs',
  stats:    'stats.mjs',
  doctor:   'doctor.mjs',
  heap:     'heap_sample.mjs',
};

const [,, sub, ...rest] = process.argv;

if (!sub || sub === '--help' || sub === '-h') {
  console.log(`Usage: metrognome <subcommand> [args]

Subcommands:
  scan      Babel AST scan of an RN repo → graph.json
  map       Render graph.json → standalone HTML 3D force-graph
  report    Render run-state.json → live HTML progress dashboard
  playbook  Distil ledger runs → playbook.md + playbook.json
  stats     Statistical gate (mean ± stddev, KEEP/REVERT decision)
  doctor    Toolchain check + .metrognome/ bootstrap
  heap      JS-heap leak sampling across open↔close cycles
`);
  process.exit(sub ? 0 : 1);
}

if (!MAP[sub]) {
  console.error(`Unknown subcommand: ${sub}`);
  console.error(`Run \`metrognome --help\` for a list of subcommands.`);
  process.exit(1);
}

const script = fileURLToPath(new URL(MAP[sub], SCRIPTS));
const child = spawn(process.execPath, [script, ...rest], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
