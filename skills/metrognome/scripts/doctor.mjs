#!/usr/bin/env node
/**
 * doctor.mjs — metrognome preflight + first-run setup.
 *
 * Run from the TARGET RN repo. Auto-bootstraps the .metrognome/ workspace,
 * probes Metro dev server + agent-react-devtools daemon live status, detects
 * git state, JS engine (Hermes/JSC), architecture, and connected devices.
 *
 * Usage:
 *   node doctor.mjs            # report checklist + setup actions
 *   node doctor.mjs --init     # also create .metrognome/ if missing
 *   node doctor.mjs --launch-metro  # open Metro in a new terminal (macOS best-effort)
 *                                   # or print the start command on non-macOS / failure
 *   node doctor.mjs --self-test     # run parser unit assertions (CI contract), exit 0/1
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

// ── Pure detection functions (exported; no I/O — all inputs are strings/objects) ─

/**
 * Classify git repository state from raw command output.
 * @param {{insideWorkTree:boolean|null, headSha:string|null, symbolicRef:string|null, porcelain?:string}} opts
 * @returns {{ state:'usable'|'no-repo'|'no-commits'|'detached', branch:string|null, dirty:string[] }}
 */
export function parseGitState({ insideWorkTree, headSha, symbolicRef, porcelain = '' }) {
  if (!insideWorkTree) return { state: 'no-repo', branch: null, dirty: [] };
  if (!headSha) return { state: 'no-commits', branch: null, dirty: [] };
  if (!symbolicRef) return { state: 'detached', branch: null, dirty: [] };
  const branch = symbolicRef.replace('refs/heads/', '');
  const dirty = porcelain ? porcelain.split('\n').map(l => l.trim()).filter(Boolean) : [];
  return { state: 'usable', branch, dirty };
}

/**
 * Detect New Architecture status from package.json + app config files.
 * @param {{pkg?:object, appJson?:object, appConfigText?:string}} opts
 * @returns {{ newArch:boolean, source:string, rnVersion:string|null }}
 */
export function detectArch({ pkg = {}, appJson = {}, appConfigText = '' }) {
  let newArch = false;
  let rnVersion = null;
  let source = 'default';

  const rnDep = pkg?.dependencies?.['react-native'] || pkg?.devDependencies?.['react-native'] || '';
  const rnMatch = rnDep.match(/(\d+)\.(\d+)/);
  if (rnMatch) {
    const major = Number(rnMatch[1]);
    const minor = Number(rnMatch[2]);
    rnVersion = `${major}.${minor}`;
    if (major > 0 || minor >= 76) { newArch = true; source = 'rnVersion'; }
  }

  const flag = appJson?.expo?.newArchEnabled ?? appJson?.newArchEnabled;
  if (flag === true) { newArch = true; source = 'appJson'; }
  if (flag === false) { newArch = false; source = 'appJson'; }

  if (/newArchEnabled\s*:\s*true/.test(appConfigText)) { newArch = true; source = 'appConfig'; }
  if (/newArchEnabled\s*:\s*false/.test(appConfigText)) { newArch = false; source = 'appConfig'; }

  return { newArch, source, rnVersion };
}

/**
 * Detect JS engine (Hermes or JSC) from app config + gradle.properties.
 * Default is Hermes — the RN default since 0.70.
 * @param {{pkg?:object, appJson?:object, appConfigText?:string, gradleProps?:string}} opts
 * @returns {{ engine:'hermes'|'jsc'|'unknown', source:string }}
 */
