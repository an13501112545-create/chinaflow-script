import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildInstallConfig } from '../config-builder-v0.1.mjs';

export const inert = { version: '0.2', runtime_enabled: false,
  analytics: { enabled: false, event_schema_version: '0.1', collector_url: null }, rules: [], offers: [] };
export const origin = 'https://example.test';
export function activeInput() {
  return { publisher: { publisher_id: 'p1', account_status: 'active', terms_version: 'chinaflow-publisher-terms-v1',
    terms_accepted_at: '2026-01-01', has_terms_actor: true },
  domain: { domain_id: 'd1', hostname: 'example.test', verification_status: 'verified', claim_status: 'claimed', review_status: 'approved', monetization_status: 'enabled' },
  supplierSite: { publisher_id: 'p1', domain_id: 'd1', supplier: 'trip.com', provisioning_status: 'active',
    offers: [{ product: 'hotel', placement: 'fixture_tracking', url: 'https://www.trip.com/hotels?trip_sub1=fixture_tracking' }] } };
}
test('active install contract preserves attribution and destination without analytics identity', () => {
  const input = activeInput(); const config = buildInstallConfig(input, origin);
  assert.deepEqual(Object.keys(config).sort(), ['version','runtime_enabled','analytics','rules','offers','bound_origin'].sort());
  assert.equal(config.runtime_enabled, true); assert.equal(config.version, '0.2'); assert.equal(config.bound_origin, origin);
  assert.deepEqual(config.analytics, inert.analytics);
  assert.equal(config.offers[0].placement, input.supplierSite.offers[0].placement);
  assert.equal(config.offers[0].url, input.supplierSite.offers[0].url);
});
for (const [group, field, values] of [
  ['publisher','account_status',['draft','suspended']], ['publisher','terms_version',[null,undefined,'unsupported']],
  ['publisher','terms_accepted_at',[null,undefined]], ['publisher','has_terms_actor',[false,undefined]],
  ['domain','verification_status',['unverified']], ['domain','claim_status',['unclaimed','released','revoked']], ['domain','review_status',['pending']],
  ['domain','monetization_status',['disabled','paused']], ['supplierSite','provisioning_status',['pending','disabled']],
  ['supplierSite','publisher_id',['p2']], ['supplierSite','domain_id',['d2']], ['supplierSite','offers',[[]]]
]) for (const value of values) test(`inert gate ${group}.${field} ${String(value)}`, () => {
  const input = activeInput(); input[group][field] = value;
  assert.deepEqual(buildInstallConfig(input, origin), inert);
});
for (const url of ['http://trip.com/?trip_sub1=fixture_tracking', 'https://evil.test/?trip_sub1=fixture_tracking',
  'https://user:secret@trip.com/?trip_sub1=fixture_tracking', 'https://trip.com:8443/?trip_sub1=fixture_tracking',
  'https://trip.com/?trip_sub1=wrong', 'https://trip.com/?trip_sub1=fixture_tracking&trip_sub1=fixture_tracking',
  'https://trip.com/\\bad?trip_sub1=fixture_tracking', 'not a url']) test('invalid destination excluded', () => {
  const input = activeInput(); const good = input.supplierSite.offers[0];
  input.supplierSite.offers = [{ ...good, url }]; assert.deepEqual(buildInstallConfig(input, origin), inert);
  input.supplierSite.offers.push(good); assert.equal(buildInstallConfig(input, origin).offers.length, 1);
});
