#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# scripts/build_dashboard_data.py — v1.14.1 admin dashboard seed builder.
#
# Reads the measured result JSONs from OpenCometBench/results/ and emits
# OpenCometBench/dashboard-data.js (window.__DASHBOARD_SEED__ = { … }) so the
# admin dashboard (OpenCometBench/dashboard.html) renders offline with the
# AUTHORITATIVE real-hardware numbers pre-loaded. File-import still lets an
# admin load any newer report over this seed.
#
# Every number flows from a result file — the builder only reshapes, never
# computes or "improves" values.
# ─────────────────────────────────────────────────────────────────────────────
import json, os, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RES = os.path.join(ROOT, 'OpenCometBench', 'results')

def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)

def latest(pattern):
    files = sorted(glob.glob(os.path.join(RES, pattern)))
    return files[-1] if files else None

# ── authoritative real-hardware browser report ───────────────────────────────
AUTH_NAME = 'browser-benchmark-1788731519242.json'  # v1.14.3: post-memo run + exact changedFrame, same real hardware — supersedes 1788729358673 (first post-memo run) and 1788724999257 (pre-memo baseline, kept as reference)
b = load(os.path.join(RES, AUTH_NAME))
env = b['environment']
vc, rm, ocr, res = b['visualContext'], b['redactionMatrix'], b['ocrVisualPii'], b['resources']

visual_rows = [{
    'page': r['page'], 'expect': r['expect'],
    'domType': r['domType'], 'domConf': r['domConfidence'],
    'fusedType': r['fusedType'], 'fusedConf': r['fusedConfidence'],
    'okDom': r['okDom'], 'okFused': r['okFused'],
    'completeness': r.get('completeness'),
    'pixelsOnly': r.get('pixelsOnlyPage', False),
    'vitTop': (r.get('vitLabels') or [{}])[0].get('label', ''),
    'vitScore': (r.get('vitLabels') or [{}])[0].get('score'),
} for r in vc['pageTypeAccuracy']['rows']]

# roll the 72 redaction runs up per DPR (display-only aggregation of measured runs)
dpr_roll = {}
for r in rm['runs']:
    d = dpr_roll.setdefault(r['dpr'], {'n': 0, 'iou': 0.0, 'coverage': 0.0, 'gt': 0, 'leaks': 0})
    d['n'] += 1; d['iou'] += r['meanIou']; d['coverage'] += r['coverage']
    d['gt'] += len(r.get('perGt', [])); d['leaks'] += r.get('pixelLeakCount', 0)
redaction_rollup = [{'dpr': k, 'n': v['n'], 'meanIou': round(v['iou'] / v['n'], 4),
                     'coverage': round(v['coverage'] / v['n'], 4), 'gt': v['gt'], 'leaks': v['leaks']}
                    for k, v in sorted(dpr_roll.items())]

phases = ['objectDetect', 'ocr', 'redact', 'faceDetect', 'vit', 'domScan', 'textScan']
phase_rows = [{'phase': p, 'p50': res['phasesMs'][p]['p50'], 'p90': res['phasesMs'][p]['p90'],
               'p95': res['phasesMs'][p]['p95']} for p in phases if p in res['phasesMs']]

authoritative = {
    'file': AUTH_NAME,
    'meta': b['meta'],
    'environment': env,
    'visual': {
        'domDerived': vc['pageTypeAccuracy']['domDerived'],
        'vitFused': vc['pageTypeAccuracy']['vitFused'],
        'n': vc['pageTypeAccuracy']['n'],
        'rows': visual_rows,
    },
    'redaction': {
        'coverage': rm['coverage'], 'meanIou': rm['meanIou'],
        'overRedactionPct': rm['overRedactionPct'],
        'pixelLeakage': rm['pixelLeakage'],
        'pipelineMs': rm['pipelineMs'],
        'rollupByDpr': redaction_rollup,
    },
    'ocr': {
        'onCoverage': ocr['ocrOn']['score']['coverage'],
        'meanIou': ocr['ocrOn']['score'].get('meanIou'),
        'pixelRedacted': sum(1 for g in ocr['ocrOn']['score']['perGt'] if g['pixelRedacted']),
        'gtCount': len(ocr['ocrOn']['score']['perGt']),
        'offCoverage': ocr['ocrOff']['score']['coverage'] if isinstance(ocr.get('ocrOff'), dict) and ocr.get('ocrOff') else 0,
        'failClosedVerified': ocr.get('failClosedVerified'),
        'engineLoadMs': ocr.get('ocrEngineLoadMs'),
        'perType': [{'sel': g['sel'], 'type': g['type'], 'coverage': g['coverage'],
                     'iou': g['iou'], 'pixelRedacted': g['pixelRedacted'], 'ok': g['ok']}
                    for g in ocr['ocrOn']['score']['perGt']],
    },
    'resources': {
        'sanitizeTotalMs': res['sanitizeTotalMs'],
        'phases': phase_rows,
        'payloadKb': res['payloadKb'],
        'heap': res['heap'],
        'backend': res['backend'],
        'models': res['models'],
        'changedFrame': res.get('changedFrame'),
        'meta': res.get('meta'),
    },
}

