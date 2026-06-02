# Perf Map 3D

Static, device-free scan of a RN repo → interactive 3D graph + Top-3 worst perf offenders. Nodes = source modules; edges = imports. Node **size = perf debt**, **color = severity**. Pipeline:

```
perf_scan.mjs  <repo>  -> graph.json        (Babel AST + detectors + scoring)
build_perf_map.mjs  graph.json  -> perf-map.html   (vendored 3d-force-graph + data, inlined, offline)
```

`build_perf_map.mjs --open` opens it; click any node for flaw + `file:line` + Callstack guide. All tuning is in `perf_scan.mjs`'s `CONFIG` block.

## The detectors

| Detector | Pattern | Severity | Preset |
|---|---|---|---|
| `listNoItemLayout` | FlatList/SectionList without `getItemLayout` | HIGH | listing |
| `indexAsKey` | `keyExtractor`/`key` returns the array index | HIGH | listing |
| `nestedComponent` | a named component defined inside another component | HIGH | re-renders |
| `effectNoCleanup` | `useEffect` adds a listener/timer/subscription, returns no cleanup | HIGH | memory-leaks |
| `heavyEntryImport` | full-package import of a heavy lib at an app-entry file | HIGH | first-load |
| `listRowNoMemo` | a list-row component used in a `.map`/`renderItem` but not `React.memo` | MEDIUM | re-renders |
| `inlinePropLiteral` | inline arrow / object / style literal as a JSX prop | LOW | re-renders |
| `barrelImport` | named import that resolves to a re-export barrel file | LOW | bundle-size |
| `imageNoDims` | remote `<Image>` with no explicit width/height | LOW | first-load |
| `oversizedList` | `initialNumToRender` too high / no `removeClippedSubviews` | LOW | listing |

## Scoring — and why signal beats noise

**Signal vs noise** is the core design invariant. RN static heuristics fire constantly in healthy code (a 1465-module app yields ~1500 inline-prop and ~1400 barrel hits) — a naive scorer lights every node red. Four mechanisms keep the map honest, tuned against bluesky's `social-app` to land at **~19 hotspots (~1%)** out of 1465 modules, all structural:

1. **Severity weights.** CRITICAL 10 · HIGH 5 · MEDIUM 1.5 · LOW 0.4. Common-but-harmless detectors (inline props, barrels, image dims) are LOW by design.

2. **Per-detector diminishing returns.** Past `diminishAfter` (3) hits of the same detector per file, extra hits add only `log2` — 150 inline props ≠ 150× worse. Distinct detectors stack normally; structural findings keep full weight.

3. **Structural-only centrality.** debt = `structuralRaw · centralityMult + cosmeticRaw`, where `centralityMult = 1 + k·log2(1+fanIn) + (hasList ? listBonus : 0)`. Fan-in amplifies **only** MEDIUM+ debt (a re-render bug in a hub imported 50× matters more than in a leaf) but does **not** amplify LOW noise. `log2` prevents a 500-fan-in hub from dwarfing everything (linear: debt 262 vs 44; log: ~2–3× boost).

4. **Combined gate.** Hotspot iff `debt ≥ hotspotDebt (6)` **OR** any HIGH/CRITICAL finding. Severity arm: a lone memory leak or missing `getItemLayout` in a leaf is never missed. Debt arm: catches accumulated MEDIUM/LOW clusters. Everything else renders small + grey, findings visible on hover/click — **low-severity hits aggregate quietly.**

> If a scan lights up too much, raise `hotspotDebt` (or lower a severity) in `CONFIG`. Tune against the real target repo, not `examples/sample-rn-app` — the fixture is circular by construction (it contains exactly what the detectors hunt), proving they *fire*, not that they're selective.

## Display filter & search

Only nodes with `debt ≥ displayMinDebt` (default **2**) render — dropping near-zero noise while keeping structural and accumulated debt. **Adjustable live** via the `min debt` control (search panel, top-left); links below the threshold drop too. Non-hotspot nodes with debt 2–6 render grey. The header `modules` stat shows the true scanned count; `N / M modules` reflects what's rendered.

A **search box** (above min-debt) filters by filename (exact > starts-with > contains, debt as tiebreak), top 5 matches. Clicking or Enter flies the 3D camera to that node. `window.__perfmap` exposes `focusNode`, `applyThreshold`, and `rankMatches` for automated verification.

## Import resolution (correctness, not cosmetics)

Real RN apps import almost everything through **path aliases** (`#/…`, `@/…`), not `../`. `perf_scan.mjs` reads `tsconfig.json`/`jsconfig.json` `compilerOptions.paths` from the scan root up. Without this the graph is a disconnected cloud and centrality is meaningless — on bluesky: 814 edges → 8862, fan-in up to 582. If `aliases (none found)` prints and the graph looks sparse, the repo likely has a babel `module-resolver` alias not mirrored in tsconfig — add it to tsconfig paths or extend `loadAliases`.

## Top-3 emission

`graph.json` includes a `top3` array (also printed by `perf_scan.mjs`) of ready-to-paste Autoresearch commands. Present them verbatim:

```
1. [debt 19.31] /metrognome listing --target Gallery
     FlatList/SectionList without getItemLayout (FlatList) at components/images/Gallery/index.tsx:252
```

`--target` is the component/screen name (for `index.*` files, the parent folder); the preset comes from the dominant finding. Pasting one into Autoresearch closes the diagnose→fix loop.
