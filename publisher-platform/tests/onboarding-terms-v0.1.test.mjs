import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import worker from '../app-worker-v0.1.mjs';
import { createSession } from '../auth-session-store-v0.1.mjs';
import { TERMS_VERSION } from '../onboarding-terms-v0.1.mjs';

const valid = { terms_version: TERMS_VERSION, accepted: true };
const TEST_APP_ORIGIN = "https://app.getchinaflow.com";
async function fixture(t) {
  const sql = new DatabaseSync(':memory:');
  t.after(() => sql.close());
  sql.exec('PRAGMA foreign_keys=ON');
  const dir = new URL('../../collector/migrations/', import.meta.url);
  const files = readdirSync(dir).filter(n => /^000[1-6]_.*\.sql$/.test(n)).sort();
  assert.equal(files.length, 6);
  for (const file of files) sql.exec(readFileSync(new URL(file, dir), 'utf8'));
  sql.exec(`INSERT INTO publisher_users(user_id,email,email_normalized) VALUES ('u1','a@example.test','a@example.test'),('u2','b@example.test','b@example.test');
    INSERT INTO publishers(publisher_id,slug,display_name,updated_at) VALUES ('p1','p1','Example','2000-01-01'),('p2','p2','Other','2000-01-01');
    INSERT INTO publisher_memberships(membership_id,publisher_id,user_id) VALUES ('m1','p1','u1'),('m2','p1','u2');
    INSERT INTO publisher_domains(domain_id,publisher_id,hostname,is_primary) VALUES ('d1','p1','example.test',1);
    CREATE TABLE acceptance_mutations(n INTEGER);
    CREATE TRIGGER count_acceptance AFTER UPDATE ON publishers BEGIN INSERT INTO acceptance_mutations VALUES (1); END;`);
  const state = { before: null };
  const db = { prepare(query) { return { bind(...args) { return {
    async first() {
      if (query.startsWith('UPDATE publishers')) { const hook = state.before; state.before = null; hook?.(); }
      return sql.prepare(query).get(...args) ?? null;
    },
    async all() { return { results: sql.prepare(query).all(...args) }; },
    async run() { return { meta: sql.prepare(query).run(...args) }; }
  }; } }; } };
  const sessions = [await createSession(db, 'u1'), await createSession(db, 'u2')];
  const publisher = () => ({ ...sql.prepare("SELECT * FROM publishers WHERE publisher_id='p1'").get() });
  const snapshot = () => Object.fromEntries(sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('publishers','acceptance_mutations') ORDER BY name").all()
    .map(({ name }) => [name, sql.prepare(`SELECT * FROM ${name}`).all()]));
  async function request({ body = valid, token = sessions[0].token, origin = TEST_APP_ORIGIN, appOrigin = TEST_APP_ORIGIN,
    type = 'application/json; charset=UTF-8', path = '/api/onboarding/terms', method = 'POST' } = {}) {
    const headers = {};
    if (origin !== null) headers.Origin = origin;
    if (token !== null) headers.Cookie = `__Host-chinaflow_session=${token}`;
    if (type !== null) headers['Content-Type'] = type;
    const requestEnv = { CHINAFLOW_EVENTS: db };
    if (appOrigin !== null) requestEnv.APP_ORIGIN = appOrigin;
    const response = await worker.fetch(new Request(`${TEST_APP_ORIGIN}${path}`, { method, headers,
      ...(method === 'GET' ? {} : { body: typeof body === 'string' || body instanceof Uint8Array || body instanceof ReadableStream ? body : JSON.stringify(body), duplex: 'half' })
    }), requestEnv);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    return { status: response.status, body: await response.json() };
  }
  return { sql, state, sessions, publisher, snapshot, request };
}

