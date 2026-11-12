# Maintainability benchmark: original baseline

`tasks.json` contains the original 100 human-style task prompts. `initial-results.json` contains aggregate and per-task measurements from the initial run against the original Ouro app/server, before Ouro Next. These are historical reference measurements, not results for this repository.

Source: [original benchmark](https://github.com/corynezin/ouro-benchmark/tree/831405d). Frozen source revisions: app `d20d3ad87fef1ef96dac30dd889089621721de06`, server `e72b7d1413e2845c5293ee4f2324fc176bd803ec`.

## Initial results

100 tasks attempted: **64 provisionally complete, 25 partial, 11 failed**. These are independent agent reviews awaiting human acceptance; mobile UI changes were not device-tested.

Measured solver time totals **18,230.359 seconds (5.06 hours)**, with a **153.417-second median**. Summed task time is not elapsed batch time. Setup and review are excluded.

Reported usage: **78,140,995 input tokens**, including **73,371,904 cached input tokens**, and **581,518 output tokens**. Cached input is a subset of input; reported reasoning tokens (37,544) are a subset of output. Usage is available for **99/100** tasks: T092 timed out and its usage is unknown, not zero. Subscription expenditure cannot be inferred from these counts.

The first 10 tasks used an unpinned CLI default, 10 used Sol, and 80 used Luna. Explicit model settings used low reasoning. Runs used one worker initially and two from batch-05 onward, a 1,200-second solver limit per task, and no token cap. Task mixes differ, so this is not a paired model comparison.

## Reuse

Task wording is preserved verbatim and may need interpretation for Ouro Next. Debug prompts originally ran against deliberately modified source. This import contains no injected bugs or their causes, reference solutions, review explanations, source snapshots, traces, or execution harness. Running those prompts on clean source does not reproduce the original debugging benchmark.

Task IDs join prompts to result rows. `kind`, `difficulty`, and `area` are original subjective labels; judgments remain provisional. Model metadata is retained as recorded, including the unknown default. Missing usage is represented by null values, not estimated.
