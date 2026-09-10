// suites.js — benchmark registry imported by run-all.js
import * as privacy from './privacy.bench.js';
import * as redaction from './redaction.bench.js';
import * as visual from './visual-context.bench.js';
import * as security from './security.test.js';
import * as fuzz from './fuzz.test.js';
import * as serverValidation from './server-validation.test.js';

export const suites = [
  { name: 'PII detection (P/R/F1)', run: privacy.run },
  { name: 'Redaction regions (coverage/IoU/over-redaction)', run: redaction.run },
  { name: 'Visual context (page-type accuracy/gate)', run: visual.run },
  { name: 'Security & privacy leakage', run: security.run },
  { name: 'Privacy leakage fuzz (216 cases)', run: fuzz.run },
  { name: 'Server inbound validation', run: serverValidation.run },
];
