# metrognome CI Autopilot — Adoption Guide

Drop one of these workflows into your RN repo and metrognome runs weekly as a headless
performance engineer: scans your repo → picks the top debt findings → applies and measures
fixes → opens a PR showing exactly what changed and why.

---

## Which template?

| | Device-free (`metrognome-autopilot.yml`) | Device (`metrognome-autopilot-device.yml`) |
|---|---|---|
| **Measures** | Bundle size (bytes) | Bundle size + FPS, re-renders, RAM, TTI |
| **Preset coverage** | `bundle-size` only | All 5 presets |
| **Runner** | `ubuntu-latest` (any) | `ubuntu-latest` with KVM + Android emulator |
| **Runtime** | ~15–20 min | ~35–45 min |
| **Reliability** | High | Can flake on emulator boot |
| **Typical monthly cost** | ~$0.50–$2 API + ~20 Actions min | ~$2–$6 API + ~45 Actions min |

**Start with the device-free template.** `barrelImport` (the main bundle-size detector) is
one of the most reliably actionable findings in RN codebases and needs no device. Upgrade to
the device template when you want to measure scroll jank, re-renders, memory leaks, or TTI.

---

## Quickstart (device-free)

```bash
# 1. Copy the workflow
cp metrognome-autopilot.yml .github/workflows/

# 2. Add repo secret
#    GitHub repo → Settings → Secrets → Actions → New secret
#    Name: ANTHROPIC_API_KEY   Value: sk-ant-...

# 3. Enable PR creation by Actions
#    Settings → Actions → General → Workflow permissions
#    ✓ "Allow GitHub Actions to create and approve pull requests"

# 4. Edit the workflow — replace plugin_marketplaces URL
#    Default: https://github.com/uphold/metrognome.git
#    Recommended: pin to a tag, e.g. https://github.com/uphold/metrognome.git@v0.2.2

# 5. Trigger manually to verify before the first scheduled run
#    GitHub repo → Actions → "metrognome perf autopilot (weekly)" → Run workflow
```

A PR will appear on your repo (or a clean exit in the logs if no fix cleared the gate).

---

## Configuration

### Tuning the workflow inputs

In the YAML `workflow_dispatch.inputs` block and the job's `env:` section:

| Variable | Default | What it does |
|---|---|---|
| `top_findings` | `3` | How many top bundle-size findings to attempt per run |
| `max_iters` | `4` | Hard cap on total iterations (also honored via `.metrognome/config.json` `budget`) |
| `custom_prompt` | *(blank)* | Run a specific goal instead of top-X (see below) |

### Running a specific goal (custom_prompt)

By default the autopilot picks the top-X bundle-size findings from the Perf Map.
To target something specific instead, set a goal:

**Manual dispatch:** fill the `custom_prompt` input field when you trigger the workflow.

**Scheduled cron (fixed goal every week):** set a [repo variable](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/store-information-in-variables) named `METROGNOME_GOAL`:

```
GitHub repo → Settings → Variables → Actions → New repository variable
Name: METROGNOME_GOAL
Value: reduce bundle size on the onboarding flow
```

The workflow picks this up via `vars.METROGNOME_GOAL`. A manual dispatch input overrides it.

Examples:
- `"reduce bundle size in the checkout screens"`
- `"fix scroll jank on the home feed"` *(device template only — needs measurement)*
- `"remove barrel imports from the auth module"`

**Constraint (device-free template):** only `bundle-size` goals can be measured without a
device. If the custom goal requires device metrics, the autopilot will note this in the PR
body and will not apply an unmeasured fix.

### .metrognome/config.json

If your repo has a `.metrognome/config.json` (bootstrapped by Doctor), its values take
precedence over the workflow inputs:

```json
{
  "budget": 4,
  "k": 2,
  "runs": 5
}
```

Run `/metrognome` → **Configurations** to edit this interactively.

### Tuning the gate floor

