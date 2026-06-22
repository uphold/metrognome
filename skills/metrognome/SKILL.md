---
name: metrognome
description: Autonomous, scientific React Native & Expo performance optimization via a propose -> measure -> keep/revert loop. Use this WHENEVER an RN/Expo app is slow, laggy, janky, stuttering, freezing, or memory-hungry — slow cold start / TTI, dropped frames while scrolling a FlatList/SectionList/FlashList, rising RAM or a suspected memory leak, a bloated JS bundle, or wasted/excessive re-renders — even if the user never says "metrognome" or the word "performance". Also use it to build an interactive 3D Perf Map of an RN repo, profile a specific screen or component, or surface the worst perf offenders. It measures every change N times on a real device/simulator and keeps a fix only if the gain beats the measurement noise, committing each win with git-as-memory. Scope is React Native / Expo (Metro + Hermes) only — for web, Next.js, or Core Web Vitals work, use a web performance skill instead.
---

# metrognome

metrognome routes RN perf work through metro-mcp and Callstack's tools with a strict measurement discipline: propose one fix → measure N times → keep only if the gain beats the noise, else revert. Git is the memory; per-iteration commits enable auto-revert, and the final shape is configurable (per-iteration · one commit · leave staged). It's the RN twin of `webapp-perf-playbook`: delegate measurement, own the catalog + loop, never record an unmeasured fix.

## Scope & Delegation (don't reinvent measurement)

This skill owns the menu, loop, gate, Ledger, Memory, and Perf Map. **Measurement is delegated** to four tools (install/verify via Doctor):

| Need | Tool | How |
|---|---|---|
| Drive the app / simulate a user (open, scroll, tap, open↔close cycles) | **agent-device** (CLI) | `agent-device open|scroll|tap|snapshot|screenshot …` |
| Per-component re-render causes, slow renders, commit timeline | **agent-react-devtools** (CLI daemon) | `agent-react-devtools get tree | get component @c1 | profile slow` |
| Hermes CPU/heap, network, console/exceptions, JS exec, navigation | **metro-mcp** (bundled MCP) | call MCP tools directly — *preferred* for `first-load`; `listing`/`re-renders` run CDP-free if runtime channel is unavailable (see `references/tools.md`) |
| **JS-heap leak sampling** (`memory-leaks`) — cross-platform incl. iOS Simulator | **`scripts/heap_sample.mjs`** | `node heap_sample.mjs --cycles N` → CSV → `stats.mjs --direction lower --unit bytes` |
| Which fix to try (the hypothesis) | **react-native-best-practices** (Callstack agent-skill) | look up the guide mapped to the preset |

Profiling overlaps (CPU from both metro-mcp and agent-device); pick the best source. `references/tools.md` has the current command surface — **read it before invoking any tool** and update it when a tool's flags change.

**Platform note — one blind spot:** **Displayed-frame FPS** is unavailable on the iOS Simulator (Apple platform constraint — no frame-timing exposed). Every other signal (JS heap, re-renders, longtask jank, startup, CPU/memory) is fully measurable on Simulator. For FPS: use **Flashlight** on Android or **Instruments/XCTest** on a real iOS device.

## The menu

**Rule:** if AskUserQuestion is available, use it; otherwise print a numbered Markdown menu and wait.

Bare invocation → present the **top menu**:

1. **Autoresearch** — pick a preset, run the autonomous optimization loop.
2. **Perf Map 3D** — static repo scan → interactive 3D map → Top-3 fixes ready to paste into Autoresearch.
3. **Doctor** — verify/install tools, establish a live app session, scope git to its own changes, bootstrap `.metrognome/`.
4. **Configurations** — view/edit `.metrognome/config.json` (commit mode, live report, N, k, budget).

Choosing **Autoresearch** → present the five presets:
`first-load` · `listing` · `memory-leaks` · `bundle-size` · `re-renders`.

**Run options** (asked once, pre-filled from `.metrognome/config.json`; one keystroke to accept defaults):

- **Commit mode** — `Commit each kept fix` (default: `per-iteration`) / `One commit at the end` / `Don't commit (leave staged for review)`.
- **Live report** — `Off` (default) / `On — write a live HTML dashboard to .metrognome/report.html`.

(N, k, and budget are only edited via **Configurations**.)

