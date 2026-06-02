---
name: metrognome
description: The autonomous performance engineer for React Native. Open the metrognome menu (Autoresearch / Perf Map 3D / Doctor), or pass a preset/target/natural-language goal to skip straight to work.
argument-hint: "[first-load|listing|memory-leaks|bundle-size|re-renders] [--target <Screen/Component>] | <natural-language goal>"
---

metrognome routes React Native performance work through metro-mcp and Callstack's tools (agent-device, agent-react-devtools, react-native-best-practices), runs a scientific propose → measure → keep/revert loop, builds a 3D Perf Map, and maintains per-repo performance memory.

Read `${CLAUDE_PLUGIN_ROOT}/skills/metrognome/SKILL.md` now and follow it.

ARGUMENTS: $ARGUMENTS

Routing:
- **No arguments** → present the top menu (Autoresearch / Perf Map 3D / Doctor / Configurations) per SKILL.md's menu rules.
- **A preset name** (`first-load`, `listing`, `memory-leaks`, `bundle-size`, `re-renders`), optionally with `--target` → skip the menu and run that Autoresearch preset.
- **Natural language** (e.g. "fix jank on the feed list", "the app is slow to start") → map to the closest preset/target and confirm before running the loop.
- **`config` or `configurations`** → open the Configurations menu (view/edit `.metrognome/config.json`).

Before doing anything else, run the Doctor preflight (tools present, Metro session live, auto-fix setup, git scoped to metrognome's own changes, performance memory loaded).

Note: if running scripts outside a Claude session, run `npm install` in the plugin root first.
