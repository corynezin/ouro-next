# Maintainability benchmark

How healthy is the code, and how easily can it be changed? This benchmark answers both for Ouro Next, with two
measurements that are kept apart on purpose:

1. **Static health** (`bench health`): deterministic numbers read from the source, free and seconds to run. Size,
   function complexity, type-safety escapes, duplication, import cycles, tests, and the project's own gates. Good for
   tracking a revision against the last one, and for every change in review.
2. **Task maintainability** (`bench run`, `review`, `summarize`): a coding agent attempts the 100 task prompts against
   a pinned revision, each in a fresh copy, under a fixed time limit. A reviewer judges every attempt. The score, the
   effort it took and the damage it did to the code are the measurement of how changeable the code is.

Static health says what the code looks like; the tasks say what it is like to work in. Neither stands in for the
other, and the task score is never read as code cleanliness by itself: the original run found prompt ambiguity,
environment friction and model mistakes behind many results. That is why every judgement records an attribution.

## Files

- `tasks.json`: the 100 original prompts, verbatim. `initial-results.json`: the original baseline, below.
- `catalog.ts`: joins prompts to their original `kind`, `difficulty` and `area` labels; task selection.
- `metrics.ts`: static health of a list of files (TypeScript compiler AST). `gates.ts`: the project's checks, process control.
- `workspace.ts`: an attempt's copy. `solvers.ts`: Claude Code, Codex, or any command, and their usage.
- `run.ts`: attempts. `review.ts`: judgements. `summarize.ts`: results and the comparison with the baseline.
- `bench.ts`: the command line (`npm run bench -- help`). `benchmark.test.ts`: unit and end-to-end tests (in `npm test`).

## Static health

```sh
npm run bench -- health                          # working tree
npm run bench -- health --rev base-12 --gates --out before.json
npm run bench -- health --out after.json
npm run bench -- health-compare before.json after.json   # exits 1 if any indicator got worse
```

Test files (`*.test.ts`, journeys) are counted as tests; everything else tracked as TypeScript, except this folder, is
source. Indicators and which way is better:

