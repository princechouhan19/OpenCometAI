import test from 'node:test';
import assert from 'node:assert/strict';
import { pageProbe } from '../src/lib/goal-probe.js';

// The function Chrome injects, run here against a fake document. Setting the
// globals is the whole harness: no DOM library, no bundler.
function probe(dom, selectors) {
  const savedDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const savedLoc = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'document', { value: dom, configurable: true });
  Object.defineProperty(globalThis, 'location', { value: dom.location, configurable: true });
  try {
    return pageProbe(selectors);
  } finally {
    if (savedDoc) Object.defineProperty(globalThis, 'document', savedDoc);
    else delete globalThis.document;
    if (savedLoc) Object.defineProperty(globalThis, 'location', savedLoc);
    else delete globalThis.location;
  }
}

const node = (text) => ({ innerText: text, textContent: text });

function fakeDom({ map = {}, body = 'Hello   world', url = 'https://mail.google.com/mail/u/0/#sent', title = 'Sent Mail' } = {}) {
  return {
    title,
    location: { href: url },
    body: { innerText: body },
    querySelectorAll(sel) {
      if (sel === 'boom') throw new SyntaxError(`'${sel}' is not a valid selector`);
      return map[sel] || [];
    },
  };
}

test('counts and first-text are read per selector', () => {
  const p = probe(fakeDom({ map: { '#toast': [node('Message sent'), node('again')], '.row': [node('a'), node('b'), node('c')] } }), ['#toast', '.row']);
  assert.equal(p.counts['#toast'], 2);
  assert.equal(p.counts['.row'], 3);
  assert.equal(p.texts['#toast'], 'Message sent');
});

test('an absent selector reads as zero, not as passing', () => {
  const p = probe(fakeDom(), ['#nothing']);
  assert.equal(p.counts['#nothing'], 0);
  assert.equal(p.texts['#nothing'], '');
});

test('an invalid selector does not throw out of the probe', () => {
  const p = probe(fakeDom(), ['boom']);
  assert.equal(p.counts.boom, 0);
  assert.equal(p.texts.boom, '');
});

test('whitespace is collapsed in body text and element text', () => {
  const p = probe(fakeDom({ map: { '#x': [node('  a\n\n  b  ')] }, body: 'one   two\n\nthree' }), ['#x']);
  assert.equal(p.text, 'one two three');
  assert.equal(p.texts['#x'], 'a b');
});

test('long text is truncated', () => {
  const p = probe(fakeDom({ body: 'x'.repeat(25000), map: { '#x': [node('y'.repeat(900))] } }), ['#x']);
  assert.equal(p.text.length, 20000);
  assert.equal(p.texts['#x'].length, 500);
});

test('url and title come from the live page', () => {
  const p = probe(fakeDom(), []);
  assert.equal(p.url, 'https://mail.google.com/mail/u/0/#sent');
  assert.equal(p.title, 'Sent Mail');
});

test('a page with no body does not throw', () => {
  const dom = fakeDom();
  dom.body = null;
  const p = probe(dom, []);
  assert.equal(p.text, '');
});

test('the probe never reaches outside itself', () => {
  // Chrome serialises the source; a reference to an import would arrive in the
  // page as a ReferenceError. Cheap guard against reintroducing one.
  const src = pageProbe.toString();
  assert.ok(!/\bimport\s|\brequire\(/.test(src), 'probe must not import');
  assert.ok(!/goal-verifier|error-taxonomy/.test(src), 'probe must not reference other modules');
});
