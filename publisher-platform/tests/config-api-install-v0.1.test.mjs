import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { parseInstallRequestOrigin } from '../config-api-worker-v0.1.mjs';
import { fixture, key, migrations, seed } from './config-reader-install-v0.1.test.mjs';
import { inert, origin } from './config-builder-install-v0.1.test.mjs';
export function request(query = `install_key=${key}`, host = origin) {
  return new Request(`https://config.example.test/v1/config?${query}`, { headers: host === null ? {} : { Origin: host } });
}
for (const query of ['', `publisher_id=p1&install_key=${key}`, `install_key=${key}&install_key=${key}`,
  'install_key=', 'install_key=bad', `install_key=${key.toUpperCase()}`, `install_key=%20${key}`, `install_key=${key}%20`]) {
  test('invalid selector is generic 400 before lookup', async () => {
    const r = await worker.fetch(request(query), {}); assert.equal(r.status,400);
    assert.deepEqual(await r.json(),{error:'invalid_request'}); assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);
  });
}
for (const host of [null,'null','http://example.test','https://example.test:444','https://localhost','https://127.0.0.1',
  'https://[::1]','https://2130706433','https://example.test/','https://example.test/path','https://example.test?',
  'https://example.test#','https://user@example.test','https://example.test, https://other.test',
  'https://example.test https://other.test','https://example.test\\evil','https://-bad.test','https://example..test',
  'https://example.test..','https://%65xample.test','https://'+ 'a'.repeat(64)+'.test']) {
  test('invalid Origin rejected without lookup', async () => {
    const r = await worker.fetch(request(undefined,host),{}); assert.equal(r.status,403); assert.equal(await r.text(),'');
    assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);
  });
}
test('control characters rejected by strict parser', () => {
  for (const raw of ['https://exa\tmple.test','https://example.test\n','https://example.test\x00']) {
    assert.equal(parseInstallRequestOrigin({headers:{get:()=>raw}}),null);
  }
});
for (const [raw, normalized] of [['https://EXAMPLE.TEST','example.test'],['https://example.test.','example.test'],
  ['https://example.test:443','example.test'],['https://bücher.test','xn--bcher-kva.test']]) {
  test('normalization binds ASCII hostname and reflects accepted Origin', async t => {
    const f = fixture(t); f.sql.prepare("UPDATE publisher_domains SET hostname=? WHERE domain_id='d1'").run(normalized);
    const r = await worker.fetch(request(undefined,raw),{CHINAFLOW_EVENTS:f.database}); assert.equal(r.status,200);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'),raw); assert.equal((await r.json()).bound_origin,`https://${normalized}`);
  });
}
test('unknown and mismatched hosts have identical empty private responses', async t => {
  const f = fixture(t); const signatures=[];
  for (const [k,h] of [[`cfi_${'b'.repeat(32)}`,origin],[key,'https://other.test'],[key,'https://sub.example.test'],[key,'https://www.example.test']]) {
    const r=await worker.fetch(request(`install_key=${k}`,h),{CHINAFLOW_EVENTS:f.database});
    signatures.push([r.status,[...r.headers],await r.text()]);
    assert.equal(r.status,403); assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);
    assert.equal(r.headers.get('Cache-Control'),'no-store'); assert.equal(r.headers.get('Vary'),'Origin');
  }
  for(const signature of signatures) assert.deepEqual(signature,signatures[0]);
});
test('recognized draft returns exact inert JSON with CORS', async t => {
  const f=fixture(t); f.sql.exec("UPDATE publishers SET account_status='draft'");
  const r=await worker.fetch(request(),{CHINAFLOW_EVENTS:f.database}); assert.equal(r.status,200);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'),origin); assert.equal(r.headers.get('Cache-Control'),'no-store');
  assert.equal(r.headers.get('Vary'),'Origin'); assert.deepEqual(await r.json(),inert);
});
test('unexpected database failure returns generic 500 without CORS', async () => {
  const original=console.error; console.error=()=>{};
  try { const r=await worker.fetch(request(),{CHINAFLOW_EVENTS:{prepare(){throw Error('fixture failure');}}});
    assert.equal(r.status,500); assert.deepEqual(await r.json(),{error:'internal_error'});
    assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);
  } finally {console.error=original;}
});
test('isolated real workerd acceptance with local D1 only', async t => {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const { build } = await import('esbuild');
  const bundle = await build({entryPoints:[new URL('../config-api-worker-v0.1.mjs',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'browser'});
  const options={d1Persist:false, cf:false, telemetry:{enabled:false}, modules:true,
    script:bundle.outputFiles[0].text, compatibilityDate:'2026-08-14', d1Databases:['CHINAFLOW_EVENTS']};
  const mf=new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
  t.after(()=>mf.dispose()); const db=await mf.getD1Database('CHINAFLOW_EVENTS');
  // D1 exec accepts one SQL statement per line; prepare/batch preserves migration statements.
  for (const source of [...migrations,seed]) {
    const statements=source.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean);
    await db.batch(statements.map(s=>db.prepare(s)));
  }
  const fetch=async(q,h)=> {const req=request(q,h); return mf.dispatchFetch(req.url,{headers:req.headers});};
  const active=await fetch(); assert.equal(active.status,200); assert.equal((await active.json()).runtime_enabled,true);
  await db.prepare("UPDATE publishers SET account_status='draft' WHERE publisher_id='p1'").run();
  const draft=await fetch(); assert.equal(draft.status,200); assert.deepEqual(await draft.json(),inert);
  const unknown=await fetch(`install_key=cfi_${'b'.repeat(32)}`); const wrong=await fetch(undefined,'https://other.test');
  for(const r of [unknown,wrong]) {assert.equal(r.status,403);assert.equal(await r.text(),'');assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);}
  assert.equal((await fetch(`install_key=${key}&publisher_id=p1`)).status,400);
  const legacy=await fetch('publisher_id=p1'); assert.equal(legacy.status,200); const body=await legacy.json();
  assert.equal(body.version,'0.1'); assert.equal(body.publisher,'p1'); assert.deepEqual(body.offers,[]);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});
