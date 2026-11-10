# Tools & Signal Routing

metrognome delegates all measurement to Callstack's agent-device and react-native-best-practices. **Cheatsheet + routing table.** When command surfaces don't match, the installed CLI help is the source of truth (`agent-device help workflow`, `agent-device react-devtools --help`, `agent-device help cdp`). **Update this file before a pitch or when a tool version bumps.** (Verified: agent-device 0.21.36.)

## Preconditions & recovery

| Condition | Check | Symptom if broken | Remediation |
|---|---|---|---|
| **Metro running** | `curl -s localhost:8081/json/list` returns JSON | `probeMetro` → `reachable:false` | `node doctor.mjs --launch-metro` or run the detected start command manually |
| **≥1 Hermes target** | `/json/list` has entries with `id !== '-1'` | `liveTargets: 0` even with Metro up | Relaunch app: `agent-device open <bundleId> --relaunch` |
| **Git usable** | `parseGitState` returns `state: 'usable'` | Commits/reverts throw | See `no-repo` / `no-commits` / `detached` remediation in Doctor output |
| **JSC engine** | `detectEngine` reports `jsc` | `first-load` / `memory-leaks` / `listing` / `re-renders` unavailable | Route to `bundle-size` instead |

## Device enumeration

List booted iOS simulators and connected Android devices:

```bash
# iOS simulators (macOS — lists all booted)
xcrun simctl list devices booted -j

# Android devices/emulators
adb devices
```

`parseSimctl` / `parseAdbDevices` in `doctor.mjs` parse these into `[{udid,name}]` / `[{serial,state}]`; Doctor prints them automatically. Use raw commands when debugging connectivity outside Doctor.

## Engine matrix — which presets work on each engine

| Preset | Hermes | JSC | Notes |
|---|---|---|---|
| `first-load` | ✅ Full (`rnStartupTiming` via `cdp runtime eval` + launch timing) | ⚠️ agent-device launch timing only (no CDP) | CDP requires Hermes |
| `listing` | ✅ Full | ❌ React profiling needs Hermes | `agent-device react-devtools` (debugger channel) + agent-device; RN ≥ 0.74 |
| `memory-leaks` | ✅ Full (`heap_sample.mjs` / `agent-device cdp memory`) | ❌ JS heap sampling requires Hermes CDP | Rewrite leaks as native-mem check with `agent-device` if on JSC |
| `bundle-size` | ✅ Full | ✅ Full | Build-time, no engine/device dependency |
| `re-renders` | ✅ Full | ❌ React profiling needs Hermes | `agent-device react-devtools` (debugger channel); RN ≥ 0.74 |

## Routing — which tool for which signal

| Signal you need | Tool | Why |
|---|---|---|
| Drive the app (open, tap, type, scroll, gestures, wait, assert) | **agent-device** | the user-simulation layer; produces the workload you measure |
| **Any visual/controlling action** — screenshot, tap, type, swipe, long-press, button press | **agent-device** | the only UI-driving path |
| CPU/memory **device** samples, video, traces, crash context, console logs (`logs`), `.ad` replay | agent-device | on-device evidence capture |
| Per-component re-render causes, slow renders, commit timeline | agent-device (`react-devtools`) | React DevTools over the Metro debugger channel — no app change |
| Hermes JS CPU profile, JS heap (usage · snapshots · allocations), JS eval | agent-device (`cdp`) | CDP into the Hermes target via Metro, no app code changes |
| Reload the JS bundle | agent-device (`metro reload`) | does not revive a dead session — relaunch for that |
| Which fix to try | react-native-best-practices | the hypothesis catalog (mapped per preset in `presets.md`) |

CPU/memory have two layers: **`agent-device cdp`** for Hermes-level JS CPU/heap, **`agent-device perf`** for OS-level CPU/memory while driving a real workload. For *component re-rendering*, use **`agent-device react-devtools`**.

---

## agent-device (CLI)

Drives iOS Simulator, Android Emulator, physical devices, tvOS, macOS, desktop. **Commands come from the tool, not this file:** read `agent-device help workflow` (version-matched operating guide) at the start of every session, and `agent-device <cmd> --help` before any flag you haven't seen this session. The `SessionStart` hook keeps it on `@latest`, so memorized flags go stale. Topic help: `agent-device help <dogfooding|debugging|replay|...>`.

