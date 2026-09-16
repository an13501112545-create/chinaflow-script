import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM, requestInterceptor, VirtualConsole } from 'jsdom';

const root = new URL('../../', import.meta.url);
export const sources = Object.fromEntries(['loader-v0.3.js', 'chinaflow-v0.6.js', 'chinaflow-v0.4.js']
  .map(name => [name, readFileSync(new URL(name, root), 'utf8')]));
export const key = `cfi_${'a'.repeat(32)}`;
export const otherKey = `cfi_${'b'.repeat(32)}`;
export const runtime = 'https://runtime.test';
export const pageOrigin = 'https://publisher.test';
export const registryName = '__chinaflowSelfServiceRuntime';
export const offer = (product = 'hotel', suffix = '') => ({
  id: `${product}${suffix}`, enabled: true, product, placement: `fixture_${product}${suffix}`,
  url: `https://destination.test/${product}${suffix}?trip_sub1=fixture_${product}${suffix}`,
  eyebrow: 'PLAN YOUR CHINA TRIP', title: product === 'hotel' ? 'Find Hotels for Your China Trip' : 'Compare Flights for Your China Trip',
  subtitle: product === 'hotel' ? 'Compare hotel options and book your stay' : 'Check flight options and fares',
  icon: product === 'hotel' ? '▣' : '✈'
});
export const active = () => ({ version: '0.2', runtime_enabled: true, bound_origin: pageOrigin,
  analytics: { enabled: false }, rules: [], offers: [offer(), offer('flight')] });
export const inert = () => ({ version: '0.2', runtime_enabled: false,
  analytics: { enabled: false, event_schema_version: '0.1', collector_url: null }, rules: [], offers: [] });
export const response = value => ({ ok: true, status: 200, redirected: false, json: async () => value });
export function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
export async function settle() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); }

