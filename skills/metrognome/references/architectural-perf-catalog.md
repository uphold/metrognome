# Architectural Performance Catalog

Reasoning corpus for the **Senior Engineer Audit** (mode 5). Each entry: **symptom · why it costs · how to spot · Callstack guide · gate preset**, or advisory note if ungated.

---

## Diagnostic Thresholds — The Signal-vs-Noise Floor

| Signal | Threshold | Interpretation |
|---|---|---|
| **Render duration** | **> 16 ms** | Real problem — drops below 60 fps frame budget |
| **Render duration** | 1–16 ms | Candidate — worth investigating if it recurs |
| **Render duration** | **< 1 ms** | Not your problem — do not report |
| **Long Task** | **≥ 50 ms** | Blocks user input; INP risk |
| **INP** (Interaction to Next Paint) | target **< 200 ms** | Web/RN bridge interaction budget |

**Rule:** never optimize without profiling. Reporting sub-1ms findings as hypotheses is noise.

---

## Architectural Anti-Pattern Catalog

Each entry: **symptom · why it costs · how to spot by reasoning over code · Callstack guide · gate preset, or advisory note if not auto-provable.**

---

### 1. State Placed Too High — Colocation Failure

**Symptom.** A `useState` or reducer that lives in a root/parent component but is only consumed by a leaf (or a small subtree). Every unrelated sibling and parent re-renders on each state change.

**Why it costs.** React's reconciler re-renders the entire subtree below the owner of state. If `searchQuery` lives in `AppRoot` but only `SearchBar` reads it, a keystroke re-renders `AppRoot → Header → Sidebar → ProductList → Footer` — none of them care about `searchQuery`. The cost is O(subtree size), invisible until the subtree is large.

**How to spot.** Cross-file data-flow: read the component that owns the state, count how many distinct subtrees consume it. If one `useState` is declared in a high-fan-in component but only imported/read by a small leaf, it is misplaced. Look for prop-drilling chains as a signal.

**Callstack guide.** `js-atomic-state` — atomic / colocated state patterns.

**Gate preset.** `re-renders` — measure commit count before/after moving state down.

---

### 2. Context Shape — Over-Broad or Merged Value+Setter

**Symptom.** A React Context whose `value` is an object literal `{ state, dispatch }` or a merged-state object. Any change to *any* slice of the object triggers a re-render in *every* consumer, even those that only care about one field.

**Why it costs.** React compares Context values by reference. A new `{ state, dispatch }` object literal on every render is a new reference → every consumer re-renders. A theme context that wraps the full tree re-renders the entire app on every theme change.

**How to spot.** Find `createContext` usages. If the Provider's `value=` prop is an object literal or passes a merged state object, flag it. Count how many components consume it (`useContext(ThemeCtx)`, etc.) to establish blast radius.

**Callstack guide.** `js-atomic-state` — split contexts by update frequency; memoize the value.

**Gate preset.** `re-renders`.

---

### 3. Render Cascades — Traffic Jams

**Symptom.** A state update in one component triggers a visible render chain through multiple unrelated components before the user sees a response. Often shows as jank or sluggish interactions even when no single render is expensive.

**Why it costs.** Cascades compound latency: each render in the chain adds its own scheduling overhead. Four renders for one user action means four times the scheduler overhead plus four reconciler passes, all synchronous by default.

**How to spot.** Read the component tree for the affected interaction path. Identify all `setState` calls and `useEffect` triggers that fire sequentially. A chain of two or more effects that each trigger state updates is a cascade regardless of individual render cost.

**Callstack guides.** `js-react-compiler` · `js-uncontrolled-components`.

**Gate preset.** `re-renders`.

---

### 4. Referential Instability Defeating `memo`

**Symptom.** A component wrapped in `React.memo` still re-renders on every parent render because its props include object literals, array literals, or inline function definitions that create new references each time.