test('migration is nullable, additive, no backfill and restrictive actor FK', async t => {
  const f = await fixture(t);
  assert.equal(f.publisher().terms_accepted_by_user_id, null);
  const fk = f.sql.prepare('PRAGMA foreign_key_list(publishers)').all().find(r => r.from === 'terms_accepted_by_user_id');
  assert.equal(fk.table, 'publisher_users'); assert.equal(fk.to, 'user_id');
  assert.equal(fk.on_delete, 'RESTRICT'); assert.equal(fk.on_update, 'RESTRICT');
  assert.throws(() => f.sql.exec("UPDATE publishers SET terms_accepted_by_user_id='missing'"), /FOREIGN KEY/);
  await f.request();
  f.sql.exec("DELETE FROM publisher_memberships; DELETE FROM publisher_sessions");
  assert.throws(() => f.sql.exec("DELETE FROM publisher_users WHERE user_id='u1'"), /FOREIGN KEY/);
  assert.throws(() => f.sql.exec("UPDATE publisher_users SET user_id='changed' WHERE user_id='u1'"), /FOREIGN KEY/);
  assert.deepEqual(f.sql.prepare('PRAGMA foreign_key_check').all(), []);
});

test('GET reports current terms state without mutation and tracks acceptance', async t => {
  const f = await fixture(t);
  const before = f.publisher();

  const initial = await f.request({
    method: 'GET',
    origin: null,
    type: null
  });

  assert.deepEqual(initial, {
    status: 200,
    body: {
      terms: {
        terms_version: TERMS_VERSION,
        accepted: false,
        terms_accepted_at: null
      }
    }
  });

  assert.deepEqual(f.publisher(), before);
  assert.equal(
    f.sql.prepare('SELECT count(*) n FROM acceptance_mutations').get().n,
    0
  );

  const accepted = await f.request();
  assert.equal(accepted.status, 200);

  const current = await f.request({
    method: 'GET',
    origin: null,
    type: null
  });

  assert.equal(current.status, 200);
  assert.equal(current.body.terms.terms_version, TERMS_VERSION);
  assert.equal(current.body.terms.accepted, true);
  assert.equal(
    current.body.terms.terms_accepted_at,
    accepted.body.terms.terms_accepted_at
  );
  assert.equal(current.body.terms.terms_accepted_by_user_id, undefined);

  assert.equal(
    f.sql.prepare('SELECT count(*) n FROM acceptance_mutations').get().n,
    1
  );
});

for (const [label, mutate, expected] of [
  ['removed membership', f => f.sql.exec(
    "UPDATE publisher_memberships SET membership_status='removed' WHERE user_id='u1'"
  ), 403],
  ['non-owner membership', f => f.sql.exec(
    "UPDATE publisher_memberships SET role='member' WHERE user_id='u1'"
  ), 403],
  ['ambiguous ownership', f => f.sql.exec(
    "INSERT INTO publisher_memberships(membership_id,publisher_id,user_id) VALUES ('amb-get','p2','u1')"
  ), 409],
  ['non-draft publisher', f => f.sql.exec(
    "UPDATE publishers SET account_status='active' WHERE publisher_id='p1'"
  ), 409],
  ['missing primary domain', f => f.sql.exec(
    "DELETE FROM publisher_domains WHERE publisher_id='p1'"
  ), 409]
]) {
  test(`GET terms state fails closed: ${label}`, async t => {
    const f = await fixture(t);

    mutate(f);

    const before = f.publisher();
    const mutationsBefore =
      f.sql.prepare(
        'SELECT count(*) n FROM acceptance_mutations'
      ).get().n;

    const result = await f.request({
      method: 'GET',
      origin: null,
      type: null
    });

    assert.deepEqual(result, {
      status: expected,
      body: {
        error:
          expected === 403
            ? 'forbidden'
            : 'conflict'
      }
    });

    assert.deepEqual(f.publisher(), before);

    assert.equal(
      f.sql.prepare(
        'SELECT count(*) n FROM acceptance_mutations'
      ).get().n,
      mutationsBefore
    );
  });
}

for (const token of [null, 'bad', 'a'.repeat(64)]) {
  test(`GET terms state rejects invalid session ${String(token).slice(0,12)}`, async t => {
    const f = await fixture(t);

    assert.deepEqual(
      await f.request({
        method: 'GET',
        token,
        origin: null,
        type: null
      }),
      {
        status: 401,
        body: { error: 'unauthenticated' }
      }
    );
  });
}