// All scripts and config responses are local fixtures. Unknown resources never reach a network.
// The virtual clock tests deadlines and render generations without wall-clock sleeps.
export async function harness({ config = active(), fetcher, url = `${pageOrigin}/post/guide`,
  title = 'China travel hotel', meta = '', body = '', width = 1000, engine = true,
  html, auto = true, loaderAttrs = {}, intersection = false } = {}) {
  const requests = [], fetches = [], beacons = [], errors = [], timers = new Map(), intersections = [];
  let clock = 0, timerId = 0, sessionReads = 0, sessionWrites = 0, observers = 0, disconnections = 0;
  const resources = { interceptors: [requestInterceptor(request => {
    const url = request.url;
    requests.push(url);
    const path = new URL(url).pathname;
    let source = '';
    if (path.endsWith('/loader-v0.3.js')) source = sources['loader-v0.3.js'];
    if (path === '/runtime/chinaflow-v0.6.js' && engine) source = sources['chinaflow-v0.6.js'];
    return new Response(source, { headers: { 'Content-Type': 'application/javascript' } });
  })] };
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html || '<!doctype html><html><head></head><body><h1></h1><p></p></body></html>', {
    url, runScripts: 'dangerously', resources, virtualConsole,
    beforeParse(window) {
      window.setTimeout = (fn, delay = 0) => { const id = ++timerId; timers.set(id, { fn, at: clock + delay }); return id; };
      window.clearTimeout = id => timers.delete(id);
      Object.defineProperty(window, 'innerWidth', { value: width });
      window.fetch = (url, options) => {
        requests.push(String(url)); fetches.push({ url: String(url), options });
        return fetcher ? fetcher(url, options, fetches.length) : Promise.resolve(response(config));
      };
      window.navigator.sendBeacon = (url, blob) => { beacons.push({ url, blob }); return true; };
      const get = window.Storage.prototype.getItem, set = window.Storage.prototype.setItem;
      window.Storage.prototype.getItem = function (...args) { sessionReads++; return get.apply(this, args); };
      window.Storage.prototype.setItem = function (...args) { sessionWrites++; return set.apply(this, args); };
      const Observer = window.MutationObserver;
      window.MutationObserver = class extends Observer {
        constructor(callback) { super(callback); observers++; }
        disconnect() { disconnections++; super.disconnect(); }
      };
      if (intersection) window.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; this.disconnected = false; intersections.push(this); }
        observe(target) { this.target = target; }
        disconnect() { this.disconnected = true; }
        emit() { this.callback([{ target: this.target, isIntersecting: true, intersectionRatio: 1 }]); }
      };
    }
  });
  const w = dom.window, d = w.document;
  if (d.querySelector('h1')) { d.querySelector('h1').textContent = title; d.querySelector('h1').innerText = title; }
  if (d.querySelector('p')) { d.querySelector('p').textContent = body; d.querySelector('p').innerText = body; }
  d.title = title;
  const description = d.createElement('meta'); description.name = 'description'; description.content = meta; d.head.append(description);
  const h = {
    w, d, dom, requests, fetches, beacons, errors, timers, intersections,
    get registry() { return d[registryName]; },
    get metrics() { return { sessionReads, sessionWrites, observers, disconnections }; },
    cta: () => d.querySelector('#chinaflow-auto-cta'),
    async tick(ms = 1000) {
      await settle(); const end = clock + ms;
      for (;;) {
        const due = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        clock = due[1].at; timers.delete(due[0]); due[1].fn(); await settle();
      }
      clock = end; await settle();
    },
    async load(attrs = {}) {
      const script = d.createElement('script');
      script.src = `${runtime}/runtime/loader-v0.3.js`;
      script.setAttribute('data-chinaflow-install', key);
      for (const [name, value] of Object.entries(attrs)) {
        if (value === null) script.removeAttribute(name); else script.setAttribute(name, value);
      }
      d.head.append(script); await settle(); return script;
    },
    execute(name, script = null) {
      // Only malformed/direct handoff cases need controlled currentScript simulation.
      Object.defineProperty(d, 'currentScript', { configurable: true, value: script });
      try { w.eval(sources[name]); } finally { delete d.currentScript; }
    },
    async navigate(path = '/post/next') { w.history.pushState({}, '', path); await settle(); },
    noFallback() {
      assert.equal(requests.some(url => /\/(?:loader(?:-v0\.2)?|manifest|config|chinaflow-v0\.[45])\.(?:js|json)(?:[?#]|$)/.test(url)), false);
      assert(requests.every(url => ['runtime.test', 'publisher.test'].includes(new URL(url).hostname)));
    },
    close() { h.registry?.disable(); dom.window.close(); }
  };
  await settle();
  if (auto) await h.load(loaderAttrs);
  return h;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, config, expected] of [['active', active(), 1], ['canonical inert', inert(), 0]]) {
    test(`local external loader -> engine -> ${name} config -> CTA`, async t => {
      const h = await harness({ config }); t.after(() => h.close()); await h.tick();
      assert.equal(h.d.querySelectorAll('#chinaflow-auto-cta').length, expected);
      assert.equal(h.fetches.length, 1); assert.equal(h.errors.length, 0);
      assert.equal(h.metrics.observers, 1); h.noFallback();
    });
  }
  test('failed config and active then failure remove old destination', async t => {
    let fail = false;
    const h = await harness({ fetcher: () => fail ? Promise.reject(new Error('fixture')) : Promise.resolve(response(active())) });
    t.after(() => h.close()); await h.tick(); assert(h.cta()); fail = true;
    const old = h.cta(); h.w.history.pushState({}, '', '/post/failure');
    assert.equal(h.cta(), null); assert.equal(old.isConnected, false);
    await h.tick(); assert.equal(h.cta(), null); h.noFallback();
    const failed = await harness({ fetcher: () => Promise.reject(new Error('fixture')) });
    t.after(() => failed.close()); await failed.tick(); assert.equal(failed.cta(), null); failed.noFallback();
  });
  test('overlapping config responses cannot resurrect a failed newer page', async t => {
    const older = deferred();
    const h = await harness({ fetcher: (_, __, n) => n === 1 ? older.promise : Promise.reject(new Error('newer failed')) });
    t.after(() => h.close()); await h.navigate(); older.resolve(response(active())); await h.tick();
    assert.equal(h.cta(), null); assert.equal(h.fetches.length, 2); h.noFallback();
  });
  test('duplicate loading/active bootstrap is safe; conflicting tenant permanently disables', async t => {
    const h = await harness(); t.after(() => h.close()); await h.load(); await h.tick(); await h.load();
    assert.equal(h.d.querySelectorAll('#chinaflow-auto-cta').length, 1);
    assert.equal(h.fetches.length, 1); assert.equal(h.metrics.observers, 1);
    await h.load({ 'data-chinaflow-install': otherKey });
    assert.equal(h.cta(), null); assert.equal(h.registry.state, 'disabled');
    await h.load(); await h.tick(); assert.equal(h.cta(), null); assert.equal(h.fetches.length, 1); h.noFallback();
  });
  test('SPA cleanup: one observer, fresh CTA, disabled analytics has no session or beacon', async t => {
    const h = await harness(); t.after(() => h.close()); await h.tick(); const old = h.cta();
    await h.navigate(); assert.equal(h.cta(), null); await h.tick();
    assert(h.cta()); assert.notEqual(h.cta(), old); assert.equal(h.fetches.length, 2);
    await h.tick(3000); assert.equal(h.fetches.length, 2); assert.equal(h.metrics.observers, 1);
    assert.equal(h.beacons.length, 0); assert.equal(h.metrics.sessionReads, 0); assert.equal(h.metrics.sessionWrites, 0);
    h.noFallback();
  });
}