Gotchas the upstream guide doesn't cover:
- Taps are `press` (`tap` is an alias). `fill <selector> "v"` replaces a field; `type` appends to the focused one.
- **Never `open --foreground`** — agent-device's own XCTest runner counts as a running app → `AMBIGUOUS_MATCH`. Attach with `open <bundleId>` (no `--relaunch`; idempotent, preserves the current screen). Bundle id: Metro `/json/list` → `appId`.
- **RN overlay hint** in any output → `agent-device react-native dismiss-overlay` before the next interaction.
- Selector priority: `id="…"` (testID) > `label="…"` > visual + device-keyed hint (no AX node). `@eN` refs go stale after every mutation.
- Runner + daemon self-idle after 5 min; a CLI version bump replaces a stale daemon automatically.
- **`find <text>` with no action taps the match** — it is not read-only. Observe with `snapshot -i` / `is` / `get`.
- Buttons: use `role=button label="…"` — RN primary buttons usually expose an `[other]` wrapper with the same label → `AMBIGUOUS_MATCH`.
- Sheets / animated success screens may be missing from `snapshot -i` (it lists the screen underneath) — screenshot is truth; see `references/navigation.md` → *Interaction rules*.
- **`close` quits the app** (not just the session) — metrognome never runs it at teardown; the session, runner, and daemon self-idle after 5 min.

**metrognome uses it to:** produce the workload (open/scroll/cycle), grab device-level CPU/mem timing, read JS-runtime signals (`cdp`), and profile renders (`react-devtools`).

### React profiling — `agent-device react-devtools`

Built-in React DevTools client (agent-device ≥ 0.21.29). **Commands come from the tool:** `agent-device react-devtools --help`. It attaches through the Metro dev server's debugger channel — dev build, RN ≥ 0.74, Hermes; no app/Metro/Babel change, no start/connect/stop step. (It replaces the standalone port-8097 DevTools daemon: RN ≥ 0.87 removed that backend, and RN 0.83.10 / 0.85 / 0.86 already dial the dev-server port instead.)

Gotchas:
- **Several apps on one Metro** ("Several React Native apps are connected") → add `--app <bundle-id>`.
- **Open RN DevTools window** → `tree` / `find` / `errors` / `inspect` fail with `tree-unavailable`: close the window and reload the app.
- **Gate metric = commit count** from `profile stop` (`React profile 3.7s: 15 commits, …`) — `--direction lower --unit commits`. Counts differ by platform for the same interaction (iOS vs Android) — baseline and candidate on the same device. There is no `profile diff`: repeat the same start → interaction → stop and compare.
- Timings come from dev builds — compare runs, never read absolute ms.

### JS runtime — `agent-device cdp`

Runs a pinned CDP helper against the Hermes target (`agent-device help cdp`): JS eval, JS heap, JS CPU.

- **Select the target once per session:** `cdp target list --url http://127.0.0.1:<port>` → `cdp target select <id>`. On New Arch each device exposes two pages — pick the JS runtime page (`React Native Bridgeless`), not `UI` (not JS-evaluable). Skip the `-1` ghost (`vm: "don't use"`).
- **Check the `target select` output on every cold run.** If it fails or `target list` is empty, the *previous* target stays selected and later calls fail with `Target … is not connected`.
- **IDs are global** (`jm_N`, `ms_N`) and keep incrementing across sessions — always read the ID from the command's output, never assume `jm_1`.
- **JS CPU:** `cdp profile cpu start` → interaction → `stop` → `hotspots --limit N` (works on New Arch). It starts after the app is running — **bundle evaluation at startup cannot be profiled**.
- **JS-thread jank (longtask):** install the observer → interaction → read → disconnect; gate on `totalMs` (`--direction lower --unit ms`). Globals reset on reload/relaunch — **re-install after every one**.
  ```bash
  agent-device cdp runtime eval --expr '(()=>{globalThis.__mgLT=[];const o=new PerformanceObserver(l=>{for(const e of l.getEntries())globalThis.__mgLT.push(e.duration)});o.observe({entryTypes:["longtask"]});globalThis.__mgLTo=o;return "ok"})()'
  # … interaction …
  agent-device cdp runtime eval --expr '(a=>JSON.stringify({count:a.length,totalMs:Math.round(a.reduce((s,d)=>s+d,0))}))(globalThis.__mgLT)'
  agent-device cdp runtime eval --expr 'globalThis.__mgLTo.disconnect()'
  ```
