# Changelog

## v0.2.6 — 2026-07-23

### Added
- **Screen tracking memory** — Doctor now bootstraps `.metrognome/screen-map.md`, a per-repo navigation brain documenting launch, auth, and route steps to each screen (committed with the app; secrets referenced by `$NAME`, never inlined), plus `.metrognome/secrets.local.json` (gitignored, seeded `{}`) to hold the actual values. New reference doc: `skills/metrognome/references/navigation.md`.

---

## v0.2.5 — 2026-06-13

### Fixed
- `package.json` `repository.url` now has the `git+https://` prefix npm requires — eliminates the publish warning.
- README: added `npm` (version) and `npm downloads` (monthly) badges linking to the package page.

---

## v0.2.4 — 2026-06-13

### Added
- **npm package** — metrognome is now published to npm (`npx metrognome@latest`). `bin/metrognome.mjs` is a thin subcommand dispatcher (`scan · map · report · playbook · stats · doctor · heap`) that resolves scripts via `import.meta.url` — no path assumptions, works anywhere.
- **Cross-harness compatibility** — scripts now run on OpenAI Codex CLI, Cursor, Gemini CLI, and GitHub Copilot CLI via `npx metrognome@latest <cmd>`. `SKILL.md` resolves the runner at session start: bundled local copy when `$CLAUDE_PLUGIN_ROOT` is set (Claude Code, zero latency, no network), `npx` otherwise. Claude Code behavior is identical to before.
- **`AGENTS.md`** — cross-harness instruction anchor natively read by Codex/Cursor/Copilot; contains the perf-memory rule (replaces the UserPromptSubmit hook nudge on non-CC harnesses).
- **`COMPATIBILITY.md`** — per-harness setup guide: MCP server JSON/TOML config for Cursor/Gemini/Copilot/Codex, skill directory table, `npx` script reference, Gemini `context.fileName` note.
- **`package.json`**: `bin`, `files` allowlist (tarball is ~417 KB), `prepublishOnly: npm test`, added harness keywords (`codex`, `cursor`, `gemini-cli`, `copilot`, `ai-agent`). Removed `"private": true`.

### Changed
- `SKILL.md` "Locating scripts" section rewritten with the harness-agnostic `$MG` resolver; all command blocks converted from `node "${CLAUDE_PLUGIN_ROOT}/…/<script>.mjs"` to `$MG <subcommand>`.
- `references/measurement.md`: one `stats.mjs` invocation converted to `$MG stats`.
- `CONTRIBUTING.md`: version harmony note now includes `npm publish` step.
- `README.md`: one cross-harness sentence after the tagline; compact "Other agents" install subsection linking to `COMPATIBILITY.md`.

---

## v0.2.3 — 2026-06-10

### Added
- **GitHub Pages live demo** (`.github/workflows/pages.yml` + `docs/pages/index.html`) — builds the 3D Perf Map from a real scan of `bluesky-social/social-app` at a pinned SHA (methodology example, clearly attributed) plus the sample-run report, deployed to https://uphold.github.io/metrognome/. No generated HTML committed to main.
- **CI: official plugin validation** — `claude plugin validate . --strict` now runs in CI alongside the hand-rolled JSON checks.
- **Community files** — `CONTRIBUTING.md` (dev setup, test surface, critical contributor rules, release process), bug-report and feature-request issue forms, PR template.

### Fixed
- `marketplace.json` was missing a top-level `description` — `claude plugin validate . --strict` failed; now passes.
- `perf_scan.mjs` printed a raw `ERR_MODULE_NOT_FOUND` stack when Babel deps were missing (silent SessionStart `npm install` failure) — now exits with one actionable remediation line.
- README: badges added (CI · release · license · live demo), intro paragraph tightened, live-demo links under the Perf Map screenshot, `doctor:test` alias in the scripts table.
- CLAUDE.md drift: playbook/doctor/smoke/test commands, `heap_sample.mjs` + `build_playbook.mjs` + `templates/ci/` + workflows + `docs/pages/` in the layout, `.metrognome/playbook.md` in the bootstrap list.
- Plugin metadata enriched: `plugin.json` ($schema, author email/url, Pages homepage, tightened description) and `marketplace.json` plugin entry (author, homepage, repository, license, keywords, category, tags).

