import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildPublisherConfig } from '../config-builder-v0.1.mjs';
import { buildPublisherConfigFromD1 } from '../config-reader-d1-v0.1.mjs';
import worker from '../config-api-worker-v0.1.mjs';
import { fixture } from './config-reader-install-v0.1.test.mjs';
import { activeInput, origin } from './config-builder-install-v0.1.test.mjs';
// Compare the exact legacy builder to the checkpoint source, without writing files.
const previousSource=execFileSync('git',['show','HEAD:publisher-platform/config-builder-v0.1.mjs'],{encoding:'utf8'});
const previous=await import(`data:text/javascript;base64,${Buffer.from(previousSource).toString('base64')}`);
test('legacy builder remains identical across active, draft, terms and offers',()=>{
  for(const status of ['active','draft','suspended']) for(const offers of [[],activeInput().supplierSite.offers]) {
    const input=activeInput(); input.publisher.account_status=status; delete input.publisher.terms_version;
    input.supplierSite.offers=offers; assert.deepEqual(buildPublisherConfig(input),previous.buildPublisherConfig(input));
  }
});
test('legacy reader and API need neither install key nor terms',async t=>{
  const f=fixture(t); f.sql.exec('UPDATE publishers SET install_public_key=NULL, terms_version=NULL, terms_accepted_at=NULL, terms_accepted_by_user_id=NULL');
  const expected=previous.buildPublisherConfig(activeInput());
  assert.deepEqual(await buildPublisherConfigFromD1(f.database,'p1','example.test'),expected);
  const fetch=(query,host=origin)=>worker.fetch(new Request(`https://config.example.test/v1/config?${query}`,{headers:{Origin:host}}),{CHINAFLOW_EVENTS:f.database});
  for(const q of ['publisher_id=p1','publisher_id=p1&publisher_id=p2']) {
    const r=await fetch(q);assert.equal(r.status,200);assert.deepEqual(await r.json(),expected);
  }
  const invalid=await fetch('publisher_id=');assert.equal(invalid.status,400);assert.deepEqual(await invalid.json(),{error:'invalid_publisher_id'});
  assert.equal((await fetch('publisher_id=unknown')).status,403);
  // Preserve existing permissive legacy Origin handling in this checkpoint.
  assert.equal((await fetch('publisher_id=p1','https://example.test/path')).status,200);
  f.sql.exec("DELETE FROM publisher_supplier_offers; DELETE FROM publisher_supplier_sites; UPDATE publishers SET account_status='draft'");
  const draft=await (await fetch('publisher_id=p1')).json();assert.equal(draft.version,'0.1');assert.equal(draft.publisher,'p1');
  assert.equal(draft.analytics.enabled,true);assert.deepEqual(draft.offers,[]);assert.equal('runtime_enabled' in draft,false);
});