The device-free template uses `--min-effect 5000` bytes (~5 KB) as the absolute improvement
floor. Changes smaller than this are reverted even if statistically significant, because a
5 KB delta is too small to notice in practice. To lower or raise this, edit the `--min-effect`
value in the `prompt:` block.

---

## PR gotchas — read before deploying

### 1. Allow GitHub Actions to create PRs (required)

`gh pr create` fails with 403 unless you enable it in **Settings → Actions → General →
Workflow permissions → Allow GitHub Actions to create and approve pull requests**. This is
off by default on new repos.

### 2. PRs opened with `github.token` don't trigger downstream CI

If you rely on your CI running on the autopilot PR (e.g., to run tests before merge),
this won't happen with the default `GITHUB_TOKEN` — GitHub intentionally prevents
Actions-created events from cascading. To fix:

- Use a [fine-grained PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)
  with `contents: write` and `pull-requests: write` scopes, added as a repo secret.
  Replace `${{ github.token }}` with `${{ secrets.MY_PAT }}` in the `env:` block.
- Or install the [Claude GitHub App](https://github.com/apps/claude) which uses its own token.

---

## Device template setup (additional steps)

1. Confirm your app builds and runs on Android (test locally first).
2. Ensure your repo's `package.json` has `react-native` as a dependency.
3. The emulator runner requires KVM — `ubuntu-latest` on GitHub-hosted runners has KVM
   available since 2024. Self-hosted runners may need `sudo apt-get install qemu-kvm`.
4. Metro is started on port 8081 and `agent-react-devtools` on port 8097.
   If your app uses a different Metro port, add `--port` to the start command.
5. Expect the first run to take longer (emulator cold boot ~5 min).

---

## Cost estimate

Both templates run `claude-sonnet-4-6` with `--max-turns 80` (device template: 100).
Rough estimates per weekly run:

| | Actions minutes | API input tokens | API output tokens |
|---|---|---|---|
| Device-free | ~20 min | ~200K | ~10K |
| Device | ~45 min | ~400K | ~20K |

At current pricing (June 2026), a device-free weekly run costs roughly $1–3 in API tokens.
Set `--max-turns` lower to cap token spend; set it higher if the agent reports hitting the limit.

GitHub Actions: ubuntu-latest is billed at 2× the base minute rate for private repos.
Public repos get free Actions minutes.

---

## Verification (first-time adopters)

1. Trigger via `workflow_dispatch` with a small `top_findings=1 max_iters=2`.
2. Watch the Actions log — the agent prints what it found, what it tried, and the gate verdict.
3. If a PR opens, check that the gains table has real numbers (no placeholder text).
4. If no PR: check the log for "no bundle-size findings" or "no improvements cleared the gate"
   — both are valid clean exits.

---

## Real validation (the true end-to-end test)

Run in an actual RN repo with `workflow_dispatch` → confirm a PR appears with a populated
gains table. This is the natural pitch demo for metrognome's autonomous persona.

---

## Slash-command namespacing note

The metrognome plugin is invoked via instructions in the `prompt:` field. If you want to
invoke it via a slash command instead (e.g. `/metrognome bundle-size`), the correct form
in `claude-code-action` automation mode may be `/metrognome:metrognome` or `/metrognome`
depending on the action version. Test with `workflow_dispatch` before relying on it.

---

## Optional follow-up (not in this template)

Extract the headless rules and PR-body format into a versioned
`skills/metrognome/references/ci-autopilot.md` + add a `topFindings` key to `DEFAULT_CONFIG`
in `doctor.mjs`. This keeps the two YAMLs DRY and the behavior under version control.
Deferred because these are templates — teams should be able to edit them directly.

Other CI platforms (GitLab CI, Bitbucket Pipelines) and model providers (Bedrock, Vertex)
are not built here, but the prompt is portable: the logic is the same, only the action
wrapper changes.
