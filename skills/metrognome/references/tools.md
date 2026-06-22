# Tools & Signal Routing

metrognome delegates all measurement to four tools — metro-mcp plus three from Callstack (agent-device, agent-react-devtools, react-native-best-practices). **Cheatsheet + routing table.** When command surfaces don't match, the installed CLI help is the source of truth (`agent-device help workflow`, `agent-react-devtools --help`) and the live MCP tool list for metro-mcp. **Update this file before a pitch or when a tool version bumps.** (Verified: metro-mcp 0.11.x, agent-device 0.16.12, agent-react-devtools 0.4.0. RN connect-import guidance corrected 2026-06-03.)

## Preconditions & recovery

| Condition | Check | Symptom if broken | Remediation |
|---|---|---|---|
| **Metro running** | `curl -s localhost:8081/json/list` returns JSON | `probeMetro` → `reachable:false` | `node doctor.mjs --launch-metro` or run the detected start command manually |
| **≥1 Hermes target** | `/json/list` has entries with `id !== '-1'` | `liveTargets: 0` even with Metro up | Relaunch app: `agent-device open <bundleId> --relaunch` |
| **app session live** | `agent-react-devtools status` → `Apps: N connected` | "0 connected" in devtools | `agent-device open <bundleId> --relaunch` then `agent-react-devtools wait --connected` |
| **Git usable** | `parseGitState` returns `state: 'usable'` | Commits/reverts throw | See `no-repo` / `no-commits` / `detached` remediation in Doctor output |
| **JSC engine** | `detectEngine` reports `jsc` | `first-load` / `memory-leaks` unavailable | Route to `bundle-size`, `listing`, `re-renders` instead |

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
| `first-load` | ✅ Full (Hermes CPU profile + startup timing) | ⚠️ agent-device launch timing only (no CDP heap/CPU) | CDP heap/CPU require Hermes |
| `listing` | ✅ Full | ✅ Full | CDP-free path (agent-react-devtools + agent-device) works on both |
| `memory-leaks` | ✅ Full (`heap_sample.mjs` via CDP) | ❌ JS heap sampling requires Hermes CDP | Rewrite leaks as native-mem check with `agent-device` if on JSC |
| `bundle-size` | ✅ Full | ✅ Full | Build-time, no engine/device dependency |
| `re-renders` | ✅ Full | ✅ Full | CDP-free path via agent-react-devtools |

## Routing — which tool for which signal

| Signal you need | Tool | Why |
|---|---|---|
| Drive the app (open, tap, type, scroll, gestures, wait, assert) | agent-device | the user-simulation layer; produces the workload you measure |
| CPU/memory **device** samples, video, traces, crash context, `.ad` replay | agent-device | on-device evidence capture |
| Per-component re-render causes, slow renders, commit timeline | agent-react-devtools | the only React-fiber-aware source |
| Hermes CPU profile, heap sampling, network, console/exceptions, JS eval, navigation | metro-mcp | CDP into Metro/Hermes, no app code changes |
| Which fix to try | react-native-best-practices | the hypothesis catalog (mapped per preset in `presets.md`) |

CPU appears in more than one tool by design. Prefer **metro-mcp** for Hermes-level JS CPU/heap and **agent-device** for OS-level CPU/memory while driving a real workload. For *component re-rendering*, only **agent-react-devtools** sees the fiber tree.

---

## agent-device (CLI)

Drives iOS Simulator, Android Emulator, physical devices, tvOS, macOS, desktop. Read `agent-device help workflow` at the start of every session — it is the agent-facing source of truth.

```bash
agent-device apps --platform ios            # list installed/available apps
agent-device open <App> --platform ios      # launch app, start a session
agent-device snapshot -i                     # accessibility snapshot w/ interactive refs (@e3, …)
agent-device tap @e3                          # tap a ref (also: selectors, coords)
agent-device fill @e3 "test@example.com"     # type into a field
agent-device scroll ...                       # scroll/swipe the target list (drives `listing`)
agent-device screenshot ./artifacts/x.png    # capture evidence
agent-device close                            # end the session
```

Also exposes: gestures, `wait`/assert, video recording, logs, traces, network capture, **CPU/memory performance samples**, **React render profiles**, and `.ad` replay scripts (record once, replay deterministically). Topic help: `agent-device help <dogfooding|debugging|replay|...>`. Some iOS ops need `brew install idb-companion`.

**metrognome uses it to:** produce the workload (open/scroll/cycle) and grab device-level CPU/mem timing for `first-load`, `listing`, `memory-leaks`.

---

## agent-react-devtools (CLI daemon)

Persistent background daemon that survives across CLI calls; token-efficient output built for LLMs. Refs look like `@c5`.

