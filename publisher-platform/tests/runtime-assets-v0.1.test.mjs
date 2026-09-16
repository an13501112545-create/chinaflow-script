import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { fixture, key, migrations, seed } from './config-reader-install-v0.1.test.mjs';
import { inert, origin } from './config-builder-install-v0.1.test.mjs';
import originalWorker from '../config-api-worker-v0.1.mjs';

const root = new URL('../../', import.meta.url);
const built = await build({ entryPoints: [new URL('../config-api-worker-v0.1.mjs', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'browser', minify: false });
const worker = (await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)).default;
const routes = [
  ['/runtime/loader.js', 'loader-v0.3.js', 'no-store'],
  ['/runtime/loader-v0.3.js', 'loader-v0.3.js', 'public, max-age=31536000, immutable'],
  ['/runtime/chinaflow-v0.6.js', 'chinaflow-v0.6.js', 'public, max-age=31536000, immutable']
];
const forbiddenEnv = new Proxy({}, { get() { assert.fail('Runtime request touched env/D1'); } });
const request = (path, method = 'GET') => new Request(`https://runtime.example.test${path}`, { method });
const fetch = (path, method) => worker.fetch(request(path, method), forbiddenEnv);
function headers(response, cache) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/javascript; charset=utf-8');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Cache-Control'), cache);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'cross-origin');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  for (const name of ['Set-Cookie', 'Location', 'Access-Control-Allow-Credentials', 'Content-Security-Policy']) {
    assert.equal(response.headers.get(name), null);
  }
}
for (const [path, file, cache] of routes) {
  test(`GET and HEAD exact bytes and headers: ${path}`, async () => {
    const get = await fetch(path); headers(get, cache);
    const source = readFileSync(new URL(file, root));
    assert.deepEqual(source, execFileSync('git', ['show', `HEAD:${file}`], { cwd: root }));
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), source);
    const head = await fetch(path, 'HEAD'); headers(head, cache);
    assert.deepEqual([...head.headers], [...get.headers]);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  });
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    test(`${method} rejected without D1: ${path}`, async () => {
      const r = await fetch(path, method); assert.equal(r.status, 405);
      assert.equal(r.headers.get('Allow'), 'GET, HEAD'); assert.equal(await r.text(), '');
      assert.equal(r.headers.get('Location'), null);
    });
  }
  test(`query cannot select another file: ${path}`, async () => {
    const r = await fetch(`${path}?file=config.json&path=../manifest.json&asset=loader.js`);
    headers(r, cache); assert.deepEqual(Buffer.from(await r.arrayBuffer()), readFileSync(new URL(file, root)));
  });
}
const unknown = ['/runtime', '/runtime/', '/runtime/unknown.js', '/runtime/config.json',
  '/runtime/manifest.json', '/runtime/../config.json', '/runtime/%2e%2e/config.json',
  '/runtime/%2E%2E%2Fconfig.json', '/runtime/..%5cconfig.json', '/runtime/%252e%252e%252fconfig.json',
  '/runtime/%2floader.js', '/runtime/loader.js/', '/runtime/Loader.js', '/runtime/loader.js.map',
  '/runtime/loader-v0.3.js.bak', '/runtime/chinaflow-v0.6.js.extra', '/runtime/loader-v0.2.js',
  '/runtime/chinaflow-v0.4.js', '/runtime/chinaflow-v0.5.js', '/runtime/?file=loader-v0.3.js',
  '/runtime/unknown.js?file=loader-v0.3.js', '/runtime/loader%2ejs'];
for (const path of unknown) test(`unknown/attack path safely rejected: ${path}`, async () => {
  for (const method of ['GET', 'HEAD', 'POST']) {
    const r = await fetch(path, method); assert.equal(r.status, 404);
    assert.equal(await r.text(), ''); assert.equal(r.headers.get('Location'), null);
    assert.equal(r.headers.get('Set-Cookie'), null);
  }
});
test('config responses remain identical with bundled assets and retain tenant CORS', async t => {
  const f = fixture(t);
  for (const status of ['active', 'draft']) {
    f.sql.prepare('UPDATE publishers SET account_status=? WHERE publisher_id=?').run(status, 'p1');
    for (const query of ['publisher_id=p1', `install_key=${key}`, 'publisher_id=unknown',
      `install_key=cfi_${'b'.repeat(32)}`, '', 'install_key=bad']) {
      for (const host of [origin, 'https://other.test']) {
        const req = new Request(`https://runtime.example.test/v1/config?${query}`, { headers: { Origin: host } });
        const expected = await originalWorker.fetch(req, { CHINAFLOW_EVENTS: f.database });
        const actual = await worker.fetch(req, { CHINAFLOW_EVENTS: f.database });
        assert.equal(actual.status, expected.status); assert.deepEqual([...actual.headers], [...expected.headers]);
        assert.equal(await actual.text(), await expected.text());
        assert.notEqual(actual.headers.get('Access-Control-Allow-Origin'), '*');
        if (actual.status !== 200) assert.equal(actual.headers.get('Access-Control-Allow-Origin'), null);
      }
    }
  }
});
test('actual Wrangler packaging and isolated workerd acceptance (local only)', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'chinaflow-c2-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync(new URL('node_modules/.bin/wrangler', root).pathname, ['deploy', '--dry-run', '--config',
    'wrangler.publisher-config-api.test.jsonc', '--outdir', directory], {
    cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: 'pipe'
  });
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const options = { modules: true, script: readFileSync(join(directory, 'config-api-worker-v0.1.js'), 'utf8'),
    compatibilityDate: '2026-08-14', d1Databases: ['CHINAFLOW_EVENTS'], d1Persist: false,
    cf: false, telemetry: { enabled: false } };
  const mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  t.after(() => mf.dispose());
  for (const [path, file, cache] of routes) {
    const r = await mf.dispatchFetch(request(path).url); headers(r, cache);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), readFileSync(new URL(file, root)));
    const head = await mf.dispatchFetch(request(path).url, { method: 'HEAD' });
    headers(head, cache); assert.equal(await head.text(), '');
  }
  assert.equal((await mf.dispatchFetch(request('/runtime/unknown.js').url)).status, 404);
  const post = await mf.dispatchFetch(request('/runtime/loader.js').url, { method: 'POST' });
  assert.equal(post.status, 405); assert.equal(post.headers.get('Allow'), 'GET, HEAD');
  const db = await mf.getD1Database('CHINAFLOW_EVENTS');
  for (const source of [...migrations, seed]) {
    const statements = source.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
    await db.batch(statements.map(s => db.prepare(s)));
  }
  const config = query => mf.dispatchFetch(`https://runtime.example.test/v1/config?${query}`, { headers: { Origin: origin } });
  const active = await config(`install_key=${key}`); assert.equal(active.status, 200);
  assert.equal(active.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal((await active.json()).runtime_enabled, true);
  await db.prepare("UPDATE publishers SET account_status='draft' WHERE publisher_id='p1'").run();
  assert.deepEqual(await (await config(`install_key=${key}`)).json(), inert);
  const legacy = await config('publisher_id=p1'); assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).publisher, 'p1');
  const denied = await config(`install_key=cfi_${'b'.repeat(32)}`);
  assert.equal(denied.status, 403); assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
});
