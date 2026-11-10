#!/usr/bin/env node
/**
 * doctor.mjs — metrognome preflight + first-run setup.
 *
 * Run from the TARGET RN repo. Auto-bootstraps the .metrognome/ workspace,
 * probes Metro dev server live status, detects git state, JS engine (Hermes/JSC),
 * architecture, connected devices, and whether React profiling presets can run.
 *
 * Usage:
 *   node doctor.mjs            # report checklist
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
 * @param {{pkg?:object, appJson?:object, appConfigText?:string, gradleProps?:string, podfileProps?:object}} opts
 * @returns {{ engine:'hermes'|'jsc'|'unknown', source:string }}
 */
export function detectEngine({ pkg = {}, appJson = {}, appConfigText = '', gradleProps = '', podfileProps = {} }) {
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

  // ios/Podfile.properties.json (Expo prebuild) — flat dotted keys
  if (podfileProps?.['expo.jsEngine'] === 'jsc') return { engine: 'jsc', source: 'podfileProps' };

  return { engine: 'hermes', source: 'default' };
}

/**
 * Can `re-renders` / `listing` run? They profile through `agent-device react-devtools`
 * (Metro debugger channel: dev build, RN >= 0.74, Hermes, agent-device >= 0.21.29).
 * Unknown RN version is allowed (same stance as the Hermes default).
 * @returns {string|null} one-line reason when unavailable, null when OK
 */
export function profilingGate({ rnVersion, engine, agentDevice }) {
  const atLeast = (v, min) => v.localeCompare(min, undefined, { numeric: true }) >= 0;
  if (engine === 'jsc') return 'needs Hermes (JSC detected)';
  if (rnVersion && !atLeast(rnVersion, '0.74')) return `needs RN >= 0.74 (found ${rnVersion})`;
  if (!agentDevice || !atLeast(agentDevice, '0.21.29')) return `needs agent-device >= 0.21.29 (found ${agentDevice || 'none'})`;
  return null;
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
function run(cmd, args) {
  // Bounded: a stalled registry or auth prompt must not freeze Doctor (output is hidden).
  try { execFileSync(cmd, args, { stdio: 'ignore', timeout: 120000 }); return true; } catch { return false; }
}

// Callstack's react-native-best-practices skill ships inside this bundle (since callstackincubator/agent-skills#76).
const RNBP_PLUGIN = 'building-react-native-apps@callstack-agent-skills';
const RNBP_LEGACY = 'react-native-best-practices@callstack-agent-skills';
const RNBP_INSTALL_ARGS = ['plugin', 'install', 'building-react-native-apps', '--marketplace', 'callstackincubator/agent-skills']; // bare name: the CLI rejects @marketplace + --marketplace
const RNBP_INSTALL = `claude ${RNBP_INSTALL_ARGS.join(' ')}`;

/** Pure: pick the enabled bundle (for this project) out of `claude plugin list --json`. */
export function findRnbp(plugins = []) {
  const entry = plugins.find((p) => p.id === RNBP_PLUGIN && p.enabled);
  const guides = entry && path.join(entry.installPath, 'skills', 'react-native-best-practices', 'references');
  return {
    guides: guides && fs.existsSync(guides) ? guides : null, // partial install / moved layout ≠ OK
    legacy: plugins.some((p) => p.id === RNBP_LEGACY),
  };
}

/** Ensure the Callstack bundle is installed + enabled; returns its guides dir and a status note. */
function ensureRnbp() {
  const list = () => { try { return JSON.parse(execFileSync('claude', ['plugin', 'list', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; } };
  const before = list();
  if (!before) return { guides: null, note: ` — claude CLI not found; run: ${RNBP_INSTALL}` };
  let found = findRnbp(before);
  let installed = false;
  if (!found.guides && autoInstall) {
    installed = run('claude', [...RNBP_INSTALL_ARGS, '--scope', 'user'])
      || run('claude', ['plugin', 'enable', RNBP_PLUGIN]);
    found = findRnbp(list() || []);
  }
  const legacy = found.legacy ? ` (stale ${RNBP_LEGACY} entry — remove: claude plugin uninstall ${RNBP_LEGACY})` : '';
  if (!found.guides) return { guides: null, note: ` — ${autoInstall ? 'auto-install failed' : 'missing'}; run: ${RNBP_INSTALL}${legacy}` };
  return { guides: found.guides, note: `${installed ? ' — just installed; its skill loads next session (read guides from the path below now)' : ''}${legacy}` };
}

function sh(cmd) {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; }
}

/**
 * Block the current thread for `ms` milliseconds without shelling out.
 *
 * `Atomics.wait` on a `SharedArrayBuffer` is the standard cross-platform synchronous sleep: it
 * blocks the calling thread on the main loop and needs no child process, so it works identically
 * on Windows, macOS and Linux.
 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Some hardened runtimes disallow `Atomics.wait` on the main thread; fall back to a short
    // busy yield rather than failing the probe outright.
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin */ }
  }
}

