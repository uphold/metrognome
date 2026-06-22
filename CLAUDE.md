# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

metrognome is a **Claude Code plugin** for React Native performance optimization. This repo IS the plugin itself — not an RN app that uses it. The plugin, once installed, adds a `/metrognome` command to any RN project and orchestrates metro-mcp and Callstack's tooling (agent-device, agent-react-devtools, react-native-best-practices) into a scientific propose→measure→keep/revert loop.

## Commands

```bash
# Static perf scan of a RN repo → graph.json
npm run scan -- <path-to-rn-app> [--out graph.json]

# Build standalone perf-map HTML from graph.json
npm run map -- graph.json [--out perf-map.html] [--open]

# Build live run-report HTML from run-state.json (pitch demo: use the sample)
npm run report -- skills/metrognome/assets/run-state.sample.json --out /tmp/report.html --open

# Verify the gate math (self-test with known inputs)
npm run stats:test

# Distil .metrognome/ledger/*.md into playbook.md + playbook.json
npm run playbook -- <ledger-dir>

# Doctor parser self-test
npm run doctor:test

# Offline smoke chain: perf_scan → build_perf_map → build_run_report
npm run smoke

# All self-tests (stats + doctor + playbook)
npm test
```

Direct node invocations (useful when iterating on a specific script):

```bash
node skills/metrognome/scripts/perf_scan.mjs <repo-or-src-path> --out graph.json
node skills/metrognome/scripts/build_perf_map.mjs graph.json --out perf-map.html --open
node skills/metrognome/scripts/build_run_report.mjs <run-state.json> --out report.html --open
node skills/metrognome/scripts/stats.mjs --baseline "1200,1180" --candidate "980,990" --min-effect 30 --k 2 --direction lower --unit ms
node skills/metrognome/scripts/stats.mjs --self-test
node skills/metrognome/scripts/doctor.mjs
```

Node ≥ 18 required (ESM throughout).

## Repo layout & architecture

```
.claude-plugin/      plugin.json + marketplace.json → self-installable via /plugin
.mcp.json            bundles metro-mcp (npx -y metro-mcp@latest) as an MCP server
commands/            /metrognome slash-command entrypoint (metrognome.md)
hooks/               SessionStart (npm install) + UserPromptSubmit (perf-memory nudge)
skills/metrognome/
  SKILL.md           the orchestrator — menu (4 items), run-options, loop, gate, config, ledger, memory
  references/        readonly reference docs read by SKILL.md at runtime:
    presets.md       the 5 presets (first-load · listing · memory-leaks · bundle-size · re-renders)
    tools.md         ⚑ tool command surfaces (agent-device / agent-react-devtools / metro-mcp cheatsheet)
    measurement.md   N-run protocol + gate math explained
    perf-map.md      Perf Map detectors, scoring, signal-vs-noise design
    memory.md        Performance Memory format + read/write/compaction rules
  scripts/           standalone Node CLIs:
    perf_scan.mjs    Babel AST walker + 10 anti-pattern detectors → graph.json
    build_perf_map.mjs  merges graph.json + vendored 3d-force-graph → standalone HTML
    build_run_report.mjs  merges run-state.json + report template → live HTML dashboard
    stats.mjs        gate math (mean, stddev, pooledStd, KEEP/REVERT decision)
    doctor.mjs       preflight checker + .metrognome/ bootstrapper (incl. config.json)
    heap_sample.mjs  JS-heap leak sampling across open↔close cycles (needs a live app)
    build_playbook.mjs  distils ledger runs → playbook.md + playbook.json (proven wins / dead ends)
  assets/            vendored 3d-force-graph (offline, MIT), HTML templates, ledger template,
                     run-state.sample.json (pitch demo — use with npm run report)
templates/ci/        CI Autopilot workflow templates (device-free + device) for target repos
.github/workflows/   ci.yml (offline chain + plugin validate) · pages.yml (live demo build+deploy)
docs/                banner.svg/png, logo*.png/svg, perf-map.png, diagrams/ (loop · orchestration · gate · signal-vs-noise)
docs/pages/          index.html — landing page for the GitHub Pages live demo
examples/            sample-rn-app with seeded anti-patterns (fixture only — see below)
```

