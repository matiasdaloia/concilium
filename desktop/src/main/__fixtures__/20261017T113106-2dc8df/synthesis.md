# Synthesis of run 20261017T113106-2dc8df

Task: sum must reject non-numbers

## Dissent

0 open of 1, also in `dissent.json`.

- **dissent-1** accepted-risk, same-family-judge: claude named the grafts, and is of the base's or a donor's family.
  Evidence: judgment `claude`.
  Accepted risk: no CLI outside the candidates' families (openai, anthropic) is usable, so claude names the grafts.

## Ranking

| Rank | Candidate | Report | New gate failures | Survival | Penalties | Diff | Judge total |
|---|---|---|---|---|---|---|---|
| 1 | `codex` | PASS | 0 | 1/1 | 0 | 5 lines, 1 files | - |
| 2 | `claude` | ISSUES | 1 | none counted | 0 | 4 lines, 2 files | - |

Winner: `codex`: best on the evidence.

## Base

`codex` at `a65ce8ac9636ae20fc4f04ca9af4bdef557c37c5` (best on the evidence).

Grafts named by `claude`, a same-family picker: no CLI outside the candidates' families (openai, anthropic) is usable, so claude names the grafts.

## Applied grafts

- **graft-1** from `claude` (`sum.test.js`): Take its sum.test.js. Why: The base has no test. Commit `a4c32dcdc964f315840bf7a97ca0c58308b3099f`.

## Rejected grafts

None.

## Dropouts

None.

## Checks at the integration head

At `a4c32dcdc964f315840bf7a97ca0c58308b3099f`:

- gate lint: pass
- gate test: pass
- adversarial test anthropic-1: pass

## Result

- Integration branch: `concilium/20261017T113106-2dc8df/integration` at `a4c32dcdc964f315840bf7a97ca0c58308b3099f`
- Patch: `/tmp/m92-44Kh1m/data/concilium/runs/20261017T113106-2dc8df/result.patch` (`1f22c0dbe464..a4c32dcdc964`)
- Mergeable: yes, `git apply --check` against `HEAD` at `1f22c0dbe4640c6fe8f5acdeaf34265edf21ce74`