**Skip the menu when intent is explicit.** Accept direct args and natural language:
- `metrognome listing --target FeedScreen` → run that preset on that target.
- "fix jank on the feed list" → map to `listing`, infer the target, confirm, run.
- "the app takes forever to open" → `first-load`. "it leaks memory on the chat screen" → `memory-leaks`.
When inferring a preset/target from prose, state your interpretation in one line and proceed.

Preset details (metric, drive, measure, guide, candidate fixes) are in **`references/presets.md`**. Read the matching entry before running.

## The optimization loop

Run this for an Autoresearch preset. A port of the web playbook's Measure→Diagnose→Apply→Re-measure→Keep/Revert, hardened with N-run variance control and git gating.

1. **Preflight.** Run `doctor.mjs` (or inline checks). Then:
   - **Bootstrap:** ensure `.metrognome/` exists (auto-create; never prompt).
   - **Scoped-tracking init:** `preExistingDirty` = paths from `git status --porcelain` before any change. Never staged or reverted by metrognome.
   - **Consolidated run-start prompt** (see below) — one AskUserQuestion with three groups: setup items, commit mode, live report. Wait for response, then proceed.
   - **Session bring-up (always, silently, before baseline):** verify git state via `parseGitState` (see *Git must be usable* — if not `usable`, print remediation and wait). Then: start Metro if needed; boot/attach simulator or device; **establish a live app session** (sub-protocol below); `agent-react-devtools start` + `wait --connected`; select the live Hermes target from `localhost:8081/json/list`; set `newArchitecture: true` if detected. Healthy session → proceed. Escalate only when blocked (see *When to ask*). **`bundle-size` is build-time — skip Metro/session bring-up.**
   - **Optional setup** (only when Doctor detected blockers): install missing CLIs or apply flagged setup actions (the Blockers group in the run-start prompt) — live-session bring-up is NOT conditional on the user's choice here.
   - **Setup commit** (if `commitMode != no-commit`): `git add <setup paths only — never preExistingDirty>` and commit as `chore(metrognome): setup workspace`. Record `baselineSha = git rev-parse HEAD` (after setup, so loop reverts never touch infra).
   - **Load memory and config:** read `.metrognome/perf-memory.md` for known hotspots; if `.metrognome/playbook.md` exists, read it for measured fix priors (proven wins + dead ends); load `.metrognome/config.json` (`commitMode`, `liveReport`, `runs`, `k`, `budget`).
2. **Baseline.** Run the preset's measurement **N times** (default N=5; discard one warmup). Compute **mean ± stddev** with `scripts/stats.mjs`. Open a Ledger entry (`assets/ledger.template.md` → `.metrognome/ledger/<timestamp>-<preset>.md`).
3. **Diagnose.** Consult the `react-native-best-practices` guide. Identify the **single dominant bottleneck** — **never stack fixes**.
4. **Propose + apply.** One atomic candidate fix from the preset's catalog.
5. **Re-measure.** Identical N-run protocol.
6. **Gate.** Decide with `scripts/stats.mjs` (see `references/measurement.md`):
   `keep ⇔ improvement > max(min_effect, k · pooled_stddev)` (k≈2; lower-is-better for TTI/jank/RAM/bytes/commits; higher-is-better for FPS).

   Before applying: snapshot each file to be changed → add to `touched`; for files in both `touched` and `preExistingDirty`, capture the *user's* current version.

   - **KEEP** (and `commitMode != no-commit`):
     - No overlap (`touched ∩ preExistingDirty == ∅`): `git add <touched paths>` then `git commit` with a message stating the measured delta (e.g. `perf(listing): getItemLayout on FeedScreen — jank 18→4 dropped frames (-78%, n=5)`). **Never `git add -A`.**
     - Overlap (`touched ∩ preExistingDirty != ∅`): `git stash push -- <overlap file>`, `git add <overlap file>` + commit, then `git stash pop`. Scoped to the single conflicting file.
     This per-iteration commit is the revert isolation mechanism.
   - **REVERT** → restore each `touched` file from its pre-fix snapshot. `preExistingDirty` state is intact.
   Record KEPT/REVERTED in the Ledger with **both distributions**. If `liveReport` is on, write `.metrognome/run-state.json` (see schema below) and call `node build_run_report.mjs run-state.json --out .metrognome/report.html`.
