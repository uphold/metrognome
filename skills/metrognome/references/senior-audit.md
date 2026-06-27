# Senior Engineer Audit — Mode Protocol

**Mode 5 of the metrognome menu.** A holistic, standalone scan where metrognome reasons like
a staff RN performance engineer. Device-free scan; fix handoff reuses the measure→gate loop.

---

## Invariants (must not be violated)

- **Hypotheses, never verdicts.** Every finding is a ranked, unproven hypothesis until the gate
  runs. Nothing enters `perf-memory.md` as a proven fact until the gate confirms it.
- **Signal-vs-noise.** Emit few, high-confidence findings. Each must have a concrete `file:line`,
  blast radius, expected user-perceived cost above the thresholds in `architectural-perf-catalog.md`
  (>16ms real; <1ms = do not report). Suppress leaf noise.
- **Root-cause, not surface area.** Rank by blast radius (fan-in × architectural role):
  root wrappers/providers > root navigator > shared base components > leaf components.
  One root fix beats fifty leaf fixes.
- **It fixes — it doesn't just file.** The audit ends in a choose-and-fix flow (AskUserQuestion
  menu → measure→gate loop for provable findings). A dropped report alone is not enough.
- **No new mechanical extractors.** The brain reads source and reasons; it does not write new
  AST detectors.

---

## Protocol

### Step 1 — Grounding

- Check that `react-native-best-practices` is installed (Doctor reports if absent). If absent: proceed on catalog reasoning alone, note "Callstack guide `<slug>` not installed" per finding, and nudge: "Run `/plugin install react-native-best-practices@callstack-agent-skills` to install."
- Read the Callstack guides relevant to the anti-patterns being investigated (slugs in
  `architectural-perf-catalog.md`).
- Read `references/architectural-perf-catalog.md` (the reasoning corpus).
- Read `.metrognome/perf-memory.md` for known priors (skip already-proven gaps).
- Read `.metrognome/playbook.md` if present (dead ends to avoid).

---

### Step 2 — Substrate + Root-Cause Ranking

Produce or reuse `graph.json` (run `$MG scan <repo> --out graph.json` if absent or stale):

```bash
$MG scan <repo-root> --out graph.json
```

Parse `graph.json` for hub nodes (high centrality / fan-in). These are the blast-radius
candidates — the brain layers architectural role on top of the static fan-in score.

**Identify structural roots by reading source:**

| Target | What to look for | Architectural role |
|---|---|---|
| Entry (`App.tsx` / `index.js`) | Providers, HOCs, global listeners | Root wrapper — every screen below it |
| Root navigator (`RootNavigator.tsx`, etc.) | Eager screen imports, lazy boundaries | Root navigator — all screens |
| Provider stack | Context `value=` shape, update frequency | Root provider — all consumers |
| High-fan-in modules (from graph.json) | Shared base components, hooks, utilities | Shared base — blast radius = consumer count |

**Rank candidates by blast radius:**

```
blast_radius = fan_in × role_weight
role_weight: root_wrapper=10 · root_navigator=8 · root_provider=7 · shared_base=fan_in · leaf=1
```

Read the top-ranked source files first. No more than 5–7 candidates per audit to stay signal-sharp.

---

### Step 3 — Reason

For each candidate (highest blast radius first):

1. Read the source file(s) completely.
2. Reason against each applicable entry in `architectural-perf-catalog.md` and the Callstack guides.
3. Cross-file data-flow: trace where state is declared vs where it is consumed. Does it cross
   more component boundaries than necessary? Does a context value object change reference more
   often than its consumers need?

**Reasoning discipline:** do not flag something unless you can state a concrete `file:line`,
a plausible user-perceived cost above the thresholds, and a specific catalog entry that
describes the pattern.

---

### Step 4 — Signal-vs-Noise Gate

Before including a finding in the report:

- **Has a concrete code path** (`file:line` or `file:line-range`).
- **Has a blast radius** — how many screens / components / users are affected.
- **Expected cost > 16ms** or is a Long Task (≥50ms) risk, OR is a structural root-cause
  finding in a component with blast radius ≥ 5 (the scale factor compensates for lower
  individual cost).
- **Not already in `perf-memory.md`** as a proven fix or a dead end.
- **Not a leaf component** unless the blast radius is unusually high.

