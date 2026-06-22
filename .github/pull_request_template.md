## What & why

<!-- One paragraph: what changes, and what problem it solves. -->

## Checklist

- [ ] `npm test` passes (stats + doctor + playbook self-tests)
- [ ] `npm run smoke` runs clean (perf_scan → build_perf_map → build_run_report)
- [ ] `claude plugin validate . --strict` passes (if manifests changed)
- [ ] `CHANGELOG.md` updated
- [ ] Versions harmonized across `package.json` / `plugin.json` / `marketplace.json` (release PRs only)
- [ ] Docs updated if behavior changed (`README.md`, `CLAUDE.md`, `skills/metrognome/references/`)

<!-- Reminder: never tune detectors against examples/sample-rn-app — the fixture is circular. See CONTRIBUTING.md. -->
