#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// OpenCometBench/run-opencomet-bench.mjs — ONE-COMMAND AUTO-RUN for the whole
// OpenComet-Bench suite, executed against OpenComet itself (the real unpacked
// extension, loaded into a real Chromium by the E2E/ADVERSARIAL/BROWSER
// harnesses — no mocks for the pipeline, only for the decision brain where the
// tier says so).
//
//   node OpenCometBench/run-opencomet-bench.mjs               # UNIT + E2E
//   node OpenCometBench/run-opencomet-bench.mjs --unit        # Node suites only
//   node OpenCometBench/run-opencomet-bench.mjs --adversarial # + adversarial
//   node OpenCometBench/run-opencomet-bench.mjs --browser     # + browser harness
//   node OpenCometBench/run-opencomet-bench.mjs --all         # every tier
//   node OpenCometBench/run-opencomet-bench.mjs --json        # machine summary
//
// This script is a thin ORCHESTRATOR: every measurement still comes from the
// real per-tier harnesses (run-all.js, run-e2e.mjs, run-adversarial.mjs,
// browser/harness.mjs). Nothing here asserts, estimates, or fabricates a
// number — the summary it writes only republishes each child's own verdict and
// the path of the report file the child produced.
//
// Exit code 0 = every tier that RAN passed. A tier that could not run
// (e.g. playwright not installed) is reported as SKIPPED with its reason and
// does not fail the run unless --strict is passed.
// ─────────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(BENCH_DIR, '..');            // project root (the extension itself)
const RESULTS = join(BENCH_DIR, 'results');

const args = process.argv.slice(2);
const want = (flag) => args.includes(flag);
const asJson = want('--json');
const strict = want('--strict');
const ALL_TIERS = ['unit', 'e2e', 'adversarial', 'browser'];

let tiers;
if (want('--all')) tiers = ALL_TIERS;
else {
  tiers = ALL_TIERS.filter((t) => want(`--${t}`));
  if (tiers.length === 0) tiers = ['unit', 'e2e'];   // sensible default
}

const FLAG = { unit: 35, e2e: 34, adversarial: 36, browser: 33 };
const RESET = '\x1b[0m';
const bold = (s) => `\x1b[1m${s}${RESET}`;
const tag = (t) => `${bold(`[${t.toUpperCase()}]`)}`;
const pad = (s, n) => String(s).padEnd(n);

function playwrightAvailable() {
  const probe = spawnSync(
    process.execPath,
    ['-e', "import('playwright').then(()=>console.log('ok')).catch(()=>process.exit(3))"],
    { cwd: ROOT, encoding: 'utf8', timeout: 60_000 },
  );
  return probe.status === 0;
}

/** Newest report file in OpenCometBench/results/ whose name starts with `prefix`. */
function newestReport(prefix) {
  let best = null;
  let bestM = -1;
  for (const f of readdirSync(RESULTS)) {
    if (!f.startsWith(prefix) || !f.endsWith('.json')) continue;
    const m = Number(f.slice(prefix.length, -'.json'.length)) || 0;
    if (m > bestM) { bestM = m; best = f; }
  }
  return best;
}

/** Verdict fields copied VERBATIM from a child report (no recomputation). */
function verdictFor(tier, reportFile) {
  if (!reportFile) return {};
  try {
    const j = JSON.parse(readFileSync(join(RESULTS, reportFile), 'utf8'));
    if (tier === 'adversarial') {
      return {
        privacy: j.privacy ? `${j.privacy.passed}/${j.privacy.n}` : undefined,
        injection: j.injection ? `${j.injection.passed}/${j.injection.n}` : undefined,
      };
    }
    if (tier === 'e2e') {
      return {
        tasks: j.aggregate?.steps != null ? `${j.scenarios?.length ?? '?'} tasks · ${j.aggregate.steps} steps` : undefined,
        taskSuccessRatio: j.aggregate?.taskSuccessRatio,
        verifiedActionRatio: j.aggregate?.verifiedActionRatio,
      };
    }
    if (tier === 'browser') return { metaType: j.meta?.type, environment: j.meta?.environment?.label ?? j.meta?.environment?.kind };
  } catch { /* report unreadable — summary still names the file */ }
  return {};
}