| Indicator | Better | Meaning |
|---|---|---|
| testToSourceRatio | higher | test code lines per source code line |
| largeFiles | lower | source files over 400 code lines |
| complexityP50, P90, Max | lower | cyclomatic complexity per function (branches, loops, catch, `&&`/`\|\|`/`??`); nested functions are measured on their own |
| complexFunctions, veryComplexFunctions | lower | functions over 10, over 20 |
| longFunctions | lower | functions over 60 lines |
| anyTypes, nonNullAssertions, doubleCasts | lower | `any`, `x!`, `as unknown as` in source |
| suppressions | lower | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable` |
| markers | lower | TODO, FIXME, HACK, XXX in source |
| duplicatedLineRatio | lower | share of meaningful lines inside an 8-line run that appears more than once |
| importCycleFiles, importCycles | lower | relative-import strongly connected components |

Sizes (files, lines, functions) are context, not better or worse. `--gates` adds `lint:imports`, `typecheck` and
`test:unit` with pass/fail, time and test counts. The report also names the most complex functions, the longest
functions, the largest files and the cycles, which is where to look first. There is deliberately no single health
score: each number can be gamed alone, and a weighted sum hides which one moved.

At the starting revision of this branch: 272 source files, 31,451 source code lines, 816 unit tests passing, test ratio
0.58, complexity p90 5, 116 functions over 10 (22 over 20), 9 files over 400 lines, duplication 0.5%, one two-file
import cycle. `server/src/app/core.ts` (3,222 lines) and `runCli` (complexity 109) stand out.

## Task maintainability

### Procedure

For each selected task, `run`:

1. Copies the pinned revision (`git archive`) into `<runs>/<label>/attempts/<id>/workspace/src`, without this folder,
   with one starting commit and no history. Installed packages are linked from a checkout that has them (`--deps`),
   with the workspace's own `@ouro/*` links so checks test the copy, not the checkout.
2. For a debugging task, first folds in its private regression (see below); the file keeps its timestamps.
3. Gives the solver a fixed frame plus the verbatim prompt (`solver-prompt.txt`): work here, don't commit, don't ask,
   don't deploy or touch anything outside the copy. Its environment has none of this machine's `OURO_*` or agent
   variables, and an `ouro` that refuses. Default limit 1,200 seconds per task, the original's; the process group is
   stopped at the limit.
4. Records the stream of events, final message, status, wall time and usage (input including cached, cached, cache
   writes, output; unknown stays `null`), and cost where the solver reports it.
5. Captures the change as a patch with its footprint (files, test files, lines added and removed), runs the project's
   gates on it one at a time whatever the number of workers, and compares its static health with the starting
   revision's, keeping each indicator that moved.

The starting revision itself is measured once per run (`baseline.json`), gates included, so a failing gate after an
attempt can be told from one that was already failing. A run is resumable: an attempt with a `result.json` isn't
repeated, one cut off before it is started again. A label is pinned to one revision.

`review` judges each attempt without a judgement, using an agent in the attempt's copy that reads the patch and runs
focused checks. Attempts with no change are judged failed without one. Verdicts are `complete`, `partial`, `failed`,
`invalid_task` (the prompt doesn't fit this code) and `infrastructure_blocked`; anything short of complete names
attributions: `code_navigation`, `implementation`, `regression`, `prompt_ambiguity`, `environment`, `budget`,
`setup_or_injection`. Agent judgements are provisional until a person accepts them (`accept`) or records their own
(`record`). Exit codes, gates and health changes inform the review; they never decide it.

`summarize` writes `results.json` in the shape of `initial-results.json` (judgements and effort by kind, difficulty and
outcome, usage with missing IDs) plus:

- **Score**: complete counts 1, partial ½, over attempts judged complete, partial or failed. Also the complete rate.
- **Quality**: whether baseline gates passed; attempts that left no change; gates green after the change; changes that
  touched tests; median files and lines changed; attempts that made a health indicator worse, and which.
- **Comparison with the original baseline** on the task IDs judged in both: score, complete rate, effort and
  judgement transitions. Descriptive only: the code, solver, model and reviewer all differ.

`REPORT.md` is the readable version.

### Running it

```sh
npm run bench -- list --kind feature --difficulty easy
npm run bench -- run --label next-2026-11 --every 10 --solver claude --model claude-sonnet-5-5 --effort low
npm run bench -- review --label next-2026-11 --model claude-opus-5-5
npm run bench -- record --label next-2026-11 --id T003 --verdict partial --reason "Counts, but not live." --attribution implementation --by cory
npm run bench -- accept --label next-2026-11 --ids T001-T010 --by cory
npm run bench -- summarize --label next-2026-11
```

Runs go to `$OURO_BENCH_RUNS` or `~/ouro-bench-runs`, outside the repository. Model inference is paid or uses an
allowance: start with `--every 10` (10 tasks) before all 100. On a small machine keep `--workers 1` or 2; the gates
take minutes each and always run one at a time. `--skip-gates` saves that time at the cost of the regression evidence.
`--solver command --solver-command "…"` runs anything that reads the prompt on its input (or `$BENCH_PROMPT_FILE`).

A one-task pilot validated the whole path on this revision: T003 with Claude Sonnet 5.5 at low effort took 184
seconds and $0.07 (158,229 input tokens, 147,785 cached; 1,255 output), kept every gate green, and an agent reviewer
judged it complete. That is a check of the harness, not a result.

### Debugging tasks need private regressions

The 30 `debug` prompts describe a symptom of a bug planted in the starting point. On clean source there is no bug, so
without an injection `run` skips them and lists them as skipped. Injections are passed with `--injections FILE` and
must stay out of this public repository, as must reviewer notes (`review --rubric FILE`):

```json
{ "T0nn": { "edits": [{ "path": "server/src/…", "find": "exact original text", "replace": "regressed text" }] } }
```

Each edit must match exactly once. The original injections target the original Ouro's files and don't apply to Ouro
Next: each needs re-authoring against this code, and validating (the symptom present when injected, absent when clean)
before it is used. The original evaluator's `{ tasks: [{ id, review }] }` file is accepted as a rubric as is.

### Comparability

Keep the revision, solver, model, effort, time limit, workers, injections and reviewer fixed between runs you compare,
and repeat attempts before reading small differences: one attempt per task is noisy. Prompts were written for the
original Ouro; some may not fit Ouro Next, which the reviewer marks `invalid_task` and the score leaves out. iPhone
rendering isn't checked on Linux; app changes are judged from source.

## Original baseline

`initial-results.json` contains aggregate and per-task measurements from the initial run against the original Ouro
app/server, before Ouro Next. These are historical reference measurements, not results for this repository.

Source: [original benchmark](https://github.com/corynezin/ouro-benchmark/tree/831405d). Frozen source revisions: app `d20d3ad87fef1ef96dac30dd889089621721de06`, server `e72b7d1413e2845c5293ee4f2324fc176bd803ec`.

100 tasks attempted: **64 provisionally complete, 25 partial, 11 failed**. These are independent agent reviews awaiting human acceptance; mobile UI changes were not device-tested.

Measured solver time totals **18,230.359 seconds (5.06 hours)**, with a **153.417-second median**. Summed task time is not elapsed batch time. Setup and review are excluded.

Reported usage: **78,140,995 input tokens**, including **73,371,904 cached input tokens**, and **581,518 output tokens**. Cached input is a subset of input; reported reasoning tokens (37,544) are a subset of output. Usage is available for **99/100** tasks: T092 timed out and its usage is unknown, not zero. Subscription expenditure cannot be inferred from these counts.

The first 10 tasks used an unpinned CLI default, 10 used Sol, and 80 used Luna. Explicit model settings used low reasoning. Runs used one worker initially and two from batch-05 onward, a 1,200-second solver limit per task, and no token cap. Task mixes differ, so this is not a paired model comparison.

Task wording is preserved verbatim and may need interpretation for Ouro Next. Debug prompts originally ran against deliberately modified source. This import contains no injected bugs or their causes, reference solutions, review explanations, source snapshots, traces, or execution harness. Running those prompts on clean source does not reproduce the original debugging benchmark.

Task IDs join prompts to result rows. `kind`, `difficulty`, and `area` are original subjective labels; judgments remain provisional. Model metadata is retained as recorded, including the unknown default. Missing usage is represented by null values, not estimated.
