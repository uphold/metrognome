# Experiment Ledger — {{preset}} on {{target}}

- **Run:** {{timestamp}}
- **Repo / commit baseline:** {{repo}} @ {{baseline_sha}}
- **Metric:** {{metric}} ({{direction}}-is-better, unit {{unit}})
- **Protocol:** N={{n}} runs, 1 warm-up discarded, identical workload ({{workload}})
- **Tools:** drive={{drive_tool}}, measure={{measure_tool}}

## Baseline
- runs: {{baseline_runs}}
- mean ± stddev: {{baseline_mean}} ± {{baseline_std}}

## Hypotheses

### H1 — {{hypothesis}}
- **Guide:** {{guide}}
- **Change (atomic):** {{change_description}}  ({{files_touched}})
- **Candidate runs:** {{candidate_runs}}
- **mean ± stddev:** {{candidate_mean}} ± {{candidate_std}}
- **Gate:** improvement {{improvement}} vs noise band {{noise_band}} (max of min_effect {{min_effect}}, k·pooled_std {{k_pooled}})
- **Decision:** {{KEEP|REVERT}}
- **Commit / revert:** {{commit_sha_or_reverted}}
- **Memory line distilled:** `{{memory_line}}`

<!-- repeat ### H2, H3 … one atomic hypothesis each; never stack fixes in one entry -->

## Result
- **Kept:** {{kept_summary}}
- **Net delta vs baseline:** {{net_delta}}
- **Commits:** {{commit_list}}
- **Reverted dead-ends (don't retry):** {{reverted_list}}