test('GET terms state rejects query selectors', async t => {
  const f = await fixture(t);

  assert.deepEqual(
    await f.request({
      method: 'GET',
      origin: null,
      type: null,
      path: '/api/onboarding/terms?publisher_id=p2'
    }),
    {
      status: 400,
      body: { error: 'invalid_input' }
    }
  );
});

for (const different of [false, true]) test(`concurrent acceptance and immutable retries: different owners=${different}`, async t => {
  const f = await fixture(t); const before = f.publisher(); const protectedBefore = f.snapshot();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => f.request({ token: f.sessions[different ? i % 2 : 0].token })));
  for (const r of results) { assert.equal(r.status, 200); assert.deepEqual(r.body, results[0].body); }
  const accepted = f.publisher();
  assert.equal(accepted.terms_version, TERMS_VERSION);
  assert.match(accepted.terms_accepted_at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(accepted.updated_at, accepted.terms_accepted_at);
  assert.ok(['u1','u2'].includes(accepted.terms_accepted_by_user_id));
  for (const session of f.sessions) assert.deepEqual((await f.request({ token: session.token })).body, results[0].body);
  assert.deepEqual(f.publisher(), accepted);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM acceptance_mutations').get().n, 1);
  for (const key of Object.keys(before).filter(k => !['terms_version','terms_accepted_at','terms_accepted_by_user_id','updated_at'].includes(k))) assert.equal(accepted[key], before[key]);
  assert.deepEqual(f.snapshot(), protectedBefore);
  assert.equal(results[0].body.terms.terms_accepted_by_user_id, undefined);
});

const mutations = [
  ["UPDATE publisher_sessions SET revoked_at=CURRENT_TIMESTAMP",401],
  ["UPDATE publisher_sessions SET expires_at='2000-01-01'",401],
  ["UPDATE publisher_users SET user_status='disabled'",401],
  ["UPDATE publisher_memberships SET membership_status='removed'",403],
  ["UPDATE publisher_memberships SET membership_status='invited'",403],
  ["DELETE FROM publisher_memberships",403],
  ["UPDATE publisher_memberships SET role='admin'",403],
  ["UPDATE publisher_memberships SET role='member'",403],
  ["INSERT INTO publisher_memberships(membership_id,publisher_id,user_id) VALUES ('amb','p2','u1')",409],
  ["UPDATE publishers SET account_status='active'",409],
  ["DELETE FROM publisher_domains",409],
  ["UPDATE publisher_memberships SET publisher_id='p2' WHERE user_id='u1'",409,403]
];
for (const [mutation, status, boundaryStatus = status] of mutations) for (const boundary of [false,true]) test(`authorization ${boundary ? 'at mutation' : 'before request'}: ${mutation}`, async t => {
  const f = await fixture(t);
  if (boundary) f.state.before = () => f.sql.exec(mutation); else f.sql.exec(mutation);
  assert.equal((await f.request()).status, boundary ? boundaryStatus : status);
  assert.equal(f.publisher().terms_version, null);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM publishers WHERE terms_version IS NOT NULL').get().n, 0);
});
for (const access of ['owner', 'unauthorized', 'cross-tenant']) for (const boundary of (access === 'cross-tenant' ? [true] : [false, true]))
  for (const primary of (access === 'owner' ? [false] : [false, true])) test(`primary domain privacy and zero writes: ${access}, primary=${primary}, boundary=${boundary}`, async t => {
    const f = await fixture(t);
    const mutate = () => {
      if (!primary) f.sql.exec('DELETE FROM publisher_domains');
      if (access === 'unauthorized') f.sql.exec("UPDATE publisher_memberships SET role='member' WHERE user_id='u1'");
      if (access === 'cross-tenant') f.sql.exec("UPDATE publisher_memberships SET publisher_id='p2' WHERE user_id='u1'");
    };
    // Cross-tenant case loses access to the pinned publisher at the write boundary.
    if (boundary) f.state.before = mutate; else mutate();
    const before = f.sql.prepare('SELECT * FROM publishers ORDER BY publisher_id').all();
    const status = access === 'owner' ? 409 : 403;
    assert.deepEqual(await f.request(), { status, body: { error: status === 409 ? 'conflict' : 'forbidden' } });
    assert.deepEqual(f.sql.prepare('SELECT * FROM publishers ORDER BY publisher_id').all(), before);
    assert.equal(f.sql.prepare('SELECT count(*) n FROM acceptance_mutations').get().n, 0);
  });