**Why it costs.** `memo` compares props by reference. `style={{ color: 'red' }}` creates a new object on every render. If a child uses `React.memo`, it breaks — the memo is installed but provides zero benefit. This is especially insidious because the fix looks present (memo is there) but the underlying cause is invisible without reading the parent's JSX.

**How to spot.** Read each component whose props are passed from a high-render-frequency parent. Flag: object/array literals in JSX prop positions, inline arrow functions passed as callbacks, non-memoized selectors passed as data props.

**Callstack guide.** `js-react-compiler` — the Compiler handles this automatically; manual `useMemo`/`useCallback` is the stopgap.

**Gate preset.** `re-renders`.

---

### 5. Request / Effect Waterfalls

**Symptom.** A component (or chain of effects) serializes network requests that could be parallel: fetch user → on success, fetch posts → on success, fetch followers. Three round-trips where one parallel request would suffice. Also: sequential `await` chains in data-loading functions that have no logical dependency between steps.

**Why it costs.** Each waterfall step adds one full network round-trip to the loading time. On a 100ms RTT connection, three sequential fetches cost 300ms minimum; parallelized, they cost one round-trip plus the slowest response. The user sees a blank/loading state for 2–3× longer than necessary.

**How to spot.** Read `useEffect` bodies and data-loading functions. Flag `await` calls inside `useEffect` that are not logically dependent on the previous result. Count chained effects where one triggers another via state.

**Callstack guide.** `js-concurrent-react` — parallel data loading patterns.

**Gate preset.** Advisory — not currently auto-provable via a single gate preset. Flag as `hypothesis, ungated`; architectural refactor + manual profiling needed. Partial coverage under `first-load` if the waterfall affects TTI.

---

### 6. Main-Thread Blocking — Missing Concurrent Features

**Symptom.** A synchronous, expensive computation (filtering a large list, sorting, computing derived state) runs in the render path without `useTransition`, `useDeferredValue`, or `startTransition`. The user types a character and the UI freezes for >50ms while the computation completes.

**Why it costs.** JavaScript is single-threaded. Any synchronous work > 50ms is a Long Task that blocks user input. The fix is not to make the computation faster (though that helps) but to deprioritize it so React can process the user's input first.

**How to spot.** Read state-driven computations in the render path: `.filter()`, `.sort()`, `.reduce()` on arrays that could be large. Flag those not wrapped in `useTransition` / `useDeferredValue` when the computation feeds a visual list or chart. Confirm the array could realistically be >100 items.

**Callstack guide.** `js-concurrent-react` — useTransition / useDeferredValue patterns.

**Gate preset.** Advisory for pure main-thread / INP scenarios (no current INP gate). Partial coverage: if blocking occurs during list scroll, `listing` gate can detect Long Tasks.

---

### 7. Components Defined Inside Components — Silent Remounts

**Symptom.** A component function is defined inside the body of another component function. On every render of the parent, React sees a *new* component type and unmounts/remounts the child entirely instead of re-rendering it — destroying local state, triggering effect teardown and re-run, and causing visible flickering.

**Why it costs.** A remount is orders of magnitude more expensive than a re-render: the DOM node is destroyed and recreated, all effects tear down and re-run, input focus is lost, and transitions reset. "This component is RECREATED on every render."

**How to spot.** Search for function declarations or arrow functions that (a) return JSX and (b) are declared inside another component's function body (not at module level). The `nestedComponent` detector in `perf_scan.mjs` flags this mechanically; the brain layer explains *why* this is architecturally costly beyond the linter hint.

**Callstack guide.** `js-profile-react` — component lifecycle and remount patterns.

**Gate preset.** `re-renders` — remount count drops to zero after extracting the inner component.

---

### 8. Loading Strategy — Over/Under Code-Splitting

**Symptom A (under-split / eager).** The root navigator imports every screen eagerly at app startup. All screen modules — and their transitive imports (heavy libs, icons, data) — are parsed and executed before the first screen is shown. TTI grows with every new screen added, silently.

