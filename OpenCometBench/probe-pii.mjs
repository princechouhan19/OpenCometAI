#!/usr/bin/env node
// Focused probes for remaining PII bench failures.
import { detectPiiInText, luhnValid, ibanValid } from '../src/lib/pii-detector.js';

const t1 = 'Billing address: 8225 Maple Drive, Springfield, IL 35703-3932';
console.log('T1 address:', (await detectPiiInText(t1)).map(d => `${d.type}@${d.start}-${d.end} ${d.raw} ctx=${d.context} risk=${d.risk}`));
const t2 = 'Card number 4917 2701 7876 6599 847';
console.log('T2 card:', (await detectPiiInText(t2)).map(d => `${d.type} ${d.raw}`));
console.log('T2 luhn:', luhnValid('4917270178766599847'));
const t3 = 'Key: eyHkHaaFthChQEByS1pD0AvdzJe_7SK4cMFZMGE7FQ';
console.log('T3 token:', (await detectPiiInText(t3)).map(d => `${d.type} ${d.raw}`));
const t4 = 'API key tok_9cMIKDsZIZuHEsgNC7e6aa56';
console.log('T4 token:', (await detectPiiInText(t4)).map(d => `${d.type} ${d.raw}`));
const t5 = 'मोबाइल: +91 67146 39545';
console.log('T5 phone:', (await detectPiiInText(t5)).map(d => `${d.type} ${d.raw}`));
const t6 = 'Card on file 5100-3140-7908-1560.';
console.log('T6 card:', (await detectPiiInText(t6)).map(d => `${d.type} ${d.raw}`), 'luhn:', luhnValid('5100314079081560'));
// luhn round-trip check
import { execSync } from 'node:child_process';