for (let mask=1; mask<8; mask++) test(`stored partial/unsupported acceptance mask ${mask}`, async t => {
  const f = await fixture(t);
  f.sql.prepare("UPDATE publishers SET terms_version=?,terms_accepted_at=?,terms_accepted_by_user_id=? WHERE publisher_id='p1'").run(mask&1 ? (mask===7 ? 'old' : TERMS_VERSION) : null, mask&2 ? '2020-01-01' : null, mask&4 ? 'u1' : null);
  const before = f.publisher();
  assert.equal((await f.request({method:'GET',origin:null,type:null})).status,409);
  assert.equal((await f.request()).status,409);
  assert.deepEqual(f.publisher(),before);
});
test('non-draft retry conflicts', async t => { const f=await fixture(t); await f.request(); f.sql.exec("UPDATE publishers SET account_status='pending_review'"); const before=f.publisher(); assert.equal((await f.request()).status,409); assert.deepEqual(f.publisher(),before); });

for (const appOrigin of [
  null,
  '',
  'not an origin',
  'http://app.getchinaflow.com',
  'https://app.getchinaflow.com/',
  'https://app.getchinaflow.com:443'
]) {
  test(`POST fails closed for configured APP_ORIGIN ${appOrigin}`, async t => {
    const f = await fixture(t);
    assert.deepEqual(
      await f.request({ appOrigin }),
      { status: 500, body: { error: 'internal_error' } }
    );
    assert.equal(f.publisher().terms_version, null);
    assert.equal(f.sql.prepare('SELECT count(*) n FROM acceptance_mutations').get().n, 0);
  });
}

const badRequests = [
  ...[null,'null','https://foreign.test','http://app.getchinaflow.com','https://app.getchinaflow.com/','https://app.getchinaflow.com:443','https://app.getchinaflow.com:8443','https://app.getchinaflow.com.evil.test','not an origin'].map(origin=>[{origin},403]),
  ...[null,'bad','a'.repeat(64)].map(token=>[{token},401]),
  ...['text/plain','application/jsonp','application/json; charset=latin1',null].map(type=>[{type},415]),
  [{method:'PUT'},405], [{path:'/api/onboarding/terms?publisher_id=p2'},400],
  ...['{','null','[]','{}','true', '{"accepted":true}', '{"terms_version":1,"accepted":true}', '{"terms_version":"chinaflow-publisher-terms-v1","accepted":"true"}'].map(body=>[{body},400]),
  ...['older','chinaflow-publisher-terms-v0','chinaflow-publisher-terms-v2',''].map(terms_version=>[{body:{...valid,terms_version}},409]),
  ...[false,1,null].map(accepted=>[{body:{...valid,accepted}},400]),
  ...['publisher_id','user_id','membership_id','role','account_status','terms_accepted_at','terms_accepted_by_user_id','domain_id','hostname','supplier','affiliate_url','timestamp','tenant_id','__proto__'].map(key=>[{body:{...valid,[key]:'forged'}},400]),
  [{body:new Uint8Array([0xc3,0x28])},400], [{body:' '.repeat(4097)},413]
];
for (const [options,status] of badRequests) test(`request rejection ${JSON.stringify(options).slice(0,100)}`,async t=>{
  const f=await fixture(t); const before=f.publisher(); const protectedBefore=f.snapshot();
  assert.deepEqual(await f.request(options),{status,body:{error:({400:'invalid_input',401:'unauthenticated',403:'forbidden',405:'method_not_allowed',409:'conflict',413:'payload_too_large',415:'unsupported_media_type'})[status]}});
  assert.deepEqual(f.publisher(),before); assert.deepEqual(f.snapshot(),protectedBefore);
});
test('streamed byte limit and valid chunked UTF-8',async t=>{
  const f=await fixture(t);
  const stream = chunks => new ReadableStream({ start(c) { for(const chunk of chunks)c.enqueue(chunk); c.close(); } });
  assert.equal((await f.request({body:stream([new Uint8Array(2048),new Uint8Array(2049)])})).status,413);
  assert.equal(f.publisher().terms_version,null);
  const bytes=new TextEncoder().encode(JSON.stringify(valid));
  assert.equal((await f.request({body:stream([bytes.slice(0,13),bytes.slice(13)])})).status,200);
});
test('unexpected database failure is generic',async t=>{
  const f=await fixture(t); f.state.before=()=>{throw new Error('injected database failure');};
  const original=console.error; console.error=()=>{}; t.after(()=>{console.error=original;});
  assert.deepEqual(await f.request(),{status:500,body:{error:'internal_error'}});
  assert.equal(f.publisher().terms_version,null);
});