If a finding fails these checks, suppress it. Aim for ≤8 findings total; 3–5 is ideal.

---

### Step 5 — Emit Ranked Hypotheses

Each finding in the report:

```markdown
## Finding N — <Short Title>                       [BLAST RADIUS: <n> screens/consumers]

**File:** `path/to/file.tsx:line`
**Catalog entry:** <number + title> (architectural-perf-catalog.md)
**Callstack guide:** `<slug>` (react-native-best-practices)
**Confidence:** High / Medium
**Expected cost:** <e.g. "re-renders Header + Sidebar + Footer on every keystroke (3 components,
  ~40ms/frame budget consumed)">
**Gate preset:** `re-renders` — gate command:
  `$MG stats --baseline "..." --candidate "..." --min-effect 20 --direction lower --unit ms`
  *(or "Advisory — not auto-provable: <reason>")*

<2–3 sentence explanation of the architectural problem and why it costs the user.>
```

Mark advisory findings explicitly. Advisory does not mean unimportant — it means the gate
cannot confirm the fix automatically; the user must apply and judge manually.

---

### Step 6 — Write Report + Present Menu

Write the full ranked hypothesis report to:
```
<repo>/.metrognome/audit/<ISO-timestamp>.md
```

Then present the findings as an **AskUserQuestion** multi-select menu.

**AskUserQuestion accepts at most 4 options.** Present the top 4 findings by blast radius as the choices; if more than 3 actionable findings exist, bundle the remainder as a 4th option ("Remaining findings — I'll review the full report"). Follow up with a second menu for the bundled remainder if the user selects it.

> "I found N architectural findings ranked by blast radius. Which of the top findings would you like me to
> investigate and fix now? (I'll apply the fix and prove it through the gate for provable ones;
> advisory findings are applied and flagged for your eyes-on review.)"

Options (example — substitute actual finding labels):
- Finding 1 — State too high in FeedRoot [blast: 6 screens]
- Finding 2 — Root Provider referential instability [blast: 4 screens]
- Finding 3 — Navigator eager-loading [blast: all screens]
- "Skip all — I'll review the report and decide later" (always present as the final option)

The user's selection drives Step 7. Skipped / unselected findings remain as `- [ ] (hypothesis, ungated)` gaps in `perf-memory.md`.

---

### Step 7 — Fix & Prove (the loop)

For each finding the user chose to act on:

**If the finding maps to a gate preset** (`re-renders`, `first-load`, `listing`, `bundle-size`):
1. Propose and apply the fix (one atomic change).
2. Bring up a live session if needed (skip for `bundle-size` — build-time only).
3. Enter the **existing measure→gate loop** (same as Autoresearch):
   - N-run baseline → apply fix → N-run candidate → `$MG stats` gate decision.
   - KEEP: commit with measured delta; write a `- [x]` proven fact to `perf-memory.md`.
   - REVERT: restore from pre-fix snapshot; write `- [ ] (hypothesis, disproved)` to `perf-memory.md`.

**If the finding is advisory-tier** (no auto-gate):
1. Apply the fix.
2. Surface it clearly to the user: "Applied. This is an advisory finding — no gate can confirm
   it automatically. Please verify manually and confirm if it feels better."
3. Write `- [ ] (hypothesis, ungated — applied)` to `perf-memory.md`.
4. Do NOT write it as `- [x]` until the user explicitly confirms the improvement.
5. If the user confirms improvement: update the entry to `- [x]` in `perf-memory.md`.

**perf-memory.md status codes:**
- `- [x]` — gate-confirmed improvement (measured fact)
- `- [ ] (hypothesis, ungated)` — declined or not yet actioned
- `- [ ] (hypothesis, ungated — applied)` — advisory fix applied, awaiting confirmation
- `- [ ] (hypothesis, disproved)` — gate ran, fix did not clear the noise band

---

## Example Blast-Radius Calculation

```
ThemeProvider  fan-in=47  role=root_provider   blast=47×7=329  → read first
AppNavigator   fan-in=1   role=root_navigator  blast=1×8=8     → read second
FeedListItem   fan-in=1   role=leaf            blast=1×1=1     → skip unless obvious finding
```

Fixing `ThemeProvider` (fan-in=47) outranks any leaf fix, even if per-render cost is higher in the leaf.
