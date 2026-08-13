# Readability result

`readable` = the reader named the same goal the label names. `head wrong` = they named a different action in the group, so the grouping held but the name did not. `not coherent` = the grouping itself failed.


## By level

| level | n | readable | head wrong | not coherent | unsure |
|---|---|---|---|---|---|
| hybrid | 18 | 100% | 0% | 0% | 0% |
| full | 18 | 100% | 0% | 0% | 0% |
| episode | 60 | 38% | 7% | 45% | 10% |
| step | 18 | 17% | 22% | 56% | 6% |

## Episodes: synthetic vs real anchors

| anchor type | n | readable | head wrong | not coherent | unsure |
|---|---|---|---|---|---|
| real anchor | 46 | 39% | 7% | 43% | 11% |
| synthetic | 14 | 36% | 7% | 50% | 7% |

## Episodes by size

| size | n | readable | head wrong | not coherent | unsure |
|---|---|---|---|---|---|
| 1-4 actions | 25 | 52% | 8% | 24% | 16% |
| 9+ actions | 17 | 18% | 0% | 82% | 0% |
| 5-8 actions | 18 | 39% | 11% | 39% | 11% |

## Judged to be a single task

| level | n | one task | two or more |
|---|---|---|---|
| hybrid | 18 | 89% | 11% |
| full | 18 | 78% | 22% |
| episode | 60 | 47% | 53% |
| step | 18 | 33% | 67% |

A low share here is not necessarily a segmentation failure: HD-EPIC annotates side tasks performed during the recipe, so an episode can correctly contain more than one activity.

## Answers that do not distinguish one node from another

15 of 60 episode answers (25%) used a phrase that also described a different node.

| answer | distinct labels it was given for |
|---|---|
| "make coffee" | 9 — block(appliances), manipulate(drinks), merge(containers), mix(drinks), press(containers) |
| "make coffee or tea" | 3 — manipulate(dairy and eggs), open(containers), shake(cutlery) |
| "random kitchen actions" | 2 — shake(baked goods and grains), turn(containers) |

An executing agent cannot act on a name shared by several states. This is the concrete form of Part 7's first blocker.

## Single task, size-matched (5-8 actions only)

| level | n | one task |
|---|---|---|
| hybrid | 18 | 89% |
| full | 18 | 78% |
| episode | 18 | 50% |
| step | 4 | 75% |

This is the only fair comparison across levels in this report. Every other level table mixes items of very different sizes, and size predicts coherence more strongly than level does. Where n is small, say so rather than quoting the percentage alone.

## Reading it

- Episodes scored 38% and steps 17%. Do NOT report this as episodes beating human labels. Step labels are prose, which the automatic coder cannot match, and step items are far larger. Hand-code the step rows (`handcode.py`) before using this row at all.
- Level 2 windows were nameable 100% of the time against 100% for raw Level 1 windows. These two are directly comparable; both are easier questions than the labelled levels, so do not read them against episodes or steps except through the single-task table.
- Level 2 is at least as readable as Level 3 here. If that holds up, the episode layer's contribution is plan length and goal structure rather than readability, and the write-up should say so plainly.
- Of the episode items, 7% were grouped correctly but named wrongly, and 45% were not coherent groups. The first is fixed by the naming rule; only the second requires changing the segmentation.