test('real local workerd/D1: concurrent owners, retry, denial, immutable attribution and protected tables', async t => {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const { build } = await import('esbuild');
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../app-worker-v0.1.mjs', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const adapt = convertV4MiniflareOptions ?? (options => options);
  const mf = new Miniflare(adapt({ d1Persist: false, workers: [{ name: "terms-local", modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-09-01', bindings: { APP_ORIGIN: TEST_APP_ORIGIN },
    d1Databases: { CHINAFLOW_EVENTS: 'terms-isolated-local' },
    }] }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('CHINAFLOW_EVENTS');
  const dir = new URL('../../collector/migrations/', import.meta.url);
  for (const file of readdirSync(dir).filter(n => /^000[1-6]_.*\.sql$/.test(n)).sort()) {
    const statements = readFileSync(new URL(file,dir),'utf8').replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean);
    for (const statement of statements) await db.prepare(statement).run();
  }
  assert.equal((await db.prepare('PRAGMA foreign_keys').first()).foreign_keys,1);
  await db.prepare("INSERT INTO publisher_users(user_id,email,email_normalized) VALUES ('u1','a@example.test','a@example.test'),('u2','b@example.test','b@example.test')").run();
  await db.prepare("INSERT INTO publishers(publisher_id,slug,display_name) VALUES ('p1','p1','Example')").run();
  await db.prepare("INSERT INTO publisher_memberships(membership_id,publisher_id,user_id) VALUES ('m1','p1','u1'),('m2','p1','u2')").run();
  await db.prepare("INSERT INTO publisher_domains(domain_id,publisher_id,hostname,is_primary) VALUES ('d1','p1','example.test',1)").run();
  await db.prepare('CREATE TABLE acceptance_mutations(n INTEGER)').run();
  await db.prepare('CREATE TRIGGER count_acceptance AFTER UPDATE ON publishers BEGIN INSERT INTO acceptance_mutations VALUES (1); END').run();
  const sessions = [await createSession(db,'u1'),await createSession(db,'u2')];
  const snapshot = async () => {
    const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT IN ('publishers','acceptance_mutations') ORDER BY name").all()).results;
    return Promise.all(tables.map(async ({name})=>[name,(await db.prepare(`SELECT * FROM ${name}`).all()).results]));
  };
  const before=await snapshot();
  const request = async token => {
    const r=await mf.dispatchFetch('https://app.getchinaflow.com/api/onboarding/terms',{method:'POST',headers:{Origin:'https://app.getchinaflow.com','Content-Type':'application/json',Cookie:`__Host-chinaflow_session=${token}`},body:JSON.stringify(valid)});
    return {status:r.status,body:await r.json()};
  };
  const draft = await db.prepare('SELECT * FROM publishers').first();
  await db.prepare('UPDATE publisher_domains SET is_primary=0').run();
  assert.deepEqual(await request(sessions[0].token), { status: 409, body: { error: 'conflict' } });
  assert.deepEqual(await db.prepare('SELECT * FROM publishers').first(), draft);
  assert.equal((await db.prepare('SELECT count(*) n FROM acceptance_mutations').first()).n, 0);
  await db.prepare("UPDATE publisher_memberships SET membership_status='removed' WHERE user_id='u2'").run();
  assert.deepEqual(await request(sessions[1].token), { status: 403, body: { error: 'forbidden' } });
  await db.prepare('UPDATE publisher_domains SET is_primary=1').run();
  assert.deepEqual(await request(sessions[1].token), { status: 403, body: { error: 'forbidden' } });
  assert.deepEqual(await db.prepare('SELECT * FROM publishers').first(), draft);
  assert.equal((await db.prepare('SELECT count(*) n FROM acceptance_mutations').first()).n, 0);
  await db.prepare("UPDATE publisher_memberships SET membership_status='active' WHERE user_id='u2'").run();
  const results=await Promise.all(Array.from({length:8},(_,i)=>request(sessions[i%2].token)));
  for(const r of results){assert.equal(r.status,200);assert.deepEqual(r.body,results[0].body);}
  const accepted=await db.prepare('SELECT * FROM publishers').first();
  assert.equal(accepted.terms_version,TERMS_VERSION);
  assert.ok(accepted.terms_accepted_at); assert.ok(accepted.terms_accepted_by_user_id);
  assert.equal(accepted.updated_at,accepted.terms_accepted_at);
  for(const session of sessions) assert.deepEqual(await request(session.token),results[0]);
  assert.deepEqual(await db.prepare('SELECT * FROM publishers').first(),accepted);
  assert.equal((await db.prepare('SELECT count(*) n FROM acceptance_mutations').first()).n,1);
  assert.deepEqual(await snapshot(),before);
  await db.prepare("UPDATE publisher_memberships SET membership_status='removed' WHERE user_id='u2'").run();
  assert.equal((await request(sessions[1].token)).status,403);
  await db.prepare("UPDATE publisher_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id='u1'").run();
  assert.equal((await request(sessions[0].token)).status,401);
  assert.deepEqual(await db.prepare('SELECT * FROM publishers').first(),accepted);
  assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results,[]);
});