**Symptom B (over-split / fragmented).** Tiny, granular lazy boundaries around components that are always shown together cause waterfall HTTP requests (in web) or unnecessary async loading overhead (in RN bundle splits) with no perceptible TTI benefit.

**Why it costs.** Under-splitting: Hermes parses JS sequentially at startup; every eager import adds parse + eval time before the first interactive frame. Over-splitting: the waterfall penalty exceeds the lazy-loading benefit for components users always see immediately.

**How to spot.** Read the root navigator. Count how many screens are imported at the top level (non-lazy). If > 5–8 non-home screens load eagerly, flag as a lazy-loading opportunity. Check for `React.lazy` or dynamic `import()` on *already-visible* content (over-split).

**Callstack guides.** `bundle-code-splitting` · `bundle-barrel-exports`.

**Gate preset.** `first-load` (for under-split) or `bundle-size` (for bundle bytes).

---

### 9. Over-Memoization Debt Under the React Compiler

**Symptom.** The codebase is dense with manual `useMemo` and `useCallback` that predate or ignore the React Compiler. With the Compiler enabled (React 19+), these wrappers are **counterproductive**: the Compiler inserts optimal memoization itself, and manual wrappers add call overhead, make the code harder to read, and can actually *interfere* with the Compiler's analysis. Alternatively, the Compiler is not yet enabled — meaning all manual memoization is at best cargo-cult and at worst wrong.

**Why it costs.** Manual `useMemo` is almost never needed once the Compiler runs, and `useCallback` similarly. Every manual wrapper adds a function call, an array allocation (deps), and a cache comparison on every render. In codebases with hundreds of these wrappers, the aggregate overhead is measurable and the code complexity is real.

**How to spot.** Count `useMemo` and `useCallback` calls in the codebase. Flag files where > 30% of hooks are memoization wrappers. Check `package.json` / `babel.config.js` / `metro.config.js` for `react-compiler` — if absent on a React 19+ project, the Compiler is not enabled and manual memoization is the only option (different remediation: *enable the Compiler* rather than remove the wrappers). If the Compiler *is* enabled, manual `useMemo`/`useCallback` wrapping stable values is pure debt.

**Callstack guide.** `js-react-compiler` — enabling and trusting the React Compiler.

**Gate preset.** `re-renders` (measures render count before/after removing manual wrappers or enabling the Compiler). Advisory if the Compiler is not yet installed (the fix is a build config change, not a runtime code change; still gate on `re-renders` after enabling).

---

### 10. Native / Bridge & Threading Debt

**Symptom.** Heavy work runs over the JS↔Native bridge on every frame: layout measurements, animation values, scroll event payloads. Alternatively: Reanimated worklets are missing and animations run on the JS thread. TurboModules not yet adopted on New Arch. Native views have unnecessary deep nesting (view flattening disabled).

**Why it costs.** The bridge is serialized and async; calling it synchronously on every frame (60× per second) adds latency that cannot be hidden. JS-thread animations drop frames whenever the JS thread is busy with unrelated work. On New Arch, missing TurboModules means legacy bridge overhead that TurboModules eliminate. Unnecessary view nesting creates shadow-thread layout work on every re-render.

**How to spot.** Read animation code: flag `Animated.Value` + `useNativeDriver: false` and non-Reanimated gesture handlers on scroll. Look for `onScroll` handlers that do JS-thread computation. Count view nesting depth in hot list row components (> 5 nested Views without `collapsable={false}` or `removeClippedSubviews` is a signal). Check for New Arch adoption without TurboModule migration.

**Callstack guides.** `js-animations-reanimated` · `native-threading-model` · `native-turbo-modules` · `native-view-flattening`.

**Gate preset.** `listing` (for animation/scroll jank) or advisory for TurboModule migration (build + architecture change; not single-gate provable).

---

To extend: copy an entry's shape.
