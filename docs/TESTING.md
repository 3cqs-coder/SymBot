# Testing

How SymBot is tested, how to run the tests, and the conventions to follow when adding new ones. This is a
developer document. SymBot's tests run in CI but are excluded from deployed images and user installs (see
*Not deployed* below), so nothing here describes runtime behavior a user relies on.

## Running the tests

```bash
npm test                              # run every *.test.js under libs/test/
node libs/test/run-tests.js AIGuard   # only files whose path contains "AIGuard"
node libs/test/ai/AIGuardrails.test.js   # run one file directly (fastest inner loop)
npm run check                         # syntax/JSON gate over the whole tree (libs/test/precheck.js)
```

`npm test` runs `libs/test/run-tests.js`, a small cross-platform Node runner (no shell globbing, so it behaves
the same on Linux, macOS, and Windows). It finds every `*.test.js` under `libs/test/` and runs each in its own
Node process, for isolation and real exit codes. It prints a `✓ / ✗` line per file and exits non-zero if any
file fails. On a distribution that has no `libs/test/` (a user install), it prints a friendly note and exits 0.

There is no test framework. Each test file is a plain Node script that uses `assert`, counts assertions, prints
a one-line summary (`Foo: N passed`), and exits non-zero on the first failure. An uncaught `AssertionError` does
this for free. That is the whole contract the runner depends on.

## Layout

Tests mirror the source tree under `libs/test/`:

| Path | Covers |
|------|--------|
| `libs/test/ai/` | AI chat: guardrails, memory/corpus, routing, faithfulness, red-team, aggregation, time-search |
| `libs/test/queries/` | Read-only query/log tooling (e.g. `LogScan`) |
| `libs/test/app/` | App-level modules (diagnostics catalog, notifications, scheduling, …) |
| `libs/test/scheduledtasks/` | Scheduled-task handlers (performance report, drawdown/resource/error sentinels) |
| `libs/test/strategies/DCABot/` | Strategy / money-path logic (stop-loss, ladder, guards, retries, …) |
| `libs/test/webserver/` | Webserver helpers (webhook idempotency, order classification, …) |

Put a new test beside the path it covers, named `<Thing>.test.js`.

## Assertion tests vs eval harnesses

Two kinds of check live under `libs/test/`, and only the first is run by `npm test`:

- Assertion tests (`*.test.js`) are deterministic, with no model, no network, and no running instance. These
  are the gate. `AIRouting.test.js` is a deterministic eval that scores all shipped seed questions through the
  registry router and prints `N/N`; it is a `.test.js` because it is deterministic and self-contained.
- Eval harnesses (`*.eval.js`, `AIEval.js`) drive a live local model and/or a running instance, so they are
  non-deterministic and are run by hand, not by `npm test`:
  - `node libs/test/ai/AIEval.js` exercises the real chat against a running instance and grades grounding
    against the live database. Extend `ai-eval-scenarios.json` with a scenario for every confirmed AI bug.
  - `node libs/test/ai/aiQaBattery.js` is the exploratory companion to `AIEval.js`. It runs a broad,
    human-triaged sweep of whole multi-turn conversations (data → concept → vague continuation → pivot),
    printing each answer and its latency and flagging likely fabrication, machinery leaks, or deflections for a
    person to eyeball. Its header documents the established, safe run workflow. Every confirmed bug it surfaces
    is folded into `ai-eval-scenarios.json` as a golden regression, and, where a deterministic guard covers it,
    into `RedTeam.test.js`.
  - `libs/test/ai/ai-tool-selection.eval.js` is a curated tool-routing set distinct from the shipped seed.
  - The learning-corpus accuracy harness ships as data. `libs/ai/data/learning-eval.json` is a held-out labeled
    set whose paraphrases are deliberately distinct from `seed-learning.json` (enforced by a test). It is used
    at runtime by the maintainer aggregation feature and in `LearningAggregation.test.js`.

## Conventions

- Every confirmed bug becomes a permanent test. When a real defect (or an adversarial finding in an AI QA
  round) is fixed, add the minimal case that reproduces it, so it can never silently return. `RedTeam.test.js`
  is the standing example: each entry maps to an OWASP LLM Top-10 category and carries benign look-alikes that
  must not trip.
- Money-path changes get an isolated local simulation, not deploy-and-wait. Use a throwaway database plus a
  mock exchange, so an order-placement or deal-management change is verified end-to-end offline before it ships.
- AI-chat changes are verified against a live model over real data (the eval harnesses), not unit tests alone.
  A guardrail regex can pass its unit test and still fail on the phrasing a user actually types.
- Keep assertion tests pure. No database, no network, and no `Date.now()` or random dependence that makes a run
  flaky. A test that needs data writes its own fixture; see `LogScan.test.js`, which builds synthetic log files
  in a temp directory.
- Guard invariants, not just outputs. For example, `Diagnostics.test.js` asserts that every watchdog code has a
  self-explanatory catalog entry, and the held-out eval test asserts that no eval question is a copy of a seed
  question.

## Not deployed

The test corpus and its runners (`libs/test/`, including `run-tests.js` and `precheck.js`) and `.githooks/` are
development-only. They are committed to the repository so CI can run the suite, but they are excluded from
deployed Docker images and user installs. `docker/Dockerfile.dockerignore` drops the test subdirectories (the
corpus) while keeping the two small runner scripts. That way `npm test` and `npm run check` still resolve inside
the image and behave gracefully: `run-tests.js` prints "nothing to run" and exits 0 when the corpus is absent.
Production must never require a test file, and the runtime or startup path must never depend on anything under
`libs/test/` or `.githooks/`.

The pre-commit hook (`.githooks/`) runs the syntax gate (`libs/test/precheck.js`), so a file that does not parse
never lands in a commit. Running the relevant tests before committing is a manual discipline on top of that.
