import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness, key, otherKey, runtime, settle } from './runtime-install-browser-v0.1.test.mjs';

for (const [name, attrs] of [['classic', {}], ['async', { async: '' }], ['defer', { defer: '' }],
  ['dynamic', { src: `${runtime}/nested/loader-v0.3.js?fixture=1` }],
  ['same-origin runtime', { src: 'https://publisher.test/runtime/loader-v0.3.js' }]]) {
  test(`${name} external loader captures script and derives exact fixed URLs`, async t => {
    const parsed = ['classic', 'async', 'defer'].includes(name);
    const html = parsed ? `<!doctype html><html><head><script ${name === 'classic' ? '' : name} src="${runtime}/runtime/loader-v0.3.js" data-chinaflow-install="${key}"></script></head><body><h1></h1><p></p></body></html>` : undefined;
    const h = await harness({ engine: false, loaderAttrs: attrs, auto: !parsed, html }); t.after(() => h.close());
    const origin = new URL(attrs.src || runtime).origin;
    const expected = new URL('/v1/config', origin); expected.searchParams.set('install_key', key);
    assert.equal(h.registry.configUrl, expected.href);
    assert.deepEqual(new URL(h.registry.configUrl).searchParams.getAll('install_key'), [key]);
    assert.equal([...new URL(h.registry.configUrl).searchParams].length, 1);
    assert.equal(h.registry.engineElement.src, `${origin}/runtime/chinaflow-v0.6.js`);
    assert.equal(h.registry.engineElement.type, ''); assert.equal(h.metrics.observers, 1);
    assert.equal(h.requests.filter(url => url.endsWith('/chinaflow-v0.6.js')).length, 1); h.noFallback();
  });
}
for (const [name, value] of [['missing', null], ['invalid', 'invalid'], ['uppercase', key.toUpperCase()],
  ['leading whitespace', ` ${key}`], ['trailing whitespace', `${key} `]]) {
  test(`${name} install is inert and malformed later invocation disables`, async t => {
    const first = await harness({ loaderAttrs: { 'data-chinaflow-install': value } }); t.after(() => first.close());
    assert.equal(first.registry, undefined); assert.equal(first.requests.length, 1); first.noFallback();
    const h = await harness(); t.after(() => h.close()); await h.tick();
    await h.load({ 'data-chinaflow-install': value }); assert.equal(h.registry.state, 'disabled'); assert.equal(h.cta(), null);
    await h.load(); assert.equal(h.registry.state, 'disabled'); assert.equal(h.registry.installKey, null); h.noFallback();
  });
}
test('missing currentScript is inert; later missing currentScript disables', async t => {
  const h = await harness({ auto: false }); t.after(() => h.close()); h.execute('loader-v0.3.js');
  assert.equal(h.requests.length, 0); await h.load(); await h.tick(); h.execute('loader-v0.3.js');
  assert.equal(h.registry.state, 'disabled'); assert.equal(h.cta(), null);
});
for (const src of ['http://runtime.test/runtime/loader-v0.3.js', '', 'data:text/javascript,void(0)']) {
  test('unusable source refuses bootstrap', async t => {
    const h = await harness({ auto: false }); t.after(() => h.close());
    const s = h.d.createElement('script'); s.type = 'application/json'; s.src = src;
    s.setAttribute('data-chinaflow-install', key); h.d.head.append(s); s.type = '';
    h.execute('loader-v0.3.js', s); assert.equal(h.registry, undefined); assert.equal(h.fetches.length, 0);
  });
}
test('inline, detached, module and non-script elements are not usable classic loaders', async t => {
  const h = await harness({ auto: false }); t.after(() => h.close());
  for (const kind of ['inline', 'detached', 'module', 'div']) {
    const s = h.d.createElement(kind === 'div' ? 'div' : 'script');
    s.setAttribute('data-chinaflow-install', key);
    if (kind !== 'inline') s.setAttribute('src', `${runtime}/runtime/loader-v0.3.js`);
    if (kind === 'module') s.type = 'module';
    if (kind !== 'detached') h.d.head.append(s);
    h.execute('loader-v0.3.js', s); assert.equal(h.registry, undefined);
  }
});
test('duplicate while loading and after activation keeps first bootstrap', async t => {
  const h = await harness({ engine: false }); t.after(() => h.close()); const engine = h.registry.engineElement;
  await h.load(); assert.equal(h.registry.engineElement, engine); assert.equal(h.metrics.observers, 1);
  h.execute('chinaflow-v0.6.js', engine); await h.tick(); await h.load();
  assert.equal(h.fetches.length, 1); assert.equal(h.d.querySelectorAll('#chinaflow-auto-cta').length, 1);
  assert.equal(h.requests.filter(url => url.endsWith('/chinaflow-v0.6.js')).length, 1); h.noFallback();
});
test('different valid key and incompatible release permanently conflict-disable', async t => {
  for (const incompatible of [false, true]) {
    const h = await harness(); t.after(() => h.close()); await h.tick();
    if (incompatible) h.registry.release = 'fixture-incompatible';
    await h.load({ 'data-chinaflow-install': incompatible ? key : otherKey });
    assert.equal(h.registry.state, 'disabled'); assert.equal(h.cta(), null);
    assert.equal(h.registry.configUrl, null); assert.equal(h.registry.engineElement, null);
    await h.load(); await h.tick(); assert.equal(h.fetches.length, 1); h.noFallback();
  }
});
for (const name of ['loader.js', 'loader-v0.2.js', 'chinaflow.js', 'chinaflow-v0.3.js', 'chinaflow-v0.4.js', 'chinaflow-v0.5.js', 'marked']) {
  test(`existing detectable legacy fixture (${name}) disables before engine load`, async t => {
    const h = await harness({ auto: false }); t.after(() => h.close());
    const s = h.d.createElement('script'); s.type = 'application/json';
    s.src = `https://fixture.test/${name}`;
    if (name === 'marked') s.setAttribute('data-chinaflow-loader', 'true');
    h.d.head.append(s); await h.load();
    assert.equal(h.registry.state, 'disabled'); assert.equal(h.fetches.length, 0);
    assert.equal(h.requests.length, 1); h.noFallback();
  });
}
test('later nested legacy insertion shuts down active runtime', async t => {
  const h = await harness(); t.after(() => h.close()); await h.tick();
  const container = h.d.createElement('div'); container.innerHTML = '<script src="https://fixture.test/chinaflow-v0.4.js"></script>';
  h.d.body.append(container); await settle(); assert.equal(h.registry.state, 'disabled'); assert.equal(h.cta(), null);
  const n = h.fetches.length; await h.navigate(); await h.tick(); assert.equal(h.fetches.length, n); h.noFallback();
});
test('legacy script marker attribute changes are detected', async t => {
  const h = await harness(); t.after(() => h.close()); await h.tick();
  const s = h.d.createElement('script'); s.type = 'application/json'; h.d.head.append(s);
  s.setAttribute('data-chinaflow-loader', 'true'); await settle(); assert.equal(h.registry.state, 'disabled'); assert.equal(h.cta(), null); h.noFallback();
});
test('all tenant/config/engine overrides ignored', async t => {
  const h = await harness({ loaderAttrs: Object.fromEntries(['config', 'engine', 'publisher', 'domain', 'supplier', 'placement']
    .map(name => [`data-chinaflow-${name}`, 'https://override.test/ignored'])) });
  t.after(() => h.close()); await h.tick(); assert(h.cta()); assert.equal(h.registry.runtimeOrigin, runtime);
  assert(h.requests.every(url => !url.includes('override.test'))); h.noFallback();
});
