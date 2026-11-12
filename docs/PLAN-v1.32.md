# Plan review and revision

Verdict on the five proposed items, then the order I'd actually work in.

## P0 — fix test and packaging: already done, verify only

`npm test` was `node --test` with no path, so it collected nothing. It is now
`node --test test/` (37 tests), `npm run check` runs tests plus the benchmark,
and `npm run package` runs `scripts/package.sh`, which gates on version drift,
placeholder strings, credentials, tests and the bench before zipping.

Accept as a gate, not as work. The remaining gap is that none of this runs
anywhere but your machine — see P5 below.

## P1 — retry integration: correct, and it was broken

Checked before agreeing: the catch block called

```js
const retry = retryDecision(errKind, priorRetries + 1);
```

so `Retry-After` was never passed, even though `retryDecision` supported it,
and `classifyError(err, { source: 'loop' })` never saw an HTTP status. A
provider answering `429` with `Retry-After: 7` and no "429" in the message
became `UNKNOWN` and got one 500 ms retry instead of seven seconds.

Fixed in this revision:

- `httpStatusOf(err)` reads `status` / `statusCode` / `response.status`
- `retryAfterMsFrom(err)` reads the header in seconds, as an HTTP-date, from a
  plain object or a `Headers`-like object with `.get()`, capped at 60 s so a
  hostile header cannot stall a run
- the catch block passes both
- `test/retry-integration.test.js` exercises the whole decision, not just the
  policy function

## P2 — live-browser verification: accepted, but split

Right thing to want, wrong unit of work. Three of the four cases cannot be
reached without Chrome, and one of them cannot be reached by *any* prompt yet.

Split it:

- **2a, testable here:** the probe is built in an injected function, so give it
  a pure core — `buildProbe(dom)` — that takes a DOM-like object and returns
  `{url, title, text, counts, texts}`. Then a five-line fake covers missing
  selectors, empty text, zero counts. This is where the `unevaluable` bugs live.
- **2b, manual, with steps:** goal declared → check holds → ends `verified`;
  check fails → agent keeps working; no contract → ends `completed_unverified`.
  Written as `docs/MANUAL-QA.md` with the exact console lines to expect.
- **2c, blocked:** cannot be done at all until the planner emits `goal`. See P3.

Do not spend a browser session on 2b before P3, or you will be testing the
`unevaluable` path three ways.

## P3 — permission and privacy review: accepted, one part rejected

`debugger` migration: accepted. `optional_permissions` plus a runtime request on
first trusted-click or full-page capture, feature-detect `chrome.debugger`,
degrade to a synthetic click, and document what stops working. This needs a
browser test of the degraded path, so it lands after P2b.

PII corpus: as written, rejected. "Independently validate" needs real banking,
UPI and government screenshots, which I do not have and should not invent. What
is achievable is making the validation *reproducible by someone who does have
them*: publish the corpus generator's spec, a manifest format, and a scoring
script that takes a folder of images and prints precision/recall. Then the
number means something to a reader even before they run it.

## P4 — performance profiling: accepted, but last for a reason

You cannot profile without a browser, and the profile is what should decide
between the five candidate optimizations. Keep it last, but make it cheaper by
landing the parts that do not need a browser first:

- extract the letterbox/scale-back coordinate math into `src/lib/perception-geom.js`
  and unit-test it. Box drift after downscaling would silently redact the wrong
  region, which is a privacy bug, not a perf bug — worth testing before anyone
  turns the resolution down.
- add a `--trace` flag to the existing instrumentation so one run emits per-phase
  timings as JSON, instead of reading them off the step feed.

## What the plan is missing

**M1 — make goal verification reachable (should be P2).** `verifyTaskGoal()` is
wired but the planner never emits `goal`, so today every run reports
`completed_unverified`. Add the planner instruction and the one re-ask on
`done`. Without this, P2 tests an unreachable code path and the headline claim
stays true only in the weakest sense.

**M2 — CI.** There is none. A workflow running `npm test` and the bench on push
turns P0 from a local habit into a gate, and would have caught the `node --test`
with no path in the first place.

**M3 — delete or migrate the one-off scripts.** About twenty
`scripts/test_v11xx_*.mjs` files are not collected by anything. Dead tests are
worse than no tests: they imply coverage. Move the ones that still assert
something into `test/`, delete the rest.

**M4 — a style gate, not just a style pass.** The comment cleanup is a one-time
edit that will drift back. `scripts/package.sh` already greps for placeholders;
give it a second grep for the markers that actually identify machine prose —
`WHY THIS EXISTS`, `fail-honest`, em-dash density above a per-file threshold —
and let it fail the build. Enforceable beats documented.

**M5 — extract the loop's decision core.** `sw.js` is ~3,100 lines of top-level
side effects and cannot be imported by a test, which is why the retry bug in P1
survived. Moving the per-iteration decision (classify → decide → mutate state)
into a pure function would make the loop testable without a browser. This is the
single largest quality improvement available, and the riskiest, so do it after
CI exists.

## Order I'd ship in

1. P1 retry plumbing — done in this revision, with an integration test
2. M1 goal contract adoption — makes the headline feature real
3. 2a probe core + 2b manual QA doc
4. M2 CI gate, M3 script cleanup, M4 style gate
5. P3a `debugger` migration with the degraded-path test
6. P4 geometry extraction and tracing, then profile
7. M5 loop-core extraction
8. P3b corpus spec and scoring script

P0 needs nothing. P2c is not a task yet.