**React Native needs no app code change.** `npx agent-react-devtools init --dry-run` reports "no code changes needed" — the app auto-connects on port **8097** via the `react-devtools-core` backend Metro bundles. The `./connect` export and `init` code-injection target **web React (Vite/browser)** and **crashed our Expo SDK 55 / New Arch test app** when added to an RN entry point. **Never add `import 'agent-react-devtools/connect'` to a React Native entry point.** "0 connected" means a **dead app session, not a missing import** — restart Metro and reopen the app.

```bash
agent-react-devtools start [--port 8097]     # start daemon (then run/refresh the app)
agent-react-devtools status                   # "Apps: 1 connected" when wired up
agent-react-devtools wait --connected         # block until an app connects

agent-react-devtools get tree [@c1] [--depth N] [--all] [--max-lines N]
agent-react-devtools get component <@c1>      # props, state, hooks
agent-react-devtools find <Name> [--exact]    # locate a component
agent-react-devtools count                     # component counts by type
agent-react-devtools errors                    # components with errors/warnings

agent-react-devtools profile start [name]
agent-react-devtools profile stop
agent-react-devtools profile slow [--limit N]       # slowest components by avg duration
agent-react-devtools profile rerenders [--limit N]  # most re-rendered components  <-- `re-renders` preset
agent-react-devtools profile timeline [--limit N]   # commit timeline
agent-react-devtools profile report <@c1>           # render report for a component
agent-react-devtools profile export <file>          # React DevTools Profiler JSON
agent-react-devtools profile diff <before.json> <after.json> [--threshold N]  # before/after compare
```

**metrognome uses it to:** find the dominant re-render cause (`profile rerenders`/`slow`) for the `re-renders` and `listing` presets, and `profile diff` to verify a fix at the component level.

---

## metro-mcp (bundled MCP server)

Connects to Metro via Chrome DevTools Protocol — **no app code changes** for most features. Works with Expo, bare RN, anything on Metro + Hermes. Bundled via `.mcp.json` (`npx -y metro-mcp@latest`); call tools directly as MCP tools (not via Bash).

**Expo / New Arch CDP gotchas** (verified: Expo SDK 55 / RN 0.83 / New Arch, June 2026):

