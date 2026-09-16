import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness, active, inert, response, deferred, offer, settle, runtime, key, registryName } from './runtime-install-browser-v0.1.test.mjs';

test('direct/copied engine with no registry or wrong script is inert', async t => {
  const h = await harness({ auto: false, engine: false }); t.after(() => h.close());
  h.execute('chinaflow-v0.6.js'); assert.equal(h.fetches.length, 0);
  await h.load(); const other = h.d.createElement('script'); other.type = 'application/json';
  other.src = `${runtime}/runtime/chinaflow-v0.6.js`; h.d.head.append(other);
  other.setAttribute('data-chinaflow-config', 'https://override.test/config');
  h.execute('chinaflow-v0.6.js', other); assert.equal(h.fetches.length, 0);
  h.execute('chinaflow-v0.6.js', h.registry.engineElement); await h.tick(); assert(h.cta());
  h.execute('chinaflow-v0.6.js', h.registry.engineElement); await h.tick(); assert.equal(h.fetches.length, 1); h.noFallback();
});
for (const [field, value] of [['release', 'incompatible'], ['installKey', key.toUpperCase()],
  ['configUrl', 'https://override.test/v1/config'], ['runtimeOrigin', 'http://runtime.test'], ['state', 'disabled']]) {
  test(`invalid registry ${field} refuses handoff`, async t => {
    const h = await harness({ engine: false }); t.after(() => h.close());
    h.registry[field] = value; h.execute('chinaflow-v0.6.js', h.registry.engineElement);
    await h.tick(); assert.equal(h.fetches.length, 0); assert.equal(h.cta(), null); h.noFallback();
  });
}
test('valid handoff uses only registry URL and required fetch options', async t => {
  const h = await harness({ engine: false }); t.after(() => h.close());
  h.registry.engineElement.setAttribute('data-chinaflow-config', 'https://override.test/ignored');
  h.registry.engineElement.setAttribute('data-chinaflow-engine', 'https://override.test/ignored');
  h.execute('chinaflow-v0.6.js', h.registry.engineElement); await h.tick();
  assert(h.cta()); assert.equal(h.fetches.length, 1); assert.equal(h.fetches[0].url, h.registry.configUrl);
  const { credentials, mode, cache, redirect, signal } = h.fetches[0].options;
  assert.deepEqual({ credentials, mode, cache, redirect }, { credentials: 'omit', mode: 'cors', cache: 'no-store', redirect: 'error' });
  assert(signal); assert.equal(h.cta().hasAttribute('data-publisher'), false); h.noFallback();
});
const invalidConfigs = [
  ['canonical inert', inert()], ['null', null], ['wrong version', { ...active(), version: '0.1' }],
  ['runtime false', { ...active(), runtime_enabled: false }], ['runtime truthy', { ...active(), runtime_enabled: 1 }],
  ['bound origin mismatch', { ...active(), bound_origin: 'https://other.test' }],
  ['missing rules', { ...active(), rules: null }], ['missing offers', { ...active(), offers: null }],
  ['no offers', { ...active(), offers: [] }], ['disabled offers', { ...active(), offers: [{ ...offer(), enabled: false }] }],
  ['invalid exact rule', { ...active(), rules: [{ ...offer(), match: { type: 'path', value: '/post/guide' }, url: 'javascript:void(0)' }] }]
];
for (const [name, config] of invalidConfigs) test(`${name} leaves runtime inert without analytics`, async t => {
  const h = await harness({ config }); t.after(() => h.close()); await h.tick();
  assert.equal(h.cta(), null); assert.equal(h.beacons.length, 0); assert.equal(h.metrics.sessionReads, 0); h.noFallback();
});
for (const invalid of [null, {}, { ...offer(), product: 'train' }, { ...offer(), placement: '' },
  { ...offer(), placement: '  ' }, { ...offer(), url: 'http://destination.test/' },
  { ...offer(), url: 'https://user:password@destination.test/' }, { ...offer(), url: 'https://destination.test:444/' },
  { ...offer(), url: 'javascript:alert(1)' }, { ...offer(), url: 'https://destination.test/\\bad' },
  { ...offer(), url: ' https://destination.test/' }, { ...offer(), url: 'https:/destination.test' }]) {
  test('unsafe/unusable offer rejected, safe remaining offer preserved', async t => {
    const config = active(); config.offers = [invalid];
    const h = await harness({ config }); t.after(() => h.close()); await h.tick(); assert.equal(h.cta(), null);
    config.offers.push(offer()); await h.navigate(); await h.tick(); assert(h.cta());
    assert.equal(h.cta().querySelector('a').href, offer().url); h.noFallback();
  });
}
for (const [name, fetcher] of [
  ['network error', () => Promise.reject(new Error('fixture network'))],
  ['HTTP failure', () => Promise.resolve({ ...response(active()), ok: false, status: 503 })],
  ['redirect response', () => Promise.resolve({ ...response(active()), status: 302 })],
  ['redirected response', () => Promise.resolve({ ...response(active()), redirected: true })],
  ['malformed JSON', () => Promise.resolve({ ...response(null), json: async () => { throw new SyntaxError('fixture'); } })]
]) test(`${name} leaves no CTA and no static fallback`, async t => {
  const h = await harness({ fetcher }); t.after(() => h.close()); await h.tick(); assert.equal(h.cta(), null);
  assert.equal(h.fetches.length, 1); assert.equal(h.beacons.length, 0); h.noFallback();
});
for (const phase of ['fetch', 'body']) test(`10 second ${phase} timeout stays inert even when late success arrives`, async t => {
  const delayed = deferred();
  const h = await harness({ fetcher: () => phase === 'fetch' ? delayed.promise : Promise.resolve({ ...response(null), json: () => delayed.promise }) });
  t.after(() => h.close()); await h.tick(9999); assert.equal(h.fetches[0].options.signal.aborted, false);
  await h.tick(1); assert.equal(h.fetches[0].options.signal.aborted, true);
  delayed.resolve(phase === 'fetch' ? response(active()) : active()); await h.tick();
  assert.equal(h.cta(), null); assert.equal(h.registry.state, 'loading'); h.noFallback();
});
test('timeout remains effective without AbortController', async t => {
  const delayed = deferred(); const h = await harness({ auto: false, fetcher: () => delayed.promise }); t.after(() => h.close());
  h.w.AbortController = undefined; await h.load(); await h.tick(10000);
  delayed.resolve(response(active())); await h.tick(); assert.equal(h.cta(), null); h.noFallback();
});
for (const enabled of [false, undefined, 'true']) test('analytics not explicitly enabled creates no analytics resources', async t => {
  const config = active(); config.analytics = { enabled, event_schema_version: '0.1', collector_url: 'https://collector.test/v1/events' };
  const h = await harness({ config, intersection: true }); t.after(() => h.close()); await h.tick(); assert(h.cta());
  assert.equal(h.intersections.length, 0); assert.equal(h.beacons.length, 0);
  assert.equal(h.metrics.sessionReads, 0); assert.equal(h.metrics.sessionWrites, 0); h.noFallback();
});
for (const mode of ['no route', 'no matching offer']) test(`${mode} produces no CTA or analytics even when enabled`, async t => {
  const config = active(); config.analytics = { enabled: true, event_schema_version: '0.1', collector_url: 'https://collector.test/v1/events' };
  if (mode === 'no matching offer') config.offers = [offer('flight')];
  const h = await harness({ config, url: mode === 'no route' ? 'https://publisher.test/about' : undefined, intersection: true });
  t.after(() => h.close()); await h.tick(); assert.equal(h.cta(), null); assert.equal(h.beacons.length, 0);
  assert.equal(h.intersections.length, 0); assert.equal(h.metrics.sessionReads, 0); h.noFallback();
});
test('shutdown aborts, disconnects and removes listeners; retained stale callbacks stay inert', async t => {
  const config = active(); config.analytics = { enabled: true, event_schema_version: '0.1', collector_url: 'https://collector.test/v1/events' };
  const h = await harness({ config, intersection: true }); t.after(() => h.close()); await h.tick();
  const link = h.cta().querySelector('a'), observer = h.intersections[0], gen = h.registry.generation;
  h.registry.shutdown(); assert.equal(h.registry.state, 'disabled'); assert(h.registry.generation > gen);
  assert.equal(h.cta(), null); assert(observer.disconnected); assert(h.metrics.disconnections > 0);
  observer.emit(); link.dispatchEvent(new h.w.Event('click')); link.dispatchEvent(new h.w.Event('mouseenter'));
  assert.equal(h.beacons.length, 0); assert.equal(link.style.transform, '');
  await h.navigate(); await h.tick(); assert.equal(h.fetches.length, 1); h.noFallback();
});
test('shutdown while pending aborts request and prevents delayed success', async t => {
  const pending = deferred(); const h = await harness({ fetcher: () => pending.promise }); t.after(() => h.close());
  h.registry.shutdown(); assert.equal(h.fetches[0].options.signal.aborted, true);
  pending.resolve(response(active())); await h.tick(); assert.equal(h.cta(), null); h.noFallback();
});
for (const stale of ['success', 'failure']) test(`older ${stale} cannot mutate newer ${stale === 'success' ? 'failure' : 'success'}`, async t => {
  const old = deferred();
  const h = await harness({ fetcher: (_, __, n) => n === 1 ? old.promise :
    stale === 'success' ? Promise.reject(new Error('new failure')) : Promise.resolve(response(active())) });
  t.after(() => h.close()); await h.navigate(); await h.tick();
  const cta = h.cta(); if (stale === 'success') old.resolve(response(active())); else old.reject(new Error('old failure'));
  await h.tick(); assert.equal(h.cta(), cta); assert.equal(Boolean(h.cta()), stale === 'failure');
  assert.equal(h.fetches[0].options.signal.aborted, true); h.noFallback();
});
test('newer successful destination wins over older success and old JSON completion', async t => {
  const body = deferred(); const newer = active(); newer.offers = [offer('hotel', '_new')];
  const h = await harness({ fetcher: (_, __, n) => n === 1 ? Promise.resolve({ ...response(null), json: () => body.promise }) : Promise.resolve(response(newer)) });
  t.after(() => h.close()); await h.navigate(); await h.tick(); body.resolve(active()); await h.tick();
  assert.equal(h.cta().querySelector('a').href, newer.offers[0].url); h.noFallback();
});
test('navigation clears CTA synchronously and cancels delayed render', async t => {
  const h = await harness(); t.after(() => h.close()); await h.tick(); assert(h.cta());
  h.w.history.replaceState({}, '', '/post/new'); assert.equal(h.cta(), null);
  await h.tick(500); h.w.history.pushState({}, '', '/about'); await h.tick(); assert.equal(h.cta(), null);
  assert.equal(h.fetches.length, 3); h.noFallback();
});
test('MutationObserver detects navigation through a pre-existing history reference', async t => {
  const h = await harness({ auto: false }); t.after(() => h.close()); const original = h.w.history.pushState;
  await h.load(); await h.tick(); original.call(h.w.history, {}, '', '/post/other');
  h.d.body.append(h.d.createElement('section')); await settle(); assert.equal(h.cta(), null);
  await h.tick(); assert(h.cta()); assert.equal(h.fetches.length, 2); h.noFallback();
});
for (const url of ['http://publisher.test/post/guide', 'https://publisher.test:8443/post/guide']) {
  test('invalid current page origin stays inert', async t => {
    const h = await harness({ url }); t.after(() => h.close()); await h.tick(); assert.equal(h.cta(), null); h.noFallback();
  });
}
test('Checkpoint B trailing-dot origin normalization is accepted', async t => {
  const h = await harness({ url: 'https://publisher.test./post/guide' }); t.after(() => h.close()); await h.tick(); assert(h.cta());
});
test('analytics is optional, privacy-safe, placement-preserving and generation-bound', async t => {
  const config = active(); config.analytics = { enabled: true, event_schema_version: '0.1', collector_url: 'https://collector.test/v1/events' };
  const h = await harness({ config, intersection: true, url: 'https://publisher.test/post/guide?private=fixture#fragment' });
  t.after(() => h.close()); await h.tick(); const observer = h.intersections[0]; observer.emit(); observer.emit();
  assert.equal(h.beacons.length, 1); assert.equal(h.beacons[0].blob.type, 'text/plain;charset=utf-8');
  const payload = await new Promise((resolve, reject) => {
    const reader = new h.w.FileReader(); reader.onload = () => resolve(JSON.parse(reader.result)); reader.onerror = reject; reader.readAsText(h.beacons[0].blob);
  });
  assert.equal(payload.page_url, 'https://publisher.test/post/guide'); assert.equal('page_title' in payload, false);
  assert.equal(payload.placement, offer().placement); assert.equal(payload.trip_sub1, offer().placement);
  assert(!JSON.stringify(payload).includes(key)); assert.notEqual(payload.event_id, payload.session_id);
  const link = h.cta().querySelector('a'); const click = new h.w.Event('click', { cancelable: true });
  assert.equal(link.dispatchEvent(click), true); assert.equal(click.defaultPrevented, false); assert.equal(h.beacons.length, 2);
  await h.navigate(); observer.emit(); link.dispatchEvent(new h.w.Event('click')); assert.equal(h.beacons.length, 2); h.noFallback();
});
test('analytics transport/storage failure never blocks ordinary anchor', async t => {
  const config = active(); config.analytics = { enabled: true, event_schema_version: '0.1', collector_url: 'https://collector.test/v1/events' };
  const h = await harness({ auto: false, config }); t.after(() => h.close());
  h.w.Storage.prototype.getItem = () => { throw new Error('fixture'); };
  h.w.navigator.sendBeacon = () => { throw new Error('fixture'); };
  await h.load(); await h.tick(); assert(h.cta());
  const click = new h.w.Event('click', { cancelable: true }); assert.equal(h.cta().querySelector('a').dispatchEvent(click), true); h.noFallback();
});