test('migration preserves historical acceptance without inferring an actor', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    sql.exec('PRAGMA foreign_keys=ON');
    const dir=new URL('../../collector/migrations/',import.meta.url);
    for(const file of readdirSync(dir).filter(n=>/^000[1-5]_.*\.sql$/.test(n)).sort()) sql.exec(readFileSync(new URL(file,dir),'utf8'));
    sql.exec(`INSERT INTO publisher_users(user_id,email,email_normalized) VALUES ('historical','history@example.test','history@example.test');
      INSERT INTO publishers(publisher_id,slug,display_name,terms_version,terms_accepted_at) VALUES ('historical','historical','Historical','prior-version','2020-01-01');
      INSERT INTO publisher_memberships(membership_id,publisher_id,user_id) VALUES ('historical','historical','historical');`);
    const before={...sql.prepare('SELECT * FROM publishers').get()};
    sql.exec(readFileSync(new URL('0006_publisher_terms_acceptance_v1.sql',dir),'utf8'));
    assert.deepEqual({...sql.prepare('SELECT * FROM publishers').get()},{...before,terms_accepted_by_user_id:null});
    assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {sql.close();}
});
test('exactly 4096 UTF-8 bytes accepted, next byte rejected',async t=>{
  const f=await fixture(t);const json=JSON.stringify(valid);
  assert.equal((await f.request({body:json+' '.repeat(4097-json.length)})).status,413);
  assert.equal(f.publisher().terms_version,null);
  assert.equal((await f.request({body:json+' '.repeat(4096-json.length)})).status,200);
});