## Critical architectural rules

**Signal-vs-noise is the core design invariant of the Perf Map.** RN static heuristics fire constantly in healthy code. Four mechanisms in `perf_scan.mjs` prevent noise dominating:
1. Severity weights (CRITICAL 10 · HIGH 5 · MEDIUM 1.5 · LOW 0.4)
2. Diminishing returns past `diminishAfter` (3) hits of the same detector per file
3. Log-scale centrality amplification — structural debt only, not LOW findings
4. Combined gate: hotspot iff `debt ≥ hotspotDebt (6)` **or** any HIGH/CRITICAL finding

All tuning knobs are in `perf_scan.mjs`'s `CONFIG` block. **Never tune against `examples/sample-rn-app`** — the fixture is circular (it contains exactly what the detectors hunt). Tune against a real OSS RN app. Scoring and calibration details are in `skills/metrognome/references/perf-map.md`.

**`references/tools.md` is the single source of truth for tool command surfaces.** When agent-device, agent-react-devtools, or metro-mcp version-bumps, update there. SKILL.md says "read references/tools.md before invoking any tool."

**`stats.mjs` is the gate arbiter.** Every KEEP/REVERT decision flows through it. The formula: `improvement > max(minEffect, k·pooledStdDev)`. Changes that don't clear both the absolute floor and the statistical noise band are reverted. The self-test (`--self-test`) covers edge cases including single-sample degradation.

**Import alias resolution matters.** `perf_scan.mjs` reads `tsconfig.json`/`jsconfig.json` `compilerOptions.paths` to resolve path aliases (`@/`, `#/`). Without this, fan-in (centrality) is meaningless — on bluesky, alias resolution took the graph from 814 edges to 8862. If `aliases (none found)` prints and the graph looks sparse, check for a babel `module-resolver` alias not mirrored in tsconfig.

## Plugin runtime context

When installed as a plugin, the plugin root is `${CLAUDE_PLUGIN_ROOT}`. Scripts are resolved as:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/metrognome/scripts/perf_scan.mjs" …
```

If `$CLAUDE_PLUGIN_ROOT` is unset, the skill uses this fallback to locate itself:

```bash
MG="$(dirname "$(dirname "$(find "$HOME/.claude/plugins" -path '*metrognome*/scripts/perf_scan.mjs' | head -1)")")"
```

## What the plugin does in a target RN repo

When Doctor runs in a user's RN project it bootstraps:
- `.metrognome/perf-memory.md` — per-repo performance brain (one line per gap, committed with the app)
- `.metrognome/config.json` — run settings (commitMode, liveReport, openReport, runs, warmupDiscard, k, budget); defaults written on first bootstrap, editable via **menu item 4 · Configurations**
- `.metrognome/ledger/` — verbose per-run experiment logs
- `.metrognome/playbook.md` — distilled cross-run wins/dead-ends (generated by `build_playbook.mjs`, read at loop start)
- `.metrognome/archive/` — compacted old memory entries
- `.metrognome/.gitignore` — excludes `report.html` and `run-state.json` (generated artifacts)

The `commitMode` config key controls the final commit shape after a run:
- `per-iteration` (default) — keeps one commit per KEEP iteration, as today
- `one-commit` — `git reset --soft <baseline-sha>` + one summary commit at end of run
- `no-commit` — `git reset --soft <baseline-sha>`, leaving changes staged for the user to review

The live report (`liveReport: true`) writes `.metrognome/report.html` after each iteration via `build_run_report.mjs`. The report auto-refreshes every 3s and shows baseline, each iteration (KEEP/REVERT badge, delta vs noise band), and the net improvement. The sample run-state (`assets/run-state.sample.json`) renders a complete offline demo: `npm run report -- skills/metrognome/assets/run-state.sample.json --open`.

`hooks/hooks.json` has two hooks: a `SessionStart` that auto-installs npm deps on first load, and a `UserPromptSubmit` that fires when a perf-related prompt lands in a `.metrognome/`-tracked repo to remind you to consult/update `perf-memory.md`.
