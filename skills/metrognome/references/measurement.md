# Measurement & the Gate

## Why single samples lie

Thermals, GC, background work, JIT/Hermes warm-up, and OS scheduling move numbers by 5–15% with no code change. A single before/after pair routinely shows a "win" that is pure jitter — unmeasured wins fill your history with silent regressions. metrognome keeps **only changes whose improvement exceeds the measurement noise.**

## Preconditions — session must be live

A broken session gives noise or zeros. Verify before the N-run protocol:

1. **Git state is `usable`** — `parseGitState` returns `state: 'usable'`. Without this, commits and reverts will throw; print Doctor's remediation and wait.
2. **Metro is reachable** — `localhost:${port}/json/list` responds with ≥1 live Hermes target (excluding the `-1` ghost). If Metro is down, start it first.
3. **App session is live** — `agent-react-devtools status` reports ≥1 app connected (required for `re-renders` / `listing`). Run the session bring-up sub-protocol if not.

Doctor's preflight (step 1 of the loop) verifies all three — skip re-running it if Doctor already ran cleanly.

## The N-run protocol

For both baseline and candidate:

1. Run the preset's measurement **N times** (default **N=5**).
2. **Discard the first run** (JIT/cache costs). Keep the remaining N−1.
3. Compute **mean ± sample stddev** over kept runs (`scripts/stats.mjs`).

Use the *same* driving workload each time — a `.ad` replay script from agent-device makes this exact. Variable workloads defeat the gate.

## The gate

Keep a change only if improvement clears the **noise band**:

```
improvement = (lower-is-better) ? baseline_mean − candidate_mean
                                : candidate_mean − baseline_mean      // FPS
pooled_std  = sqrt(((n₁−1)·s₁² + (n₂−1)·s₂²) / (n₁+n₂−2))
noise_band  = max(min_effect, k · pooled_std)            // k ≈ 2
KEEP  ⇔  improvement > noise_band
```

Both thresholds must be cleared:
- **`k · pooled_std`** — statistical floor: improvement must stand out from jitter (k≈2 ≈ clearly-separated distributions).
- **`min_effect`** — practical floor: don't chase a real-but-trivial gain. Per preset: TTI 30 ms, jank 2 dropped frames, RAM a few MB (2000000 / 500000 bytes), FPS 2–3 fps, bundle a few KB.

Direction: **lower-is-better** for TTI, jank, RAM, bundle bytes, wasted commits; **higher-is-better** for FPS.

## Choose a metric your platform can measure

Before baselining, confirm the metric is available on your target — N/A or constant zero defeats the gate.

| Metric | iOS Simulator | iOS device | Android |
|---|---|---|---|
| **Displayed-frame FPS** | ❌ unavailable (Apple constraint) | ✅ Instruments / XCTest hitch metrics | ✅ Flashlight (`dumpsys gfxinfo`) |
| **JS-thread jank** (longtask ms) | ✅ CDP `PerformanceObserver` | ✅ | ✅ |
| **Re-render commit count / slow renders** | ✅ agent-react-devtools | ✅ | ✅ |
| **JS-heap bytes** (leak signal) | ✅ `heap_sample.mjs` (CDP) | ✅ | ✅ |
| **Startup / TTI** | ✅ | ✅ | ✅ |
| **CPU / memory (OS)** | ✅ agent-device (no FPS column) | ✅ | ✅ |

For `listing` on iOS Simulator, gate on **re-render count** or **longtask duration** rather than FPS. For `memory-leaks`, use **`heap_sample.mjs --cycles N`** piped into `stats.mjs --direction lower --unit bytes`.

## Run it

```bash
$MG stats \
  --baseline  "1200,1180,1210,1190" \
  --candidate "980,1000,990,1010" \
  --min-effect 30 --k 2 --direction lower --unit ms
```

Returns JSON with both distributions, improvement (absolute + %), pooled std, noise band, and `decision: KEEP | REVERT`. Self-check: `$MG stats --self-test`.

## After the decision

- **KEEP** → atomic `git commit` with the measured delta and n, e.g. `perf(listing): getItemLayout on FeedScreen — jank 18→4 frames (−78%, n=4)`.
- **REVERT** → restore each `touched` file from its pre-fix snapshot; log REVERTED in the Ledger with both distributions; record in `perf-memory.md` so the dead-end isn't retried. `preExistingDirty` files are never touched.

Record **both full distributions** in the Ledger either way — reverted data prevents retrying a proven-neutral fix.
