# metrognome — cross-harness anchor

This repo **is** the metrognome plugin itself. For development guidance see `CLAUDE.md`; for setting it up across AI agents see `COMPATIBILITY.md`.

## Using metrognome

The methodology lives in `skills/metrognome/SKILL.md`. Follow it for any React Native / Expo performance work. The skill auto-triggers on performance symptoms ("slow", "jank", "memory leak", "TTI", "re-renders", "bundle size") — you don't need to name "metrognome" explicitly.

Scripts run via:

```bash
npx metrognome@latest <scan|map|report|doctor|playbook|stats|heap> [args]
```

## Perf-memory rule

Before starting any RN performance work in a `.metrognome/`-tracked repo, read and update `.metrognome/perf-memory.md` — it holds per-repo priors on hotspots, proven wins, and dead ends.