---

## v0.2.2 — 2026-06-10

### Added
- **Performance Playbook** (`scripts/build_playbook.mjs`) — distils `.metrognome/ledger/*.md` into `playbook.md` + `playbook.json`: "proven wins" and "dead ends" aggregated across runs. SKILL.md now reads the playbook before baseline to skip already-tried patterns. `npm run playbook` / `npm run playbook:test` aliases added.
- **Metric trajectory trend chart** in the live run report — SVG step-line of the committed metric across iterations, KEEP/HOLD dots, ghost markers for rejected candidates, gradient fill, and endpoint labels.

### Fixed
- Hero image link in README (`docs/perf_map.png` → `docs/perf-map.png`).
- Version harmonized to `0.2.2` across `package.json`, `plugin.json`, and `marketplace.json`.
- CI workflow now uses `npm ci` (package-lock.json was already committed).
- README: removed stale placeholder comment, added founder context and origin section.

---

## v0.2.1 — 2026-06-07

### Added
- **Session-recovery onboarding** — Doctor restores `.metrognome/` context on session restart.
- **CI Autopilot templates** (`templates/ci/`) — device-free and device GitHub Actions workflows for weekly autonomous performance runs.
- **Standalone plugin logo** (`docs/logo*.png/svg`) — works without the banner.

### Fixed
- Run-report JSON guard for invalid state; `</script>` literal escape in inline JSON block.

---

## v0.2.0 — 2026-06-02

### Added
- **Light theme for Perf Map** — white canvas, performance-green accent (`#16a34a`), severity colors tuned for white. Canonical palette applied identically across all assets.
- **Banner** (`docs/banner.svg/png`) — equalizer mark + wordmark with green **g** accent + tagline.
- **Configurations menu (item 4)** — view/edit `.metrognome/config.json` from within `/metrognome`.
- **Configurable commit mode** — Autoresearch asks commit mode + live-report preference before running (pre-filled from config). End-of-run: `per-iteration` · `one-commit` (squash) · `no-commit` (leave staged).
- **Live run report** (`assets/report.template.html` + `scripts/build_run_report.mjs`) — auto-refreshing HTML dashboard showing KEEP/REVERT cards, distributions, net delta. `npm run report` alias.
- **Sample run-state** (`assets/run-state.sample.json`) — offline pitch demo (3 KEEP, 2 REVERT).
- **Doctor bootstraps `config.json` and `.metrognome/.gitignore`** on first `--init`.
- **Four pitch diagrams** (`docs/diagrams/`) — `loop`, `orchestration`, `gate`, `signal-vs-noise` — SVG + PNG, canonical palette.

### Changed
- README: banner at top, orchestration diagram replaces ASCII block, loop/gate/signal-vs-noise diagrams embedded, modes table updated to 4 items, commit language softened.
- SKILL.md: 4-item menu, run-options prompt, loop rewritten with commit-mode transform step, discipline rules softened, Doctor + reference index updated.
- `commands/metrognome.md`: Configurations routing added.
- `docs/perf-map.png`: regenerated from a real RN app scan under the light theme.

---

## v0.1.0 — 2026-06-02

Initial release (private).

- Static RN perf scan with ten Babel AST detectors (`perf_scan.mjs`)
- Offline 3D Perf Map — interactive force-graph, no device needed (`build_perf_map.mjs`)
- Statistical gate for KEEP/REVERT decisions — N-run mean ± stddev (`stats.mjs`)
- Doctor preflight: toolchain checks, Babel dep resolution, `.metrognome/` bootstrap
- Five Autoresearch presets: `first-load`, `listing`, `memory-leaks`, `bundle-size`, `re-renders`
- Per-repo Performance Memory (`.metrognome/perf-memory.md`)
- SessionStart hook auto-installs npm deps; UserPromptSubmit hook nudges memory consultation
- Sample fixture with seeded anti-patterns (`examples/sample-rn-app`)