7. **Loop.** Next hypothesis until budget is exhausted or no fix clears the gate.
8. **End-of-run commit transform.** Apply the chosen `commitMode`:
   - `per-iteration` (default) — leave per-iteration commits as-is.
   - `one-commit` — `git reset --soft <baseline-sha>` then `git commit -m "perf(<preset>): <net-summary> (<n> iterations)"`.
   - `no-commit` — `git reset --soft <baseline-sha>`. Kept changes are **staged but uncommitted** for the user to review and commit.
9. **Report.** Summarize the Ledger and commits. Distill each kept/reverted result into **one line** in `.metrognome/perf-memory.md`.

**Discipline rules:**
- *One variable at a time.* Stacked fixes make the gate meaningless.
- *Never record an unmeasured fix.* A change with no before/after distribution is folklore.
- *Scoped tracking — metrognome commits/reverts only its own files.* `git add <touched paths>` (never `git add -A`); REVERT restores from pre-fix snapshots; `preExistingDirty` paths are never staged or reverted. `commitMode` shapes the *final* history — per-iteration commits are preserved until end of run.
- *Git must be usable before any mutation.* `parseGitState` must return `state: 'usable'` before `baselineSha = git rev-parse HEAD` (step 1), before any `git commit` (step 6), and before any `git reset --soft` (step 8). In `no-repo`, `no-commits`, or `detached` states, print the matching Doctor remediation and wait — never run git mutations.

## Locating scripts

Resolve the metrognome runner once at session start (works in every harness):

```bash
if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
  MG="node $CLAUDE_PLUGIN_ROOT/bin/metrognome.mjs"   # bundled Claude Code plugin (offline, zero latency)
else
  MG="npx -y metrognome@latest"                       # Codex · Cursor · Gemini · Copilot
fi
# Subcommands: scan · map · report · playbook · stats · doctor · heap
#   e.g.  $MG scan <repo> --out graph.json   |   $MG map graph.json --out perf-map.html --open
```

**Claude Code users:** `$CLAUDE_PLUGIN_ROOT` is always set inside a plugin session — `$MG` resolves to the bundled copy and runs offline with no network round-trip. Behavior is identical to before.

**Dependencies:** `perf_scan.mjs` requires `@babel/parser` and `@babel/traverse`. Inside a Claude Code session the SessionStart hook installs them automatically. For by-hand / CI use inside the plugin dir, run `npm install` in `${CLAUDE_PLUGIN_ROOT}` first. When using `npx`, deps are fetched automatically with the package.

## Perf Map 3D (the diagnose→fix bridge)

A static scan — no device needed. Steps:

```bash
# 1. scan the target RN repo -> graph.json (Babel AST + perf-debt scoring)
$MG scan <repo-or-src-path> --out graph.json

# 2. merge into a single standalone HTML (vendored 3d-force-graph + data inlined)
$MG map graph.json --out perf-map.html --open
```

Then: open `perf-map.html` (`--open` does it; otherwise `open perf-map.html`). Node **size = perf debt**, **color = severity** (red CRITICAL / orange HIGH / yellow MEDIUM / grey below-gate). Renders nodes with **debt ≥ 2** by default (live-adjustable via `min debt` control). A **search box** in the same panel jumps to any module by name; clicking a node shows the flaw, `file:line`, and the matching Callstack guide. **Present `top3` (from graph.json or printed) as ready-to-paste Autoresearch commands** — that closes the diagnose→fix loop.

The scoring, the ten detectors, and the **signal-vs-noise gating** (why most nodes stay grey) are in **`references/perf-map.md`**. Tuning constants live in `scripts/perf_scan.mjs`'s `CONFIG` block. If a scan lights up too much, raise the gate there.

## Doctor (auto-setup — zero homework)

Doctor detects what needs fixing; the agent **performs all setup automatically** and presents **one consolidated prompt** (see below).