export function detectEngine({ pkg = {}, appJson = {}, appConfigText = '', gradleProps = '' }) {
  // gradle.properties hermesEnabled=false → explicit JSC opt-out
  if (/^\s*hermesEnabled\s*=\s*false\s*$/m.test(gradleProps)) {
    return { engine: 'jsc', source: 'gradleProps' };
  }

  // Expo app.json jsEngine keys (platform-level or top-level)
  const expoEngine =
    appJson?.expo?.jsEngine ||
    appJson?.expo?.ios?.jsEngine ||
    appJson?.expo?.android?.jsEngine;
  if (expoEngine === 'jsc') return { engine: 'jsc', source: 'appJson' };
  if (expoEngine === 'hermes') return { engine: 'hermes', source: 'appJson' };

  // app.config.* text pattern
  if (/jsEngine\s*:\s*['"]jsc['"]/.test(appConfigText)) return { engine: 'jsc', source: 'appConfig' };
  if (/jsEngine\s*:\s*['"]hermes['"]/.test(appConfigText)) return { engine: 'hermes', source: 'appConfig' };

  return { engine: 'hermes', source: 'default' };
}

/**
 * @param {{pkgRaw:string, hasPkgJson:boolean}} opts
 * @returns {boolean}
 */
export function isRNProject({ pkgRaw, hasPkgJson }) {
  return hasPkgJson && /react-native|expo/.test(pkgRaw);
}

/**
 * Parse Metro /json/list response. Excludes the synthetic "-1" ghost
 * (REACT_NATIVE_RELOADABLE_PAGE_ID).
 * @param {string|null} jsonListRaw
 * @returns {{ reachable:boolean, liveTargets:number }}
 */
export function parseMetroTargets(jsonListRaw) {
  if (!jsonListRaw) return { reachable: false, liveTargets: 0 };
  try {
    const targets = JSON.parse(jsonListRaw);
    const live = Array.isArray(targets) ? targets.filter(t => t.id !== '-1') : [];
    return { reachable: true, liveTargets: live.length };
  } catch {
    return { reachable: true, liveTargets: 0 };
  }
}

/**
 * Parse `agent-react-devtools status` output.
 * @param {string|null} statusOut
 * @returns {{ running:boolean, connected:number }}
 */
export function parseDevtoolsStatus(statusOut) {
  if (!statusOut) return { running: false, connected: 0 };
  const m = statusOut.match(/Apps:\s*(\d+)\s+connected/i);
  return { running: true, connected: m ? parseInt(m[1], 10) : 0 };
}

/**
 * Parse `xcrun simctl list devices booted -j` JSON output.
 * @param {string|null} simctlJson
 * @returns {{ udid:string, name:string }[]}
 */
export function parseSimctl(simctlJson) {
  if (!simctlJson) return [];
  try {
    const data = JSON.parse(simctlJson);
    const booted = [];
    for (const devices of Object.values(data.devices || {})) {
      for (const d of devices) {
        if (d.state === 'Booted') booted.push({ udid: d.udid, name: d.name });
      }
    }
    return booted;
  } catch {
    return [];
  }
}

/**
 * Parse `adb devices` output.
 * @param {string|null} adbOut
 * @returns {{ serial:string, state:string }[]}
 */
export function parseAdbDevices(adbOut) {
  if (!adbOut) return [];
  return adbOut.split('\n')
    .slice(1) // skip "List of devices attached" header
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('*') && !l.startsWith('adb server'))
    .map(l => {
      const parts = l.split(/\s+/);
      return { serial: parts[0], state: parts[1] || '' };
    })
    .filter(d => d.serial && d.state);
}

// ── Module-level helpers ──────────────────────────────────────────────────────

const ok = (b) => (b ? '\x1b[32mOK \x1b[0m' : '\x1b[31mXX \x1b[0m');
const warn = '\x1b[33m?? \x1b[0m';

function has(cmd) {
  try { execSync(`command -v ${cmd}`, { stdio: 'ignore' }); return true; } catch { return false; }
}
function sh(cmd) {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; }
}

// ── Module-level state (safe to evaluate before --self-test short-circuits) ───

const repo = process.cwd();
const doInit = process.argv.includes('--init');
const doLaunchMetro = process.argv.includes('--launch-metro');

// ── Metro helpers ─────────────────────────────────────────────────────────────

function metroPort() {
  const portIdx = process.argv.indexOf('--port');
  if (portIdx !== -1) {
    const p = parseInt(process.argv[portIdx + 1], 10);
    if (!isNaN(p)) return p;
  }
  const envPort = process.env.RCT_METRO_PORT;
  if (envPort) {
    const p = parseInt(envPort, 10);
    if (!isNaN(p)) return p;
  }
  return 8081;
}

function probeMetro(port) {
  const url = `http://localhost:${port}/json/list`;
  const raw = sh(`curl -s --max-time 2 "${url}"`);
  return parseMetroTargets(raw);
}

/** Poll Metro until reachable or timeout expires. Returns the last probe result. */
function pollMetro(port, timeoutMs = 30000) {
  const url = `http://localhost:${port}/json/list`;
  const deadline = Date.now() + timeoutMs;
  let last = { reachable: false, liveTargets: 0 };
  while (Date.now() < deadline) {
    const raw = sh(`curl -s --max-time 2 "${url}"`);
    last = parseMetroTargets(raw);
    if (last.reachable) return last;
    const remaining = deadline - Date.now();
    if (remaining > 2000) {
      try { execSync('sleep 2', { stdio: 'ignore' }); } catch {}
    }
  }
  return last;
}

function probeDevtools() {
  const out = sh('agent-react-devtools status 2>/dev/null');
  return parseDevtoolsStatus(out);
}

// ── Start command detection ───────────────────────────────────────────────────

function detectStartEnv() {
  let pkgManager = 'npm';
  if (fs.existsSync(path.join(repo, 'bun.lockb'))) pkgManager = 'bun';
  else if (fs.existsSync(path.join(repo, 'pnpm-lock.yaml'))) pkgManager = 'pnpm';
  else if (fs.existsSync(path.join(repo, 'yarn.lock'))) pkgManager = 'yarn';

  let startCmd = `${pkgManager} start`;
  try {
    const raw = sh('cat package.json');
    if (raw) {
      const pkg = JSON.parse(raw);
      const scripts = pkg?.scripts || {};
      const s = scripts.start || '';
      if (/expo\s+start/.test(s)) {
        const flag = s.includes('--dev-client') ? ' --dev-client' : '';
        const runner = pkgManager === 'npm' ? 'npx' : pkgManager;
        startCmd = `${runner} expo start${flag}`;
      } else if (/react-native\s+start/.test(s)) {
        const runner = pkgManager === 'npm' ? 'npx' : pkgManager;
        startCmd = `${runner} react-native start`;
      } else if (s) {
        startCmd = `${pkgManager} start`;
      }
    }
  } catch {}

  return { pkgManager, startCmd };
}

// ── Launch Metro in a new terminal (macOS best-effort) ────────────────────────
// Always prints the command regardless of launch success — never silently assume success.
function launchMetro(startCmd) {
  console.log(`\n  Metro start command: ${startCmd}`);

  if (process.platform !== 'darwin') {
    console.log(`  (non-macOS) Run the command above in your terminal to start Metro.`);
    return false;
  }

  const iTerm2Running = (() => {
    try {
      const r = sh('pgrep -x iTerm2');
      return r !== null && r.length > 0;
    } catch { return false; }
  })();

  const escapedRepo = repo.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedCmd = startCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  let script;
  if (iTerm2Running) {
    script = `tell application "iTerm2"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow
    write text "cd \\"${escapedRepo}\\" && ${escapedCmd}"
  end tell
end tell`;
  } else {
    script = `tell application "Terminal"
  activate
  do script "cd \\"${escapedRepo}\\" && ${escapedCmd}"
end tell`;
  }

  const tmpScript = path.join(os.tmpdir(), 'mg-launch-metro.scpt');
  try {
    fs.writeFileSync(tmpScript, script);
    execFileSync('osascript', [tmpScript], { stdio: 'ignore' });
    const term = iTerm2Running ? 'iTerm2' : 'Terminal.app';
    console.log(`  ${ok(true)} opened Metro in ${term} — watch that window for bundle output`);
    return true;
  } catch {
    console.log(`  ${warn} osascript launch failed — run the command above in your own terminal`);
    return false;
  }
}

// ── Bootstrap .metrognome/ workspace ──────────────────────────────────────────

const PERF_MEMORY_HEADER = (name) => `# Performance Memory — ${name}

> metrognome's per-repo brain. One line per perf gap:
> \`area/file · symptom · suspected cause · preset · status(open|fixed|reverted) · ref\`
> Read at the start of any perf work. Commit this file with the app.

<!-- entries below, newest first -->
`;

const DEFAULT_CONFIG = {
  commitMode: 'per-iteration', // "per-iteration" | "one-commit" | "no-commit"
  liveReport: false,           // write/refresh .metrognome/report.html during the run
  openReport: true,            // auto-open report.html when liveReport is on
  runs: 5,                     // N measurement runs per iteration
  warmupDiscard: 1,            // warm-up runs to discard
  k: 2,                        // gate noise multiplier
  budget: 6,                   // max iterations per run (0 = run until no fix clears gate)
};

const GITIGNORE_CONTENT = `# metrognome — generated run artifacts (not committed with the app)
report.html
run-state.json
`;

function bootstrap() {
  const dir = path.join(repo, '.metrognome');
  fs.mkdirSync(path.join(dir, 'ledger'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });

  const mem = path.join(dir, 'perf-memory.md');
  if (!fs.existsSync(mem)) fs.writeFileSync(mem, PERF_MEMORY_HEADER(path.basename(repo)));

  const cfg = path.join(dir, 'config.json');
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');

  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE_CONTENT);

  console.log(`  bootstrapped ${path.relative(repo, dir) || '.metrognome'}/ (perf-memory.md, config.json, ledger/, archive/)`);
  console.log(`  .metrognome/.gitignore created — report.html and run-state.json are gitignored`);
}

// ── Self-test (CI contract — short-circuits before main() I/O) ────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const check = (name, got, want) => {
    const eq = JSON.stringify(got) === JSON.stringify(want);
    console.log(`  ${eq ? 'PASS' : 'FAIL'}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
    eq ? pass++ : fail++;
  };

  // parseGitState — all four states
  check('no-repo → state', parseGitState({ insideWorkTree: false }).state, 'no-repo');
  check('no-repo → dirty empty', parseGitState({ insideWorkTree: false }).dirty, []);
  check('no-commits → state', parseGitState({ insideWorkTree: true, headSha: null }).state, 'no-commits');
  check('detached → state', parseGitState({ insideWorkTree: true, headSha: 'abc123', symbolicRef: null }).state, 'detached');
  {
    const r = parseGitState({ insideWorkTree: true, headSha: 'abc123', symbolicRef: 'refs/heads/main', porcelain: ' M a.js\n?? b.js' });
    check('usable → state', r.state, 'usable');
    check('usable → branch', r.branch, 'main');
    check('usable → dirty length', r.dirty.length, 2);
    check('usable → dirty[0]', r.dirty[0], 'M a.js');
  }
  {
    const r = parseGitState({ insideWorkTree: true, headSha: 'abc', symbolicRef: 'refs/heads/main', porcelain: '' });
    check('usable clean → dirty empty', r.dirty, []);
  }

  // detectArch
  {
    const r1 = detectArch({ pkg: { dependencies: { 'react-native': '0.76.0' } }, appJson: {}, appConfigText: '' });
    check('rn 0.76 → newArch true', r1.newArch, true);
    check('rn 0.76 → rnVersion', r1.rnVersion, '0.76');
    const r2 = detectArch({ pkg: { dependencies: { 'react-native': '0.76.0' } }, appJson: { expo: { newArchEnabled: false } }, appConfigText: '' });
    check('appJson override false → newArch false', r2.newArch, false);
    const r3 = detectArch({ pkg: { dependencies: { 'react-native': '0.74.0' } }, appJson: {}, appConfigText: '' });
    check('rn 0.74 → newArch false', r3.newArch, false);
    const r4 = detectArch({ pkg: { dependencies: { 'react-native': '0.74.0' } }, appJson: { expo: { newArchEnabled: true } }, appConfigText: '' });
    check('appJson override true on old rn → newArch true', r4.newArch, true);
  }

  // detectEngine
  {
    check('gradle hermesEnabled=false → jsc', detectEngine({ gradleProps: 'hermesEnabled=false' }).engine, 'jsc');
    check('gradle source', detectEngine({ gradleProps: 'hermesEnabled=false' }).source, 'gradleProps');
    check('expo.jsEngine jsc → jsc', detectEngine({ appJson: { expo: { jsEngine: 'jsc' } } }).engine, 'jsc');
    check('expo.ios.jsEngine jsc → jsc', detectEngine({ appJson: { expo: { ios: { jsEngine: 'jsc' } } } }).engine, 'jsc');
    check('appConfig jsc string → jsc', detectEngine({ appConfigText: "jsEngine: 'jsc'" }).engine, 'jsc');
    check('nothing → hermes', detectEngine({}).engine, 'hermes');
    check('nothing → default source', detectEngine({}).source, 'default');
    check('expo.jsEngine hermes → hermes', detectEngine({ appJson: { expo: { jsEngine: 'hermes' } } }).engine, 'hermes');
  }

  // parseMetroTargets
  {
    check('null → not reachable', parseMetroTargets(null).reachable, false);
    check('empty string → not reachable', parseMetroTargets('').reachable, false);
    const raw = JSON.stringify([{ id: '-1', title: 'ghost' }, { id: '1', title: 'live' }]);
    const r = parseMetroTargets(raw);
    check('drops -1 ghost → liveTargets 1', r.liveTargets, 1);
    check('reachable', r.reachable, true);
    const onlyGhost = JSON.stringify([{ id: '-1' }]);
    check('only ghost → liveTargets 0', parseMetroTargets(onlyGhost).liveTargets, 0);
  }

  // parseDevtoolsStatus
  {
    check('null → not running', parseDevtoolsStatus(null).running, false);
    check('null → connected 0', parseDevtoolsStatus(null).connected, 0);
    const r = parseDevtoolsStatus('Apps: 2 connected');
    check('running', r.running, true);
    check('connected count', r.connected, 2);
    check('1 connected', parseDevtoolsStatus('Apps: 1 connected').connected, 1);
  }

  // parseSimctl
  {
    const simctlJson = JSON.stringify({
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
          { udid: 'AAAA', name: 'iPhone 15', state: 'Booted' },
          { udid: 'BBBB', name: 'iPhone 14', state: 'Shutdown' },
        ],
        'com.apple.CoreSimulator.SimRuntime.iOS-16-0': [
          { udid: 'CCCC', name: 'iPhone 13', state: 'Booted' },
        ],
      },
    });
    const r = parseSimctl(simctlJson);
    check('simctl booted count', r.length, 2);
    check('simctl first name', r[0].name, 'iPhone 15');
    check('simctl null → empty', parseSimctl(null).length, 0);
    check('simctl invalid json → empty', parseSimctl('not json').length, 0);
  }

  // parseAdbDevices
  {
    const adbOut = 'List of devices attached\nemulator-5554\tdevice\n192.168.1.1:5555\tdevice\n';
    const r = parseAdbDevices(adbOut);
    check('adb device count', r.length, 2);
    check('adb first serial', r[0].serial, 'emulator-5554');
    check('adb first state', r[0].state, 'device');
    const empty = parseAdbDevices('List of devices attached\n');
    check('adb no devices → empty', empty.length, 0);
    check('adb null → empty', parseAdbDevices(null).length, 0);
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  console.log(`\nmetrognome doctor — ${repo}\n`);

  // Node + babel deps
  const node = process.versions.node;
  const nodeOk = parseInt(node, 10) >= 18;
  console.log(`  ${ok(nodeOk)} node ${node} (>=18 required)`);

  const requireLocal = createRequire(import.meta.url);
  let babelOk = true;
  try { requireLocal('@babel/parser'); requireLocal('@babel/traverse'); } catch { babelOk = false; }
  console.log(`  ${ok(babelOk)} @babel/parser + @babel/traverse${babelOk ? '' : ' — run: npm install in the metrognome plugin root'}`);

  const ad = has('agent-device');
  const ard = has('agent-react-devtools');
  console.log(`  ${ad ? ok(true) : warn} agent-device ${ad ? '' : '— install: npm i -g agent-device (or use npx)'}`);
  console.log(`  ${ard ? ok(true) : warn} agent-react-devtools ${ard ? '' : '— install: npm i -g agent-react-devtools (or use npx)'}`);
  console.log(`  ${warn} metro-mcp — bundled via this plugin's .mcp.json (npx -y metro-mcp@latest); needs a LIVE Metro session to return data`);
  console.log(`  ${warn} react-native-best-practices — install the Callstack agent-skill from callstackincubator/agent-skills`);

  // ── Git state ─────────────────────────────────────────────────────────────
  const gitInsideWorkTree = sh('git rev-parse --is-inside-work-tree') === 'true';
  const gitHeadSha = gitInsideWorkTree ? sh('git rev-parse HEAD') : null;
  const gitSymbolicRef = (gitInsideWorkTree && gitHeadSha) ? sh('git symbolic-ref HEAD') : null;
  const gitPorcelain = (gitInsideWorkTree && gitHeadSha) ? (sh('git status --porcelain') || '') : '';
  const gitState = parseGitState({ insideWorkTree: gitInsideWorkTree, headSha: gitHeadSha, symbolicRef: gitSymbolicRef, porcelain: gitPorcelain });

  console.log('');
  if (gitState.state === 'no-repo') {
    console.log(`  ${ok(false)} git: not inside a git repo`);
    console.log(`        metrognome uses git as memory. Run: git init && git add -A && git commit -m 'init'`);
  } else if (gitState.state === 'no-commits') {
    console.log(`  ${ok(false)} git: no commits yet`);
    console.log(`        Make an initial commit first: git commit --allow-empty -m init`);
  } else if (gitState.state === 'detached') {
    console.log(`  ${ok(false)} git: detached HEAD`);
    console.log(`        You're on a detached HEAD. Checkout a branch first: git switch -c perf/metrognome`);
  } else {
    const branchStr = gitState.branch ? ` on ${gitState.branch}` : '';
    if (gitState.dirty.length === 0) {
      console.log(`  ${ok(true)} git tree clean${branchStr}`);
    } else {
      console.log(`  ${warn} ${gitState.dirty.length} pre-existing change(s)${branchStr} — metrognome will leave these untouched:`);
      for (const f of gitState.dirty) console.log(`      ${f}`);
    }
  }

  // ── RN project + arch + engine detection ─────────────────────────────────
  const pkgRaw = sh('cat package.json') || '';
  const hasPkgJson = fs.existsSync(path.join(repo, 'package.json'));
  const isRN = isRNProject({ pkgRaw, hasPkgJson });
  console.log(`  ${isRN ? ok(true) : warn} looks like a React Native / Expo app`);

  let parsedPkg = {};
  try { if (pkgRaw) parsedPkg = JSON.parse(pkgRaw); } catch {}

  let appJsonObj = {};
  const appJsonPath = path.join(repo, 'app.json');
  if (fs.existsSync(appJsonPath)) {
    try { appJsonObj = JSON.parse(fs.readFileSync(appJsonPath, 'utf8')); } catch {}
  }

  let appConfigText = '';
  const appConfigPaths = ['app.config.js', 'app.config.ts', 'app.config.mjs'].map(f => path.join(repo, f));
  for (const cp of appConfigPaths) {
    if (fs.existsSync(cp)) { appConfigText = fs.readFileSync(cp, 'utf8'); break; }
  }

  let gradleProps = '';
  const gradlePropsPath = path.join(repo, 'android', 'gradle.properties');
  if (fs.existsSync(gradlePropsPath)) {
    try { gradleProps = fs.readFileSync(gradlePropsPath, 'utf8'); } catch {}
  }

  const { newArch, rnVersion } = detectArch({ pkg: parsedPkg, appJson: appJsonObj, appConfigText });
  const archStr = newArch ? 'New Arch' : 'Old Arch';
  const rnStr = rnVersion ? ` (RN ${rnVersion})` : '';
  console.log(`  ${ok(true)} architecture: ${archStr}${rnStr}`);

  const { engine, source: engineSource } = detectEngine({ pkg: parsedPkg, appJson: appJsonObj, appConfigText, gradleProps });
  const engineLabel = engine === 'hermes' ? 'Hermes' : engine === 'jsc' ? 'JSC' : 'unknown';
  const engineSrc = engineSource !== 'default' ? ` (via ${engineSource})` : '';
  console.log(`  ${ok(engine === 'hermes')} engine: ${engineLabel}${engineSrc}`);
  if (engine === 'jsc') {
    console.log(`    ${warn} JSC engine: first-load and memory-leaks (CDP heap/CPU) require Hermes.`);
    console.log(`         bundle-size, listing, and re-renders still work with JSC.`);
  }

  // ── Entry-file inspection (detect harmful connect import if present) ───────
  // RN auto-connects to agent-react-devtools on port 8097 — no app code change needed.
  let connectPresent = false;
  let connectFile = null;
  let entryFile = null;
  const candidates = ['index.js', 'index.ts', 'index.tsx', 'App.js', 'App.ts', 'App.tsx'];
  try {
    if (parsedPkg?.main && !parsedPkg.main.startsWith('node_modules') && !parsedPkg.main.includes('expo-router')) {
      const mainPath = path.join(repo, parsedPkg.main);
      if (fs.existsSync(mainPath) && !candidates.includes(parsedPkg.main)) candidates.unshift(parsedPkg.main);
    }
  } catch {}
  for (const c of candidates) {
    const fp = path.join(repo, c);
    if (fs.existsSync(fp)) {
      entryFile = c;
      const content = fs.readFileSync(fp, 'utf8');
      if (content.includes('agent-react-devtools/connect')) {
        connectPresent = true;
        connectFile = c;
      }
      break;
    }
  }

  // ── Device enumeration ────────────────────────────────────────────────────
  let bootedSims = [];
  if (process.platform === 'darwin') {
    const simctlOut = sh('xcrun simctl list devices booted -j');
    bootedSims = parseSimctl(simctlOut);
  }

  let androidDevices = [];
  if (has('adb')) {
    const adbOut = sh('adb devices');
    androidDevices = parseAdbDevices(adbOut || '');
  }

  const totalDevices = bootedSims.length + androidDevices.length;
  console.log(`\n  Devices:`);
  if (bootedSims.length > 0) {
    for (const s of bootedSims) console.log(`  ${ok(true)} iOS Simulator: ${s.name}`);
  } else if (process.platform === 'darwin') {
    console.log(`  ${warn} No booted iOS Simulator — boot one: xcrun simctl boot <udid>  or open Xcode → Simulator`);
  }
  if (has('adb')) {
    const connectedAndroid = androidDevices.filter(d => d.state === 'device');
    if (connectedAndroid.length > 0) {
      for (const d of connectedAndroid) console.log(`  ${ok(true)} Android: ${d.serial}`);
    } else if (androidDevices.length > 0) {
      for (const d of androidDevices) console.log(`  ${warn} Android: ${d.serial} (${d.state})`);
    } else {
      console.log(`  ${warn} No Android devices connected (adb found none)`);
    }
  }
  if (totalDevices > 1) {
    console.log(`  ${warn} Multiple devices detected — metrognome targets the first booted/connected device`);
  }

  // ── Live session probe ────────────────────────────────────────────────────
  const port = metroPort();
  const metro = probeMetro(port);
  const devtools = probeDevtools();
  const { startCmd } = detectStartEnv();

  console.log(`\n  Live session:`);
  console.log(`  ${ok(metro.reachable)} Metro dev server on :${port}${metro.reachable ? ` (${metro.liveTargets} live Hermes target${metro.liveTargets !== 1 ? 's' : ''})` : ' — not reachable'}`);
  if (ard) {
    console.log(`  ${ok(devtools.running && devtools.connected > 0)} agent-react-devtools daemon — ${devtools.running ? `${devtools.connected} app${devtools.connected !== 1 ? 's' : ''} connected` : 'not running'}`);
  }
  if (!metro.reachable) {
    console.log(`  ${warn} Metro is not running. Start it with: ${startCmd}`);
    console.log(`       or run: node doctor.mjs --launch-metro  to open it in a new terminal`);
  } else if (metro.liveTargets === 0 || (devtools.running && devtools.connected === 0)) {
    console.log(`  ${warn} Metro is up but app session is dead (0 connected / 0 live Hermes targets).`);
    console.log(`       Relaunch the app: agent-device open <bundleId> --relaunch`);
    console.log(`       Then: agent-react-devtools wait --connected`);
    console.log(`       reload_app does NOT revive a dead session — only relaunching the app works.`);
  }

  // ── Setup actions ─────────────────────────────────────────────────────────
  const setupActions = [];
  if (connectPresent) {
    setupActions.push(
      `REMOVE 'agent-react-devtools/connect' import from ${connectFile}: this is a web-only export that crashes RN New Arch. RN auto-connects on port 8097 — no app code change needed.`
    );
  }
  if (newArch) {
    setupActions.push(`SET metro-mcp newArchitecture:true in metro-mcp config (New Arch detected${rnVersion ? ` — RN ${rnVersion}` : ''})`);
  }

  console.log('');
  if (setupActions.length === 0) {
    const state = connectFile
      ? `connect import absent from entry file (correct for RN — auto-connects on 8097)`
      : entryFile ? `entry file ${entryFile} looks clean` : 'no setup actions needed';
    console.log(`  ${ok(true)} setup actions: none — ${state}`);
  } else {
    console.log(`  Setup actions (agent will handle these automatically):`);
    for (const a of setupActions) console.log(`    • ${a}`);
  }

  // ── .metrognome/ workspace ────────────────────────────────────────────────
  const mgExists = fs.existsSync(path.join(repo, '.metrognome'));
  if (mgExists) {
    console.log(`  ${ok(true)} .metrognome/ workspace present`);
    const cfgExists = fs.existsSync(path.join(repo, '.metrognome', 'config.json'));
    if (!cfgExists) {
      const cfg = path.join(repo, '.metrognome', 'config.json');
      fs.writeFileSync(cfg, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
      console.log(`  ${ok(true)} .metrognome/config.json created with defaults`);
    } else {
      console.log(`  ${ok(true)} .metrognome/config.json present`);
    }
  } else if (doInit) { bootstrap(); }
  else console.log(`  ${warn} .metrognome/ not found — run: node doctor.mjs --init  (creates the per-repo memory, config.json, ledger)`);

  // ── --launch-metro + poll-until-ready ─────────────────────────────────────
  if (doLaunchMetro) {
    console.log(`\n  Launching Metro...`);
    launchMetro(startCmd);
    console.log(`  Polling until Metro is reachable (up to 30s)...`);
    const pollResult = pollMetro(port, 30000);
    if (pollResult.reachable) {
      console.log(`  ${ok(true)} Metro is up (${pollResult.liveTargets} live target${pollResult.liveTargets !== 1 ? 's' : ''})`);
    } else {
      console.log(`  ${warn} Metro did not become reachable within 30s — check the terminal for errors`);
    }
  }

  console.log(`\n  Platform note — displayed-frame FPS:`);
  console.log(`    iOS Simulator: NOT available (Apple constraint — Simulator renders on host Mac GPU).`);
  console.log(`    iOS real device: Instruments / XCTest hitch metrics.`);
  console.log(`    Android: Flashlight (bamlab/flashlight) via dumpsys gfxinfo — zero app instrumentation.`);
  console.log(`    For 'listing' on Simulator, gate on re-renders or longtask ms instead of FPS.\n`);
}

main();