- **Source maps (allocation + CPU profile):** on newer Expo bundles (RN 0.88 / Expo SDK 58) they resolve 0% of frames — function names still show, the file column shows the bundle URL; RN 0.83 resolves (~98%).
- **Stale targets** (metro#985, fixed in RN 0.84+): repeated reload/relaunch leaves dead `/json/list` entries. If a freshly-selected target times out, **restart Metro + launch the app once** without reloading.

### Single debugger slot (RN < 0.85)

Hermes admits one debugger connection; a new client kicks the old one (`NEW_DEBUGGER_OPENED`). `agent-device cdp` and `react-devtools` coexist with each other; the other contenders are **`heap_sample.mjs`** (raw CDP WebSocket) and a **user-opened RN DevTools / Fusebox window**. A react-devtools recording survives another client reconnecting mid-run, but **never run `heap_sample.mjs` concurrently with `agent-device cdp` / `react-devtools`** — run it as a separate pass.

**DO NOT instruct the user to open the JS Debugger / RN DevTools / Fusebox frontend.** The Hermes target appears on `localhost:8081/json/list` automatically once the app runs against Metro; opening the debugger (Cmd+D → "Open JS Debugger") holds the slot and breaks every preset except `bundle-size`. Only escalate a held slot to the user as a last resort.

**metrognome uses it to:** gate `re-renders` / `listing` on commit count, then drill into the dominant cause (`profile report <Component>`, `profile commit <N>`, `inspect @cN`).

---

## Per-platform measurement matrix

Not all limitations are tool defects — some are hard platform boundaries; use this to pick the right gate metric before baselining.

| Signal | iOS Simulator | iOS real device | Android emu/device | Channel & what it measures |
|---|---|---|---|---|
| **Displayed / GPU-composited frame FPS** | ❌ **Apple constraint** — Simulator renders on the host Mac GPU; frame timing is neither exposed nor representative (WWDC'19 #418) | ✅ (Instruments / Xcode; hard to automate post-Flipper) | ✅ Flashlight (`dumpsys gfxinfo`, zero instrumentation) | OS-level — real screen pixels composited by the GPU |
| **JS-thread jank** (`PerformanceObserver longtask`) | ✅ via `agent-device cdp runtime eval` | ✅ | ✅ | JS-thread saturation — heavy `renderItem`, GC pauses, oversized closures; stable in RN 0.83 |
| **Per-component re-render causes & commit timeline** | ✅ `agent-device react-devtools` | ✅ | ✅ | React-fiber-aware via the Metro debugger channel (Hermes, RN ≥ 0.74); independent of GPU |
| **JS heap / leaks** (`Runtime.getHeapUsage` + `HeapProfiler.collectGarbage`) | ✅ **via CDP — `heap_sample.mjs` / `agent-device cdp memory`** | ✅ | ✅ | Hermes JS-object heap; monotonic growth across nav cycles = leak signal |
| **Startup** (`performance.rnStartupTiming`) | ✅ | ✅ | ✅ | RN init + bundle-exec timeline |
| **CPU / memory (OS-level)** | ✅ agent-device `perf memory sample` / `perf cpu profile` (FPS absent on Simulator) | ✅ | ✅ | XCTest (iOS) / ADB (Android) |

### iOS Simulator FPS — platform boundary, not a tool defect

See the **Displayed / GPU-composited frame FPS** row above for the full target breakdown. Route FPS to **Flashlight** on Android or **Instruments / XCTest hitch metrics** on a real iOS device. Every other matrix signal is measurable on the iOS Simulator.

---

## react-native-best-practices (Callstack agent-skill)

Knowledge base from `callstackincubator/agent-skills`: **10 JS + 10 native + 9 bundling = 29 guides**, each rated CRITICAL/HIGH/MEDIUM, organized around Measure → Optimize → Re-measure → Validate. Ships inside Callstack's **`building-react-native-apps`** plugin (the standalone `react-native-best-practices` plugin was retired upstream in callstackincubator/agent-skills#76). Not vendored (avoids license/staleness) — Doctor auto-installs it and prints the `guides:` dir; guide slug `<slug>` = `<guides>/<slug>.md`. `presets.md` maps each preset to the specific guide to consult. This is the source of the *hypothesis*; metrognome supplies the *measured verdict*.

The Claude Code harness keeps installed plugins current automatically. The **Senior Engineer Audit** (mode 5) grounds every finding in these guides + `references/architectural-perf-catalog.md`.