- **CDP channel works on New Arch.** Raw `Runtime.evaluate` succeeds against the correct target. metro-mcp's timeout on New Arch is a **target-selection bug**, not a stack incompatibility.
- **Target selection on New Arch:** RN 0.83 New Arch exposes two pages per device — page 1 `"React Native Bridgeless [C++ connection]"` (`nativePageReloads: true`, `prefersFuseboxFrontend: true`) is the live JS/Hermes runtime; page 2 `"UI [C++ connection]"` (`nativePageReloads: false`) is the UI thread and is **not JS-evaluable**. metro-mcp's `selectBestTarget` appears to prefer `nativePageReloads: false` and picks the UI thread → `Runtime.evaluate` hangs. **Workaround:** per metromcp.dev/troubleshooting, try setting metro-mcp's `newArchitecture: true` config flag — this may re-route target selection to the Fusebox JS page (unverified; check the troubleshooting page for the current fix).
- **Single CDP slot (RN < 0.85).** Hermes allows one debugger connection; no multiplexing. If a React Native DevTools / Fusebox frontend is open, it holds the slot and metro-mcp's evaluate hangs. **Close all RN DevTools browser tabs / windows before calling runtime metro-mcp tools.**
- **DO NOT instruct the user to open the JS Debugger / RN DevTools / Fusebox frontend.** The Hermes target appears on `localhost:8081/json/list` automatically once the app runs against Metro. Telling the user to open the debugger (Cmd+D → "Open JS Debugger" / "Open DevTools") holds the single CDP slot and defeats metro-mcp. The `listing` and `re-renders` presets are CDP-free and unaffected. Only escalate a held-slot situation to the user as a last resort when `first-load` or `memory-leaks` is running and a browser window is blocking the slot.
- **Stale targets** (metro#985, fixed in RN 0.84+): repeated reload/relaunch leaves dead `/json/list` entries with climbing IDs (`-1`, `-2`, `-3`). If evaluate times out on a freshly-selected target, **restart Metro + launch the app once** without reloading. Stale entries pile up until Metro restarts.
- **The `-1` synthetic target** (`REACT_NATIVE_RELOADABLE_PAGE_ID = "-1"`, title `"React Native Experimental (Improved Chrome Reloads)"`, `vm: "don't use"`) is a ghost — not callable. On New Arch this ID may not appear; if it does, exclude by `id === "-1"` (exact match only; device-scoped pages like `hash-1` are real).
- **`nativePageReloads: false` is benign** — it only governs which target the RN DevTools frontend auto-opens on `j`; it does **not** mean the target is non-callable.

Tool groups (0.11.x counts — confirm exact names from the live tool list):

| Group | Tools | Use for |
|---|---|---|
| **profiler** | ~9 | CPU profiling (React DevTools hook) + **heap sampling** + render tracking → `first-load`, `memory-leaks` |
| **network** | ~6 | request tracking, response-body inspection, stats |
| **console** | ~2 | console log collection with filtering (catch warnings/exceptions) |
| **evaluate** | 1 | execute JS in the app runtime (read a global, force a GC, time a path) |

Plus `open_devtools` (opens the rn_fusebox frontend through the proxy so it coexists with the MCP) and recording/automation tools (`start_test_recording`, `tap_element`, `type_text`, `swipe`).

**metrognome uses it to:** take Hermes CPU profiles + heap samples per cycle (`memory-leaks`), CPU profile cold start (`first-load`), and read console exceptions during a run.

---

## Per-platform measurement matrix

Not all limitations are tool defects — some are hard platform boundaries; use this to pick the right gate metric before baselining.

| Signal | iOS Simulator | iOS real device | Android emu/device | Channel & what it measures |
|---|---|---|---|---|
| **Displayed / GPU-composited frame FPS** | ❌ **Apple constraint** — Simulator renders on the host Mac GPU; frame timing is neither exposed nor representative (WWDC'19 #418) | ✅ (Instruments / Xcode; hard to automate post-Flipper) | ✅ Flashlight (`dumpsys gfxinfo`, zero instrumentation) | OS-level — real screen pixels composited by the GPU |
| **JS-thread jank** (`PerformanceObserver longtask`) | ✅ via CDP eval | ✅ | ✅ | JS-thread saturation — heavy `renderItem`, GC pauses, oversized closures; stable in RN 0.83 |
| **Per-component re-render causes & commit timeline** | ✅ agent-react-devtools (port 8097) | ✅ | ✅ | React-fiber-aware; independent of CDP & GPU |
| **JS heap / leaks** (`Runtime.getHeapUsage` + `HeapProfiler.collectGarbage`) | ✅ **via CDP — `heap_sample.mjs`** | ✅ | ✅ | Hermes JS-object heap; monotonic growth across nav cycles = leak signal |
| **Startup / TTI** (`performance.rnStartupTiming`) | ✅ | ✅ | ✅ | RN init + bundle-exec timeline |
| **CPU / memory (OS-level)** | ✅ agent-device `metrics --json` (CPU, memory; FPS column absent) | ✅ | ✅ | XCTest (iOS) / ADB (Android) |

### iOS Simulator FPS — platform boundary, not a tool defect

See the **Displayed / GPU-composited frame FPS** row above for the full target breakdown. Route FPS to **Flashlight** on Android or **Instruments / XCTest hitch metrics** on a real iOS device. Every other matrix signal is measurable on the iOS Simulator.

---

## CDP-free measurement paths (work on Expo when metro-mcp runtime calls are unavailable)

`agent-react-devtools` and `agent-device` run on separate channels from metro-mcp's CDP — unaffected by the CDP slot, stale targets, or the New Arch target-selection bug above. The `listing` and `re-renders` presets can be **fully measured without metro-mcp's runtime channel**:

| Tool | Channel | Expo support | Signals available without CDP |
|---|---|---|---|
| **agent-react-devtools** | port 8097 (react-devtools-core WebSocket) | Auto-connects on port 8097 — **no app code change** (see agent-react-devtools section above). | `profile rerenders`, `profile slow`, `profile timeline`, component tree, render causes |
| **agent-device** | XCTest (iOS) / ADB (Android) | Works with Expo dev-client builds | `metrics --json` (CPU, memory; **FPS absent on Simulator** — see matrix above); `perf --json` (OS-level); `.ad` replay |
| **Flashlight** (`bamlab/flashlight`) | Android ADB — zero app instrumentation | Android only | FPS / CPU / RAM during any scroll workload |
| **heap_sample.mjs** | CDP raw WS (page 1, Hermes JS runtime) | Works with any Metro + Hermes app; no app code changes | `Runtime.getHeapUsage` — cross-platform JS heap leak signal; use with `--cycles N` + agent-device nav cycles |

When the metro-mcp runtime channel is unavailable, **run `listing` and `re-renders` entirely on this path** — `stats.mjs` gate math is identical regardless of measurement source.

---

## react-native-best-practices (Callstack agent-skill)

Knowledge base from `callstackincubator/agent-skills`: 9 JS + 9 native + 9 bundling guides, each rated CRITICAL/HIGH/MEDIUM, organized around Measure → Optimize → Re-measure → Validate. Not vendored (avoids license/staleness) — install via Doctor. `presets.md` maps each preset to the specific guide to consult. This is the source of the *hypothesis*; metrognome supplies the *measured verdict*.
