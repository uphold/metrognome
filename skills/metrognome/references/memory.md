# Performance Memory

metrognome accumulates a per-repo log of every perf gap, routing future work from priors — turning a generic optimizer into *this app's* optimizer.

- **Lives in `.metrognome/perf-memory.md`** in the target repo, not the plugin. Committed **with the app** so the whole team inherits the knowledge.
- **Token-frugal:** one line per gap — cheap to read at the start of any run.

## Entry format

```
area/file · symptom · suspected cause · preset · status · ref
```

- **area/file** — `screens/FeedScreen.tsx` or component name.
- **symptom** — observed (`18 dropped frames on scroll`, `heap +12MB / 10 cycles`).
- **suspected cause** — short hypothesis (`FlatList missing getItemLayout`).
- **preset** — `first-load | listing | memory-leaks | bundle-size | re-renders`.
- **status** — `open` · `fixed` (kept, measured) · `reverted` (tried, didn't clear the gate — don't retry).
- **ref** — commit SHA or ledger filename.

### Examples

```
screens/FeedScreen.tsx · 18 dropped frames scrolling feed · FlatList no getItemLayout · listing · fixed · a1b2c3d (18→4, n=5)
screens/FeedScreen.tsx · rows re-render on every parent update · Row not memoized · re-renders · reverted · 2026-05-30-re-renders.md (Δ within noise)
state/messages/convo/index.tsx · heap +12MB / 10 open-close · useEffect no cleanup · memory-leaks · open · perf-map 2026-05-30
App.tsx · +220ms TTI · synchronous moment import at entry · first-load · fixed · d4e5f6a (−210ms, n=5)
```

## Read path (leverage priors)

At the **start of any metrognome run, and any perf-related work** in a `.metrognome/`-tracked repo, read this file first:
- known hotspots → skip rediscovery,
- `fixed` entries → the proven route for this repo,
- `reverted` entries → do **not** retry (didn't clear the gate here).

Repo priors + Callstack guides = faster, sharper routing. Once populated, a new symptom often maps directly to a known preset + fix.

## Write path (accumulate)

Append a line whenever:
- a gap is **discovered** → `status: open`,
- a fix is **validated** (KEEP) → `status: fixed`, commit + measured delta in the ref,
- a fix is **reverted** (didn't clear the gate) → `status: reverted`, ledger ref.

Distill a verbose Ledger entry into one Memory line — the Ledger holds the full distributions; the Memory holds the lesson.

## Compaction policy

- **Merge duplicates** — same file/symptom collapses to the latest status.
- **Archive resolved+verified** — move `fixed` (and stale `reverted`) lines to `.metrognome/archive/perf-memory-<date>.md`; keep `open` items and recent results in the live file.
- Compact when the live file exceeds ~50 lines — it should read like a current to-do + proven-route list, not a full history.

## Bootstrap header

Doctor stamps a new `.metrognome/perf-memory.md` with:

```markdown
# Performance Memory — <repo name>

> metrognome's per-repo brain. One line per perf gap:
> `area/file · symptom · suspected cause · preset · status(open|fixed|reverted) · ref`
> Read at the start of any perf work. Commit this file with the app.

<!-- entries below, newest first -->
```

---

## Playbook (`playbook.md`)

`build_playbook.mjs` distils every completed ledger hypothesis into **`.metrognome/playbook.md`** — the app's measured lab notebook, aggregated by fix pattern:

```
| Preset    | Guide / Fix                                          | Kept / Tried | Effects          |
| listing   | js/optimizing-flatlist (getItemLayout missing …)     | 2/2          | -213 ms, -169 ms |
| re-renders| js/hoist-inline-props (inline-prop hoist)            | 0/1          | below noise band |
```

- **Proven wins** (`kept > 0`) — ranked fix patterns with measured deltas.
- **Dead ends** (`kept = 0`) — patterns that failed to clear the gate in this repo; **do not retry**.

Generate or refresh: `node build_playbook.mjs .metrognome` (or `npm run playbook -- .metrognome`). The script is read-only over ledger files.

**Commit `playbook.md`** with the app; the whole team inherits the measured priors. `playbook.json` (machine-readable) may be gitignored.