function runTier(tier) {
  const t0 = Date.now();
  const spec = {
    unit: { cmd: process.execPath, args: [join(BENCH_DIR, 'run-all.js'), '--json'], capture: true },
    e2e: { cmd: process.execPath, args: [join(BENCH_DIR, 'e2e', 'run-e2e.mjs')], needsPlaywright: true },
    adversarial: { cmd: process.execPath, args: [join(BENCH_DIR, 'e2e', 'run-adversarial.mjs')], needsPlaywright: true },
    browser: { cmd: process.execPath, args: [join(BENCH_DIR, 'browser', 'harness.mjs')], needsPlaywright: true },
  }[tier];

  if (spec.needsPlaywright && !playwrightAvailable()) {
    return { tier, status: 'SKIPPED', reason: 'playwright is not installed in this checkout (npm i playwright) — tier not run', durationMs: 0 };
  }

  const res = spawnSync(spec.cmd, spec.args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (tier === 'unit') {
    // run-all.js --json prints the measured JSON on stdout — persist it verbatim.
    mkdirSync(RESULTS, { recursive: true });
    let parsed = null;
    try { parsed = JSON.parse(res.stdout); } catch { /* non-JSON output — keep raw below */ }
    const file = join(RESULTS, `unit-${Date.now()}.json`);
    writeFileSync(file, parsed ? JSON.stringify(parsed, null, 2) : String(res.stdout || ''));
    const failed = (parsed?.results || []).filter((r) => !r.pass).map((r) => r.name);
    return {
      tier,
      status: res.status === 0 ? 'PASS' : 'FAIL',
      report: file,
      suites: parsed?.results?.length,
      failedSuites: failed.length ? failed : undefined,
      durationMs: Date.now() - t0,
      ...(res.status !== 0 ? { stderr: String(res.stderr || '').slice(-800) } : {}),
    };
  }

  const prefix = { e2e: 'e2e-benchmark-', adversarial: 'adversarial-benchmark-', browser: 'browser-benchmark-' }[tier];
  const report = newestReport(prefix);
  return {
    tier,
    status: res.status === 0 ? 'PASS' : 'FAIL',
    report: report ? join('OpenCometBench', 'results', report) : undefined,
    ...verdictFor(tier, report),
    durationMs: Date.now() - t0,
    ...(res.status !== 0 ? { stderr: String(res.stderr || '').slice(-800) } : {}),
  };
}

// ── run ──
mkdirSync(RESULTS, { recursive: true });
if (!asJson) {
  console.log(bold('\n  OpenComet-Bench — auto-run against OpenComet itself (SIH PS 26171)'));
  console.log(`  tiers: ${tiers.join(' · ')}   (project: ${ROOT})\n`);
}

const results = [];
for (const tier of tiers) {
  if (!asJson) console.log(`${tag(tier)} running…`);
  const r = runTier(tier);
  results.push(r);
  if (!asJson) {
    const verdict = [r.privacy && `privacy ${r.privacy}`, r.injection && `injection ${r.injection}`,
      r.taskSuccessRatio != null && `taskSuccess ${r.taskSuccessRatio}`, r.verifiedActionRatio != null && `verifiedActions ${r.verifiedActionRatio}`,
      r.suites != null && `${r.suites} suites`, r.environment, r.reason]
      .filter(Boolean).join(' · ');
    console.log(`${tag(tier)} ${bold(r.status)}  ${verdict}${r.report ? `\n         report: ${r.report}` : ''}${r.failedSuites ? `\n         failed: ${r.failedSuites.join(', ')}` : ''}\n`);
  }
}

const ran = results.filter((r) => r.status !== 'SKIPPED');
const allPass = ran.length > 0 && ran.every((r) => r.status === 'PASS');
const summary = {
  meta: {
    type: 'opencomet-bench-summary',
    generatedAt: new Date().toISOString(),
    tiers,
    note: 'Orchestrator republish — every verdict and report path comes verbatim from the per-tier harness output; nothing is recomputed or asserted here.',
  },
  results,
  allRanTiersPassed: allPass,
};

const outFile = join(RESULTS, `opencomet-bench-summary-${Date.now()}.json`);
writeFileSync(outFile, JSON.stringify(summary, null, 2));

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log('──────────────────────────────────────────────────────────────────');
  for (const r of results) console.log(`  ${pad(r.tier.toUpperCase(), 13)} ${r.status}${r.report ? `  → ${r.report}` : ''}`);
  console.log(`  ${allPass ? 'ALL RUN TIERS PASS' : 'FAILURES PRESENT (see above)'}${ran.length < results.length ? `  · ${results.length - ran.length} skipped` : ''}`);
  console.log(`  summary: ${outFile}`);
  console.log('  Import UNIT / BROWSER / E2E / ADVERSARIAL reports in Settings → SIH Scorecard.');
  console.log('──────────────────────────────────────────────────────────────────\n');
}

process.exit(allPass || (!strict && ran.length === 0) ? 0 : 1);
