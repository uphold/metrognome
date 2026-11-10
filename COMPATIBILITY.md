# Cross-harness compatibility

metrognome's engine (7 Node scripts, the `SKILL.md` methodology) is harness-agnostic. This document covers setup for **Codex CLI · Cursor · Gemini CLI · GitHub Copilot CLI** alongside the primary **Claude Code** path.

## Honest limitations

1. **No universal one-command install.** "Multi-agent" means one portable bundle (skill + scripts) installed once per harness through its own conventions — not a single `/plugin` that works everywhere.
2. **Hooks don't port.** The Claude Code `SessionStart` hook (auto-installs npm deps) is replaced by `npx` (auto-fetches deps and their transitive deps). The `UserPromptSubmit` perf-memory nudge lives in `AGENTS.md` instead; Gemini CLI has no prompt-submit hook, so it's best-effort there.
3. **`/metrognome` slash command is Claude Code-only.** On other harnesses the skill auto-triggers on perf symptoms ("slow", "jank", "memory leak", "TTI") without the word "metrognome".

---

## 1. Skill

Copy or symlink `skills/metrognome/` into your harness's skills directory:

| Harness | Project-level skills dir | Global skills dir |
|---|---|---|
| **Claude Code** | bundled (plugin install) | `~/.claude/plugins/metrognome/` |
| **Codex CLI** | `.agents/skills/` | `~/.codex/skills/` |
| **Cursor** | `.agents/skills/` | `~/.cursor/skills/` |
| **Copilot CLI** | `.agents/skills/` | `~/.copilot/skills/` |
| **Gemini CLI** | `.gemini/skills/` | `~/.gemini/skills/` |

Example (global install from a local clone):
```bash
ln -s /path/to/metrognome/skills/metrognome ~/.codex/skills/metrognome
```

The skill's `description:` field already contains keywords that trigger it on perf symptoms — no manual invocation needed.

---

## 2. Scripts

The live loop drives everything through agent-device — install it globally: `npm i -g agent-device` (on Claude Code, Doctor does this for you).

Run any script without cloning:

```bash
npx metrognome@latest scan   <rn-app>   --out graph.json
npx metrognome@latest map    graph.json --out perf-map.html --open
npx metrognome@latest report run-state.json --out report.html
npx metrognome@latest doctor
npx metrognome@latest stats  --baseline "1200,1180" --candidate "980,990" --min-effect 30 --k 2 --direction lower --unit ms
npx metrognome@latest heap   --cycles 5
npx metrognome@latest playbook .metrognome/ledger/
```

First run downloads the package and its deps; subsequent runs use the npx cache. Pass `--help` to any subcommand for its usage.

---

## 3. Instruction file

`AGENTS.md` (this repo root) is natively read by Codex, Cursor, and Copilot CLI. For Gemini CLI, add it to `context.fileName` in `~/.gemini/settings.json`:

```json
{
  "context": {
    "fileName": ["GEMINI.md", "AGENTS.md"]
  }
}
```

---

## Claude Code users

Nothing changes. `$CLAUDE_PLUGIN_ROOT` is set in every plugin session, so the skill resolves scripts from the bundled copy — offline, zero network latency, exactly as before.

---

## Device & runtime constraints

### iOS Simulator FPS blind spot

Displayed-frame **FPS** is unavailable on iOS Simulator (Apple constraint — Simulator renders on the host GPU, not the device GPU). Every other signal works on Simulator: JS heap, re-renders, longtask jank, TTI, CPU/RAM. For accurate FPS numbers, use **Flashlight** (Android) or **Instruments / XCTest** on a real iOS device.

### RN < 0.85: one CDP connection

On RN < 0.85 only one debugger client can be connected at a time. **Close all RN DevTools / Fusebox windows** before running `agent-device cdp` / `react-devtools`, and never run `heap_sample.mjs` alongside them.