// ── Module-level state (safe to evaluate before --self-test short-circuits) ───

const repo = process.cwd();
const doInit = process.argv.includes('--init');
// CI runners (CI Autopilot): detect only — never install globals or plugins onto the runner.
const autoInstall = !process.env.CI;
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
      // Wait in-process rather than shelling out to POSIX `sleep`, which does not exist on
      // Windows and whose failure was previously swallowed, causing the probe to run again
      // immediately against a Metro server that had not finished starting.
      sleepSync(2000);
    }
  }
  return last;
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

const SCREEN_MAP_HEADER = (name) => `# Screen Map — ${name}

> metrognome's navigation brain: how to launch, authenticate, and reach each screen.
> Secrets are referenced by $NAME from .metrognome/secrets.local.json (gitignored) — never inline them.
> Identifiers are stable accessibility labels / testIDs / visible text, NOT ephemeral @e3 refs
> (those are resolved live from an agent-device snapshot at run time). Commit this file with the app.
> Record only superficial, state-independent navigation — no error states or account-dependent results.

## App
bundleId: <fill in — e.g. com.example.staging>
launch: agent-device open <bundleId> --relaunch

## Auth
env: <fill in — e.g. staging>
steps:
  - fill  "Email" $MG_EMAIL          <!-- verbs: press id="x" (preferred) · press "X" · press visual "…" + hint · fill "X" $V · keys $V -->
  - fill  "Password" $MG_PW
  - press "Sign in"
lands: <fill in — e.g. Home>

## Conventions       <!-- app-wide quirks (controls missing from AX, shared testIDs, never-drive areas) -->
<!-- entries below, learned as metrognome navigates -->

## Routes            <!-- screen · from <anchor>: <step> → <step> · verified <date> -->
<!-- entries below, learned as metrognome navigates -->

## Screens           <!-- one block per screen: identify · elements · do · result · nuances · verified <date> -->
<!-- written live as metrognome drives each screen — see references/navigation.md -->
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
audit/
secrets.local.json
`;

// Backfills missing lines into an existing .metrognome/.gitignore (repos bootstrapped before
// audit/ or secrets.local.json existed); creates it fresh if missing entirely.
function patchGitignore(giPath) {
  if (!fs.existsSync(giPath)) {
    fs.writeFileSync(giPath, GITIGNORE_CONTENT);
    return;
  }
  let cur = fs.readFileSync(giPath, 'utf8');
  if (!/^audit\/$/m.test(cur)) { fs.appendFileSync(giPath, cur.endsWith('\n') ? 'audit/\n' : '\naudit/\n'); cur += 'audit/\n'; }
  if (!/^secrets\.local\.json$/m.test(cur)) fs.appendFileSync(giPath, cur.endsWith('\n') ? 'secrets.local.json\n' : '\nsecrets.local.json\n');
}

