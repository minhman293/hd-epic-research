# Episode-layer ablation

Decision rule fixed before the run: keep if any condition exceeds **0.6**, reframe if none reaches **0.45**.


## P01_R01

| condition | what changed | consistency | object purity | head modal | states | mean size | coverage |
|---|---|---|---|---|---|---|---|
| `baseline` | current pipeline | **0.307** | 0.470 | 0.310 | 10 | 7.8 | 1.00 |
| `A_object` | reach by object, not by 12 s | **0.311** | 0.476 | 0.310 | 10 | 7.8 | 1.00 |
| `B_nocap` | 8-member cap removed | **0.307** | 0.468 | 0.321 | 9 | 8.0 | 1.00 |
| `C_nosynth` | synthetic anchors removed | **0.269** | 0.465 | 0.310 | 10 | 7.8 | 1.00 |
| `D_nofold` | one-off folding removed | **0.412** | 0.558 | 0.327 | 29 | 4.1 | 1.00 |

**Verdict:** REFRAME — no condition exceeds 0.41 < 0.45. The variation is in the behaviour, not the rule (Reading 1). The layer describes variation and must not be called a skill representation.


## P03_R03

| condition | what changed | consistency | object purity | head modal | states | mean size | coverage |
|---|---|---|---|---|---|---|---|
| `baseline` | current pipeline | **0.340** | 0.488 | 0.384 | 41 | 5.2 | 1.00 |
| `A_object` | reach by object, not by 12 s | **0.350** | 0.551 | 0.431 | 42 | 5.2 | 1.00 |
| `B_nocap` | 8-member cap removed | **0.298** | 0.463 | 0.309 | 30 | 6.8 | 1.00 |
| `C_nosynth` | synthetic anchors removed | **0.325** | 0.463 | 0.336 | 36 | 6.1 | 1.00 |
| `D_nofold` | one-off folding removed | **0.367** | 0.522 | 0.413 | 66 | 4.4 | 1.00 |

**Verdict:** REFRAME — no condition exceeds 0.37 < 0.45. The variation is in the behaviour, not the rule (Reading 1). The layer describes variation and must not be called a skill representation.


## P05_R02

| condition | what changed | consistency | object purity | head modal | states | mean size | coverage |
|---|---|---|---|---|---|---|---|
| `baseline` | current pipeline | **0.336** | 0.431 | 0.261 | 25 | 6.2 | 1.00 |
| `A_object` | reach by object, not by 12 s | **0.297** | 0.473 | 0.315 | 25 | 6.2 | 1.00 |
| `B_nocap` | 8-member cap removed | **0.342** | 0.340 | 0.159 | 19 | 8.3 | 1.00 |
| `C_nosynth` | synthetic anchors removed | **0.302** | 0.388 | 0.175 | 22 | 7.2 | 1.00 |
| `D_nofold` | one-off folding removed | **0.360** | 0.508 | 0.333 | 58 | 4.2 | 1.00 |

**Verdict:** REFRAME — no condition exceeds 0.36 < 0.45. The variation is in the behaviour, not the rule (Reading 1). The layer describes variation and must not be called a skill representation.