# ── latest scene-change probe ────────────────────────────────────────────────
sc = None
scf = latest('scene-change-probe-*.json')
if scf:
    s = load(scf)
    sc = {'file': os.path.basename(scf), 'meta': s['meta'], 'generatedAt': s['generatedAt'],
          'pass': s['pass'], 'runs': s['runs'], 'checks': s['checks']}

# ── latest e2e (mock brain) ──────────────────────────────────────────────────
e2e = None
e2ef = latest('e2e-benchmark-*.json')
if e2ef:
    e = load(e2ef)
    e2e = {'file': os.path.basename(e2ef), 'meta': e['meta'], 'generatedAt': e['meta'].get('generatedAt'),
           'aggregate': e['aggregate'],
           'scenarios': [{'id': s['id'], 'task': s['task'], 'finished': s.get('finished'),
                          'stepCount': s.get('stepCount'), 'totalMs': s.get('totalMs'),
                          'verified': s.get('verified'), 'verifyFailed': s.get('verifyFailed'),
                          'failed': s.get('failed')} for s in e['scenarios']]}

# ── E2E-REAL (REAL model brain) — seed pins the REAL-HARDWARE report ─────────
# v1.14.4: e2e-real evidence exists; the seed deliberately pins the run measured
# on the user's real machine (meta note: "runs on real user hardware only").
# Headless-CI e2e-real runs stay in results/ as labelled loop-validation
# references and are NEVER quoted as production latencies.
E2E_REAL_NAME = 'e2e-real-benchmark-1788808870925.json'
e2ereal = None
e2realf = os.path.join(RES, E2E_REAL_NAME)
if os.path.exists(e2realf):
    er = load(e2realf)
    eragg = dict(er.get('aggregate', {}))
    if 'vlmMs' not in eragg and 'vlmMs_real' in eragg:
        eragg['vlmMs'] = eragg['vlmMs_real']  # panel field name; keeps the raw key too
    e2ereal = {'file': E2E_REAL_NAME, 'meta': er['meta'], 'generatedAt': er['meta'].get('generatedAt'),
               'environment': 'real-hardware-headed (user machine; headless-CI runs are reference-only)',
               'aggregate': eragg,
               'scenarios': [{'id': s['id'], 'task': s['task'], 'finished': s.get('finished'),
                              'blocked': s.get('blocked'), 'stepCount': s.get('stepCount'),
                              'totalMs': s.get('totalMs'), 'verified': s.get('verified'),
                              'verifyFailed': s.get('verifyFailed'), 'failed': s.get('failed')}
                             for s in er.get('scenarios', [])]}

# ── latest adversarial ───────────────────────────────────────────────────────
adv = None
advf = latest('adversarial-benchmark-*.json')
if advf:
    a = load(advf)
    adv = {'file': os.path.basename(advf), 'meta': a['meta'], 'generatedAt': a['meta'].get('generatedAt'),
           'privacy': {k: v for k, v in a['privacy'].items() if not isinstance(v, (list, dict))},
           'injection': {k: v for k, v in a['injection'].items() if not isinstance(v, (list, dict))}}

# ── unit suites ──────────────────────────────────────────────────────────────
unit = None
unitf = os.path.join(RES, 'unit-suite-latest.json')
if os.path.exists(unitf):
    u = load(unitf)
    unit = {'generatedAt': u['generatedAt'],
            'suites': [{'name': r['name'], 'pass': r['pass'], 'durationMs': r.get('durationMs')}
                       for r in u['results']]}

seed = {'generatedAt': b['meta']['generatedAt'], 'authoritative': authoritative,
        'sceneChange': sc, 'e2eMock': e2e, 'e2eReal': e2ereal, 'adversarial': adv, 'unit': unit}

out = '// AUTO-GENERATED by scripts/build_dashboard_data.py — measured values only, do not hand-edit.\n'
out += 'window.__DASHBOARD_SEED__ = ' + json.dumps(seed, ensure_ascii=False, indent=1) + ';\n'
with open(os.path.join(ROOT, 'OpenCometBench', 'dashboard-data.js'), 'w', encoding='utf-8') as f:
    f.write(out)
print(f'wrote OpenCometBench/dashboard-data.js ({len(out)} bytes)')
print('authoritative:', AUTH_NAME, '| sceneChange:', sc and sc['file'], '| e2e:', e2e and e2e['file'], '| e2eReal:', e2ereal and e2ereal['file'], '| adv:', adv and adv['file'])