function bootstrap() {
  const dir = path.join(repo, '.metrognome');
  fs.mkdirSync(path.join(dir, 'ledger'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'audit'), { recursive: true });

  const mem = path.join(dir, 'perf-memory.md');
  if (!fs.existsSync(mem)) fs.writeFileSync(mem, PERF_MEMORY_HEADER(path.basename(repo)));

  const screenMap = path.join(dir, 'screen-map.md');
  if (!fs.existsSync(screenMap)) fs.writeFileSync(screenMap, SCREEN_MAP_HEADER(path.basename(repo)));

  const cfg = path.join(dir, 'config.json');
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');

  // gitignore before secrets.local.json — never briefly ungitignored on disk
  patchGitignore(path.join(dir, '.gitignore'));

  const secrets = path.join(dir, 'secrets.local.json');
  if (!fs.existsSync(secrets)) fs.writeFileSync(secrets, '{}\n');

  console.log(`  bootstrapped ${path.relative(repo, dir) || '.metrognome'}/ (perf-memory.md, screen-map.md, config.json, ledger/, archive/, audit/)`);
  console.log(`  .metrognome/.gitignore created — report.html, run-state.json, audit/, and secrets.local.json are gitignored`);
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
    check('Podfile.properties expo.jsEngine jsc → jsc', detectEngine({ podfileProps: { 'expo.jsEngine': 'jsc' } }).engine, 'jsc');
    check('Podfile.properties hermes → hermes', detectEngine({ podfileProps: { 'expo.jsEngine': 'hermes' } }).engine, 'hermes');
  }

  // profilingGate — re-renders / listing availability
  {
    const base = { rnVersion: '0.74', engine: 'hermes', agentDevice: '0.21.29' };
    check('gate: minimums → available', profilingGate(base), null);
    check('gate: jsc → unavailable', profilingGate({ ...base, engine: 'jsc' }), 'needs Hermes (JSC detected)');
    check('gate: rn 0.73 → unavailable', profilingGate({ ...base, rnVersion: '0.73' }), 'needs RN >= 0.74 (found 0.73)');
    check('gate: rn 0.100 → available', profilingGate({ ...base, rnVersion: '0.100' }), null);
    check('gate: rn unknown → available', profilingGate({ ...base, rnVersion: null }), null);
    check('gate: agent-device 0.21.28 → unavailable', profilingGate({ ...base, agentDevice: '0.21.28' }), 'needs agent-device >= 0.21.29 (found 0.21.28)');
    check('gate: agent-device 0.21.4 → unavailable (numeric compare)', profilingGate({ ...base, agentDevice: '0.21.4' }) !== null, true);
    check('gate: agent-device 0.21.100 → available', profilingGate({ ...base, agentDevice: '0.21.100' }), null);
    check('gate: agent-device 1.0.0 → available', profilingGate({ ...base, agentDevice: '1.0.0' }), null);
    check('gate: agent-device canary → available', profilingGate({ ...base, agentDevice: '0.21.36-canary.1' }), null);
    check('gate: agent-device missing → unavailable', profilingGate({ ...base, agentDevice: null }), 'needs agent-device >= 0.21.29 (found none)');
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

  // GITIGNORE_CONTENT — secrets.local.json must never be committed
  check('gitignore includes secrets.local.json', GITIGNORE_CONTENT.includes('secrets.local.json'), true);

  // patchGitignore — against a stale pre-existing .gitignore
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-doctor-test-'));
    const giPath = path.join(tmpDir, '.gitignore');
    fs.writeFileSync(giPath, 'report.html\nrun-state.json\n');
    patchGitignore(giPath);
    const patched = fs.readFileSync(giPath, 'utf8');
    check('patchGitignore appends audit/', /^audit\/$/m.test(patched), true);
    check('patchGitignore appends secrets.local.json', /^secrets\.local\.json$/m.test(patched), true);
    check('patchGitignore preserves existing lines', patched.includes('report.html'), true);

    // idempotent — no duplicate lines on a second run
    patchGitignore(giPath);
    const rePatched = fs.readFileSync(giPath, 'utf8');
    check('patchGitignore is idempotent', (rePatched.match(/^secrets\.local\.json$/gm) || []).length, 1);

    // missing file → created from scratch
    const freshGi = path.join(tmpDir, 'fresh.gitignore');
    patchGitignore(freshGi);
    check('patchGitignore creates missing file', fs.readFileSync(freshGi, 'utf8'), GITIGNORE_CONTENT);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // findRnbp — Callstack bundle detection from `claude plugin list --json`
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-rnbp-'));
    const guides = path.join(root, 'skills', 'react-native-best-practices', 'references');
    fs.mkdirSync(guides, { recursive: true });
    const p = (id, enabled, installPath = root) => ({ id, enabled, installPath });
    check('rnbp: none → no guides', findRnbp([]).guides, null);
    check('rnbp: disabled → no guides', findRnbp([p(RNBP_PLUGIN, false)]).guides, null);
    check('rnbp: enabled → guides dir', findRnbp([p(RNBP_PLUGIN, true)]).guides, guides);
    check('rnbp: enabled but guides dir missing → no guides', findRnbp([p(RNBP_PLUGIN, true, path.join(root, 'nope'))]).guides, null);
    check('rnbp: legacy alone → no guides', findRnbp([p(RNBP_LEGACY, true)]).guides, null);
    check('rnbp: legacy flagged', findRnbp([p(RNBP_LEGACY, false)]).legacy, true);
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();

  console.log(`\nmetrognome doctor — ${repo}\n`);

  // Node + babel deps
  const node = process.versions.node;
  const nodeOk = parseInt(node, 10) >= 22;
  console.log(`  ${ok(nodeOk)} node ${node} (>=22 required)`);

  const requireLocal = createRequire(import.meta.url);
  let babelOk = true;
  try { requireLocal('@babel/parser'); requireLocal('@babel/traverse'); } catch { babelOk = false; }
  console.log(`  ${ok(babelOk)} @babel/parser + @babel/traverse${babelOk ? '' : ' — run: npm install in the metrognome plugin root'}`);

  // Toolchain — install whatever is missing so a new user has zero homework.
  // First install lives here; hooks/update-clis.sh only bumps already-installed CLIs to @latest.
  const cli = 'agent-device';
  const present = has(cli) || (autoInstall && run('npm', ['i', '-g', cli]) && has(cli));
  console.log(`  ${present ? ok(true) : warn} ${cli}${present ? '' : ` — ${autoInstall ? 'auto-install failed' : 'missing'}; run: npm i -g ${cli} (or use npx)`}`);
  let agentDevice = null;
  try { agentDevice = execFileSync(cli, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString().match(/\d+\.\d+\.\d+\S*/)?.[0] ?? null; } catch {}
  const rnbp = ensureRnbp();
  console.log(`  ${rnbp.guides ? ok(true) : warn} ${RNBP_PLUGIN} (react-native-best-practices)${rnbp.note}`);
  if (rnbp.guides) console.log(`        guides: ${rnbp.guides}`);

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

  let podfileProps = {};
  try { podfileProps = JSON.parse(fs.readFileSync(path.join(repo, 'ios', 'Podfile.properties.json'), 'utf8')); } catch {}

  const { engine, source: engineSource } = detectEngine({ pkg: parsedPkg, appJson: appJsonObj, appConfigText, gradleProps, podfileProps });
  const engineLabel = engine === 'hermes' ? 'Hermes' : engine === 'jsc' ? 'JSC' : 'unknown';
  const engineSrc = engineSource !== 'default' ? ` (via ${engineSource})` : '';
  console.log(`  ${ok(engine === 'hermes')} engine: ${engineLabel}${engineSrc}`);
  if (engine === 'jsc') {
    console.log(`    ${warn} JSC engine: first-load, memory-leaks, listing, and re-renders require Hermes.`);
    console.log(`         bundle-size still works with JSC.`);
  }
  const profilingBlocked = profilingGate({ rnVersion, engine, agentDevice });
  console.log(`  ${ok(!profilingBlocked)} re-renders / listing (agent-device react-devtools)${profilingBlocked ? ` — unavailable: ${profilingBlocked}; other presets still run` : ''}`);

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
  const { startCmd } = detectStartEnv();

  console.log(`\n  Live session:`);
  console.log(`  ${ok(metro.reachable)} Metro dev server on :${port}${metro.reachable ? ` (${metro.liveTargets} live Hermes target${metro.liveTargets !== 1 ? 's' : ''})` : ' — not reachable'}`);
  if (!metro.reachable) {
    console.log(`  ${warn} Metro is not running. Start it with: ${startCmd}`);
    console.log(`       or run: node doctor.mjs --launch-metro  to open it in a new terminal`);
  } else if (metro.liveTargets === 0) {
    console.log(`  ${warn} Metro is up but app session is dead (0 live Hermes targets).`);
    console.log(`       Relaunch the app: agent-device open <bundleId> --relaunch`);
    console.log(`       A Metro reload does NOT revive a dead session — only relaunching the app works.`);
  }

  console.log('');
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
    const auditDir = path.join(repo, '.metrognome', 'audit');
    if (!fs.existsSync(auditDir)) {
      fs.mkdirSync(auditDir, { recursive: true });
      console.log(`  ${ok(true)} .metrognome/audit/ created`);
    }
    // backfill screen-map.md + secrets.local.json for repos bootstrapped before these existed
    const screenMap = path.join(repo, '.metrognome', 'screen-map.md');
    if (!fs.existsSync(screenMap)) {
      fs.writeFileSync(screenMap, SCREEN_MAP_HEADER(path.basename(repo)));
      console.log(`  ${ok(true)} .metrognome/screen-map.md created`);
    }
    // gitignore before secrets.local.json — never briefly ungitignored on disk
    patchGitignore(path.join(repo, '.metrognome', '.gitignore'));
    const secrets = path.join(repo, '.metrognome', 'secrets.local.json');
    if (!fs.existsSync(secrets)) {
      fs.writeFileSync(secrets, '{}\n');
      console.log(`  ${ok(true)} .metrognome/secrets.local.json created`);
    }
  } else if (doInit) { bootstrap(); }
  else console.log(`  ${warn} .metrognome/ not found — run: node doctor.mjs --init  (creates the per-repo memory, screen-map.md, config.json, ledger, audit/)`);

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
  console.log(`    For 'listing' on Simulator, gate on commit count (react-devtools profile stop) or longtask ms instead of FPS.\n`);
}

main().catch((e) => { console.error(`\n  doctor failed: ${e.message}`); process.exit(1); });
