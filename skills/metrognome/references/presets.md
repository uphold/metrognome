# Presets

Five presets. Each: **Metric** · **Drive** (agent-device) · **Measure** (tool) · **Diagnose** (react-native-best-practices guide) · **Candidate fixes** (try one at a time, gate each). Always run the N-run protocol in `measurement.md`; never stack fixes. `--target <Screen/Component>` names the focus; if omitted, ask or infer from the Perf Map Top-3 / Performance Memory.

## `first-load` — cold-start / TTI

- **Prerequisites:** Metro running, ≥1 Hermes target, live app session, git `usable`. **Hermes required** — CDP heap/CPU profiling unavailable on JSC (launch timing still works, less signal). See engine matrix in `references/tools.md`.
- **Metric:** time-to-interactive from cold launch (lower is better).
- **Drive:** `agent-device open <App>` from cold start; time until first interactive frame.
- **Measure:** metro-mcp profiler (Hermes CPU profile) + agent-device launch timing; inspect CPU profile for dominant startup cost.
- **Diagnose:** RN best-practices **bundling/lazy-loading** + **js** startup.
- **Candidate fixes:** lazy-load non-home screens (`React.lazy` / dynamic `import()`); defer heavy top-level imports; trim/inline-config fonts; on Android, disable JS bundle compression (Hermes mmaps the uncompressed bundle → faster startup); move work out of module top-level into post-interaction.

## `listing` — scroll jank

- **Prerequisites:** Metro running, live app session, git `usable`. CDP-free (agent-react-devtools + agent-device) — Hermes and JSC. **Displayed-frame FPS not available on iOS Simulator** (Apple constraint — see `references/tools.md` matrix); use Android/Flashlight or real iOS device for FPS.
- **Metric:** JS-thread jank / wasted re-renders during sustained scroll (lower is better). JS-side signals (re-renders, longtask, CPU profile) work on Simulator.
- **Drive:** `agent-device scroll` continuously on the target list.
- **Measure (CDP-free — Expo incl. iOS Simulator):** `agent-react-devtools profile start` → scroll → `profile stop` → `profile slow` / `profile rerenders`; `agent-device metrics --json` for OS stats (CPU, memory; **`fps.droppedFramePercent` only on Android/device**). On Android or real iOS device, add Flashlight for FPS+CPU+RAM. Correlate with Hermes CPU profile if metro-mcp available (see `references/tools.md`).
- **Gate on iOS Simulator:** re-render commit count (`profile rerenders`) or longtask — `stats.mjs --direction lower --unit ms`, `min-effect` ≈ 20 ms.
- **Gate on Android / iOS device:** FPS from Flashlight / agent-device, `min-effect` ≈ 2–3 fps, `--direction higher`.
- **Diagnose:** RN best-practices **js/optimizing-flatlist** + FlashList migration guide.
- **Candidate fixes:** add `getItemLayout`; stable `keyExtractor` (never array index); `React.memo` the row + memoize its props; tune `initialNumToRender` / `windowSize` / `maxToRenderPerBatch`; `removeClippedSubviews`; migrate to **FlashList** if list is large and heterogeneous.

## `memory-leaks` — RAM stability

- **Prerequisites:** Metro running, ≥1 Hermes target, live app session, git `usable`. **Hermes required** (`heap_sample.mjs` uses Hermes CDP) — if JSC detected, route to `bundle-size` or `listing`.
- **Metric:** JS-heap growth across open↔close cycles; should return to baseline after GC — sustained growth = leak. Works on iOS Simulator, iOS device, Android.
- **Drive:** `agent-device` cyclic open/close ×N (e.g. 10 cycles) via a `.ad` replay script.
- **Measure (primary — cross-platform incl. iOS Simulator):** `heap_sample.mjs --once` per cycle; or `heap_sample.mjs --cycles N` for a GC-bracketed series. Output: comma-separated `usedSize` for `stats.mjs`. Each reading: `HeapProfiler.collectGarbage` → 400 ms → `Runtime.getHeapUsage` → record `usedSize`. Leak = `usedSize` never returns to baseline after GC. **Note:** `getHeapUsage` tracks the Hermes JS-object heap only (TypedArray buffers separate); native leaks won't appear.
- **Measure (alternative):** metro-mcp `start_heap_sampling` / `stop_heap_sampling` — allocation-site breakdown to identify *which* objects are leaking. See `references/tools.md` for CDP gotchas.
- **Gate:** `stats.mjs --direction lower --unit bytes --min-effect 2000000 --k 2` (2 MB floor; lower to e.g. 500000 for a small targeted leak). `--baseline` from before, `--candidate` from after.
- **Diagnose:** RN best-practices **js/cleanup-effects**.
- **Candidate fixes:** return cleanup from `useEffect` (remove listeners, `clearInterval`/`clearTimeout`); cancel in-flight requests/subscriptions on unmount; avoid capturing large closures in long-lived refs; detach native event emitters.

## `bundle-size` — JS bundle bytes

- **Prerequisites:** git `usable`. **No device, Metro, or session required** — build-time only; skip session bring-up entirely. Works on Hermes and JSC.
- **Metric:** production JS bundle size in bytes (lower is better).
- **Drive:** n/a — produce a release bundle (`npx react-native bundle …` / `expo export`) and measure bytes; optionally use a source-map explorer.
- **Measure:** bundle byte size before/after; Perf Map flags `barrelImport` sites as suspects.
- **Diagnose:** RN best-practices **bundling/avoid-barrel-files** + tree-shaking/code-splitting guides.
- **Candidate fixes:** import leaf modules directly (not through barrel `index`); code-split rarely-used screens; drop or swap heavy deps (e.g. moment → lighter date lib); enable tree-shaking-friendly imports.

## `re-renders` — wasted commits

- **Prerequisites:** Metro running, live app session, git `usable`. `agent-react-devtools` daemon on port 8097, ≥1 app connected. CDP-free — Hermes and JSC.
- **Metric:** wasted/excessive re-renders on the target screen (lower is better).
- **Drive:** `agent-device` interactions on the target screen (those that feel laggy).
- **Measure:** `profile rerenders` and `profile slow`; `get component @cN` to inspect why props change. Verify with `profile diff` before/after.
- **Diagnose:** RN best-practices **js/memoization** + **js/avoid-anonymous-functions**.
- **Candidate fixes:** memoize handlers (`useCallback`) and derived values (`useMemo`); `React.memo` pure children; hoist static styles out of render; split oversized contexts; stop defining components inside components.

---

## Mapping the Performance Map to a preset

Each detector carries its preset, so a Top-3 line maps directly:

| Detector | Preset |
|---|---|
| `listNoItemLayout`, `indexAsKey`, `oversizedList` | `listing` |
| `nestedComponent`, `inlinePropLiteral`, `listRowNoMemo` | `re-renders` |
| `effectNoCleanup` | `memory-leaks` |
| `barrelImport` | `bundle-size` |
| `heavyEntryImport`, `imageNoDims` | `first-load` |
