import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import worker from '../config-api-worker-v0.1.mjs';
import { buildInstallConfigFromD1 } from '../config-reader-d1-v0.1.mjs';
import { inert, origin } from './config-builder-install-v0.1.test.mjs';
export const key = `cfi_${'a'.repeat(32)}`;
export const migrations = readdirSync(new URL('../../collector/migrations/', import.meta.url))
  .filter(n => /^000[1-8]_.*\.sql$/.test(n)).sort().map(n => readFileSync(new URL(`../../collector/migrations/${n}`, import.meta.url), 'utf8'));
export const seed = `
INSERT INTO publisher_users(user_id,email,email_normalized) VALUES ('u1','fixture@example.test','fixture@example.test');
INSERT INTO publishers(publisher_id,slug,display_name,account_status,terms_version,terms_accepted_at,terms_accepted_by_user_id,install_public_key)
VALUES ('p1','fixture-one','Fixture','active','chinaflow-publisher-terms-v1','2026-01-01','u1','${key}');
INSERT INTO publishers(publisher_id,slug,display_name) VALUES ('p2','fixture-two','Other');
INSERT INTO publisher_domains(domain_id,publisher_id,hostname,verification_status,review_status,monetization_status)
VALUES ('d1','p1','example.test','verified','approved','enabled'),('d2','p2','other.test','verified','approved','enabled');
INSERT INTO publisher_supplier_sites(supplier_site_id,publisher_id,domain_id,supplier,provisioning_status)
VALUES ('s1','p1','d1','trip.com','active');
INSERT INTO publisher_placements(placement_id,publisher_id,placement,supplier,external_tracking_key)
VALUES ('pp1','p1','internal_label','trip.com','fixture_tracking'),('pp2','p2','other_label','trip.com','other_tracking');
INSERT INTO publisher_supplier_offers(supplier_offer_id,supplier_site_id,publisher_id,domain_id,offer_key,product,placement_id,affiliate_url)
VALUES ('o1','s1','p1','d1','hotel','hotel','pp1','https://www.trip.com/hotels?trip_sub1=fixture_tracking');`;
export function fixture(t) {
  const sql = new DatabaseSync(':memory:'); sql.exec('PRAGMA foreign_keys=ON');
  assert.equal(migrations.length, 8); for (const migration of migrations) sql.exec(migration); sql.exec(seed);
  t.after(() => { assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(), []); sql.close(); });
  const database = { prepare(query) { return { bind(...args) { return { async all() {
    // Numbered D1 placeholders are named parameters in node:sqlite.
    return { results: sql.prepare(query).all(Object.fromEntries(args.map((v,i) => [String(i+1),v]))) };
  } }; } }; } };
  return { sql, database, config: () => buildInstallConfigFromD1(database,key,'example.test',origin) };
}
test('read-only lookup, exact non-primary domain and unknown isolation', async t => {
  const f = fixture(t); const before = f.sql.prepare('SELECT total_changes() n').get().n;
  assert.equal((await f.config()).runtime_enabled,true);
  for (const host of ['other.test','www.example.test','sub.example.test']) assert.equal(await buildInstallConfigFromD1(f.database,key,host,origin),null);
  assert.equal(await buildInstallConfigFromD1(f.database,`cfi_${'b'.repeat(32)}`,'example.test',origin),null);
  assert.equal(f.sql.prepare('SELECT total_changes() n').get().n,before);
});
for (const mutation of [
  "UPDATE publishers SET account_status='draft'",
  "UPDATE publishers SET account_status='draft'; UPDATE publisher_domains SET install_status='detected'", "UPDATE publishers SET terms_version=NULL",
  "UPDATE publishers SET terms_version='unsupported'", "UPDATE publishers SET terms_accepted_at=NULL",
  "UPDATE publishers SET terms_accepted_by_user_id=NULL", "UPDATE publisher_domains SET verification_status='unverified'",
  "UPDATE publisher_domains SET review_status='pending'", "UPDATE publisher_domains SET monetization_status='disabled'",
  "UPDATE publisher_domains SET monetization_status='paused'", "UPDATE publisher_supplier_sites SET provisioning_status='pending'",
  "UPDATE publisher_supplier_sites SET provisioning_status='disabled'", "DELETE FROM publisher_supplier_offers; DELETE FROM publisher_supplier_sites",
  "DELETE FROM publisher_supplier_offers", "UPDATE publisher_supplier_offers SET is_active=0",
  "UPDATE publisher_placements SET is_active=0", "UPDATE publisher_placements SET supplier='other'",
  "UPDATE publisher_supplier_offers SET affiliate_url='http://trip.com/'"
]) test('SQLite recognized ineligible tenant stays inert', async t => {
  const f = fixture(t); f.sql.exec(mutation); assert.deepEqual(await f.config(),inert);
  const response = await worker.fetch(new Request(`https://config.example.test/v1/config?install_key=${key}`,
    {headers:{Origin:origin}}),{CHINAFLOW_EVENTS:f.database});
  assert.equal(response.status,200); assert.deepEqual(await response.json(),inert);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),origin);
  assert.equal(response.headers.get('Cache-Control'),'no-store'); assert.equal(response.headers.get('Vary'),'Origin');
});
for (const mutation of ["DELETE FROM publisher_placements WHERE placement_id='pp1'",
  "UPDATE publisher_supplier_offers SET placement_id='pp2'", "UPDATE publisher_supplier_offers SET publisher_id='p2'",
  "UPDATE publisher_supplier_offers SET domain_id='d2'"]) test('defensive joins exclude corrupt ownership', async t => {
  const f = fixture(t);
  // Deliberately corrupt only inside a rolled-back local transaction to exercise defensive joins.
  f.sql.exec('PRAGMA foreign_keys=OFF; BEGIN');
  try { f.sql.exec(mutation); assert.deepEqual(await f.config(),inert); }
  finally { f.sql.exec('ROLLBACK; PRAGMA foreign_keys=ON'); }
});

test('valid offer survives unrelated invalid and mismatched offers', async t => {
  const f=fixture(t);
  f.sql.exec(`INSERT INTO publisher_supplier_offers(supplier_offer_id,supplier_site_id,publisher_id,domain_id,offer_key,product,placement_id,affiliate_url)
    VALUES ('o2','s1','p1','d1','invalid','flight','pp1','https://evil.test/');`);
  f.sql.exec('PRAGMA foreign_keys=OFF; BEGIN');
  try {
    f.sql.exec(`INSERT INTO publisher_supplier_offers(supplier_offer_id,supplier_site_id,publisher_id,domain_id,offer_key,product,placement_id,affiliate_url)
      VALUES ('o3','s1','p1','d1','mismatch','flight','pp2','https://trip.com/?trip_sub1=other_tracking');`);
    const config=await f.config(); assert.equal(config.runtime_enabled,true); assert.equal(config.offers.length,1);
    assert.equal(config.offers[0].placement,'fixture_tracking');
  } finally {f.sql.exec('ROLLBACK; PRAGMA foreign_keys=ON');}
});
