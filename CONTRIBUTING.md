# Contributing to metrognome

Thanks for helping make metrognome better! This repo **is** the Claude Code plugin itself — not an RN app that uses it. Contributions land here as plain Node scripts, markdown skill files, and JSON manifests; there is no build step.

## Dev setup

- **Node ≥ 18** (ESM throughout — every script is `.mjs`).
- `npm install` in the repo root (deps: `@babel/parser`, `@babel/traverse`, `ws`).

## Test surface

Run all of these before opening a PR:

```bash
npm test                            # self-tests: stats (gate math) + doctor parser + playbook
npm run smoke                       # offline chain: perf_scan → build_perf_map → build_run_report
claude plugin validate . --strict   # official plugin manifest validation (CI runs this too)
```

CI (`.github/workflows/ci.yml`) runs the same surface on Node 18.x and 20.x. The live path (metro-mcp / real device / MCP runtime) cannot be CI-tested — if your change touches it, describe your manual verification in the PR.

## Critical rules

These three rules are load-bearing — PRs that break them will be asked to change:

1. **Never tune detectors against `examples/sample-rn-app`.** The fixture is circular — it contains exactly what the detectors hunt, so any tuning against it is self-confirming. Tune `perf_scan.mjs`'s `CONFIG` block against a real OSS RN app (e.g. bluesky's social-app) and read `skills/metrognome/references/perf-map.md` first.
2. **Version harmony.** The version must match across `package.json`, `.claude-plugin/plugin.json`, and the plugin entry in `.claude-plugin/marketplace.json`. Bump all three or none. After a version bump, run `npm publish` so the npm package stays in sync.
3. **`skills/metrognome/references/tools.md` is the single source of truth for tool command surfaces.** When agent-device, agent-react-devtools, or metro-mcp changes its CLI/API, update it there — nowhere else. SKILL.md instructs the agent to read it before invoking any tool.

## Release process (maintainers)

1. Bump the version in all **three** manifests (rule 2 above).
2. Add a section to `CHANGELOG.md`.
3. Tag (`git tag vX.Y.Z`) and push the tag.
4. Create the GitHub release from the tag, with the changelog section as the body.

## Reporting bugs

Use the bug-report issue form — it asks for `doctor.mjs` output, which is the fastest way for us to see your toolchain state.