**What Doctor detects:**
- **Tools present?** `metro-mcp` is bundled (this plugin's `.mcp.json`). CLIs are `npx`-invocable; install globally with `npm i -g agent-device agent-react-devtools` for speed. Callstack knowledge base: install `react-native-best-practices` agent-skill from `callstackincubator/agent-skills`.
- **Live app session** — probes Metro (`localhost:${port}/json/list`) and the agent-react-devtools daemon (`agent-react-devtools status`); see sub-protocol below. **RN auto-connects on port 8097 — no app code change needed. Never add `import 'agent-react-devtools/connect'`: it is web-only and crashes RN New Arch** (see `references/tools.md`).
- **New Arch** — detected from `app.json`/`app.config.*` `newArchEnabled` or RN ≥ 0.76 (ships New Arch by default). Sets metro-mcp `newArchitecture: true`.
- **Pre-existing dirty files** — listed informational; left untouched.
- **Bootstrap `.metrognome/`** on first run: create `perf-memory.md`, `config.json` (defaults), `ledger/`, `archive/`, `.gitignore` (excludes `report.html`/`run-state.json`). Memory + config + ledger are committed with the app.

**Establish a live app session (run after git-state check, before baseline):**

1. **Probe** — `get_connection_status` (metro-mcp) + `agent-react-devtools status`.
   - Metro reachable AND ≥1 live Hermes target AND ≥1 agent-react-devtools connected → session OK, proceed. **Never relaunch a healthy session.**
2. **Metro down** → run `doctor.mjs --launch-metro` (opens a terminal with the start command, best-effort on macOS); poll `/json/list` until Metro answers. If unavailable or fails, print the start command and ask the user to run it.
3. **Metro up but app dead** (`cdpConnected:false` or "0 connected") → recover programmatically:
   - Resolve bundle id via `agent-device apps` or metro-mcp `list_devices` (e.g. `com.metrognome.pulse`).
   - `agent-device open <bundleId> --relaunch` (terminates + relaunches on the booted simulator/device).
   - Re-probe: `agent-react-devtools wait --connected --timeout 30`.
   - **Note:** `reload_app` only refreshes a live JS bundle — it does NOT revive a dead session (3× no-op confirmed). Only `--relaunch` or a manual app open revives it.
4. **Auto-recovery unavailable or still dead** (agent-device absent, no booted simulator, headless device) → print **numbered, copy-pasteable** manual steps and wait:
   > 1. Make sure your simulator/device is booted and your app is installed.
   > 2. **Open/foreground the app now** — it must be running in the foreground for a live JS debug session.
   > 3. (Physical Android) Run: `adb reverse tcp:8097 tcp:8097`
   >
   > Then re-check (`agent-react-devtools wait --connected`).

**Environment bring-up (agent does silently):**
- Metro not running → `doctor.mjs --launch-metro` or start backgrounded (`npx expo start` / `npm start`).
- No simulator/device → boot an available one and `agent-device open` the app.

**Agent only asks when it cannot proceed:**
- No simulator/device exists and creating one requires interactive setup (no Xcode/Android SDK, no AVD).
- App isn't built/installed and the build requires input the agent lacks (signing credentials, interactive native build prompt).
- A user-owned RN DevTools/Fusebox browser holds the single CDP slot **and** the preset needs metro-mcp's runtime channel (`first-load`, `memory-leaks`). The agent cannot close a browser tab.

**CDP — do NOT open the JS Debugger:** The Hermes target appears on `localhost:8081/json/list` automatically — no action needed. Opening RN DevTools / Fusebox (Cmd+D → "Open JS Debugger") holds the **single CDP slot** (RN < 0.85) and blocks metro-mcp runtime calls. Never instruct the user to open the debugger. `listing` and `re-renders` are CDP-free. See `references/tools.md`.

**On Expo / New Arch:** `newArchitecture: true` is auto-detected (see above). `listing` and `re-renders` degrade gracefully to the CDP-free path — see `references/tools.md`. (connect-import and CDP rules: see Live app session bullet above.)

**On JSC engine:** `first-load` and `memory-leaks` (need Hermes CDP) are unavailable. Route to `bundle-size`, `listing`, or `re-renders`; or use `agent-device` perf samples for device-level timing.

**On multiple devices:** metrognome targets the first booted/connected one. When the target bundle id is resolvable, confirm the app in foreground matches before starting baseline (wrong app = wrong baseline).

**On not-an-RN-project:** if the repo doesn't look like an RN/Expo app, confirm the target directory before proceeding.

## Consolidated run-start prompt

Present **one** AskUserQuestion (or compact numbered menu), with up to three groups. Pre-fill from `.metrognome/config.json`:

| Group | Question | Options |
|---|---|---|
| **Blockers** *(only when optional setup items were detected — missing CLIs, metro-mcp config changes)* | "Fix the optional setup items?" | Yes, fix & proceed (default) · Skip — I'll handle them · Show me what will change |
| **Commit mode** | "Commit shape?" | Commit each kept fix — `per-iteration` (default) · One commit at the end · Don't commit — leave staged |
| **Live report** | "Live HTML dashboard?" | Off (default) · On — write `.metrognome/report.html` |

After the response: apply any optional fixes chosen. Live-session bring-up runs regardless of this response — proceed to Baseline. Never spread these questions across multiple prompts.

## Performance Memory

metrognome builds a terse per-repo log of every perf gap it encounters — even outside an explicit run — and routes future work from those priors.

- **Read** `.metrognome/perf-memory.md` at the start of any run and any perf-related work in a `.metrognome/`-tracked repo: known hotspots, what was tried, what worked/reverted. Priors layered over the Callstack guides → faster, sharper routing.
- **Append** one terse line whenever a gap is discovered (Perf Map, autoresearch, or ad-hoc work) or a fix is validated/reverted.
- **Compact** when it grows: merge duplicates, move resolved entries to `.metrognome/archive/`.

Format and rules are in **`references/memory.md`**. The `UserPromptSubmit` hook reminds you; this skill does the work.

## Configurations (menu item 4)

Display `.metrognome/config.json`, let the user edit, then write back. If absent, bootstrap with defaults.

Config keys:

| Key | Default | Options |
|---|---|---|
| `commitMode` | `per-iteration` | `per-iteration` · `one-commit` · `no-commit` |
| `liveReport` | `false` | `true` · `false` |
| `openReport` | `true` | `true` · `false` (only relevant when `liveReport` is `true`) |
| `runs` | `5` | integer ≥ 2 |
| `warmupDiscard` | `1` | integer ≥ 0 |
| `k` | `2` | float ≥ 1 |
| `budget` | `6` | integer ≥ 0 (0 = run until no fix clears the gate) |

## run-state.json schema

```json
{
  "preset": "listing", "target": "FeedScreen", "status": "running",
  "startedAt": "2026-06-02T18:00:00Z", "unit": "ms", "direction": "lower",
  "baseline": { "mean": 1190, "std": 12, "runs": 4 },
  "iterations": [
    { "n": 1, "hypothesis": "getItemLayout", "guide": "js/optimizing-flatlist",
      "change": "Added getItemLayout to FeedScreen FlatList",
      "candidate": { "mean": 985, "std": 9, "runs": 4 },
      "decision": "KEEP", "delta": "-205ms (-17%)", "noiseBand": 24, "commit": "abc1234" }
  ],
  "netDelta": "-205ms (-17%)", "commits": ["abc1234"]
}
```

Rebuild after each iteration: `$MG report .metrognome/run-state.json --out .metrognome/report.html`.
If `openReport` is `true`, open `report.html` once at run start (auto-refreshes every 3 seconds).

## Ledger vs Memory

- **Experiment Ledger** — per-run, verbose, reproducible. `.metrognome/ledger/<timestamp>-<preset>.md`. Template: `assets/ledger.template.md`.
- **Performance Memory** — cumulative, terse, long-term. `.metrognome/perf-memory.md`. Each run distills into one line.

## Reference index

- `references/presets.md` — the 5 presets: trigger, drive, measure, guide, candidate fixes.
- `references/tools.md` — agent-device / agent-react-devtools / metro-mcp cheatsheets + routing. **Read before invoking a tool.**
- `references/measurement.md` — N-run protocol, gate math, why single samples lie.
- `references/perf-map.md` — detectors, scoring, signal-vs-noise gating, Top-3 format.
- `references/memory.md` — Memory entry format, read/append/compaction policy.
- `.metrognome/config.json` — per-repo settings. Edited via **Configurations** menu.
- `assets/report.template.html` + `scripts/build_run_report.mjs` — live progress dashboard (when `liveReport` is on).
- `.metrognome/run-state.json` — written after each iteration (gitignored); drives the live report.
- `scripts/build_playbook.mjs` — reads ledger files, emits `.metrognome/playbook.md` + `playbook.json`.
- `.metrognome/playbook.md` — proven wins and dead ends distilled from past runs; read at loop start.
