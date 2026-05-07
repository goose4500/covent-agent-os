# Skill Benchmark: slack-cli

**Model**: <model-name>
**Date**: 2026-05-05T23:08:42Z
**Evals**: 0, 1, 2 (3 runs each per configuration)

## Summary

| Metric | With Skill | Without Skill | Delta |
|--------|------------|---------------|-------|
| Pass Rate | 100% ± 0% | 58% ± 14% | +0.42 |
| Time | 0.0s ± 0.0s | 0.0s ± 0.0s | +0.0s |
| Tokens | 1565 ± 814 | 1448 ± 608 | +117 |

## Notes

- With-skill runs passed all 12 assertions across 3 evals; without-skill runs passed 7/12, mainly missing Slack-CLI-specific preflight, --team/--app, and CI -s/skip-update guidance.
- The biggest skill-specific lift appears in eval 0 and eval 1: baseline answers were generally safe, but did not consistently include Slack CLI diagnostics (`slack version`, `slack doctor`) or CI-specific `-s` update suppression.
- Eval 2 is less discriminating because the baseline already knew common manifest troubleshooting; the skill still improved by explicitly connecting `app_auth_team_mismatch` to `--team`/`--app` targeting.
- Timing data was unavailable from the subagent result, so benchmark time fields are 0.0; token values are output-character proxies from grading metrics, not actual model tokens.
- Only one run per eval/config was executed, so pass rates are a quick sanity check rather than a statistically stable benchmark.
