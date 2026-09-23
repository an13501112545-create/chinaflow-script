import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { hashToken } from "../auth-token-v0.1.mjs";
import {
  claimLifecycleMutationsEnabled,
  validateOwnerReleaseInput,
  validateAdminRevokeInput,
  releasePublisherHostname,
  revokePublisherHostname
} from "../publisher-domain-claim-mutations-v0.1.mjs";

const TOKEN = "a".repeat(64);
const HOSTNAME = "example.test";

async function fixture(t, {
  accountStatus = "active",
  monetizationStatus = "enabled"
} = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../../collector/migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter(name => /^(?:000[1-9]|0010)_.*\.sql$/.test(name))
    .sort();
  assert.equal(files.length, 10);
  for (const file of files) {
    sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
  }

  const tokenHash = await hashToken(TOKEN);
  sqlite.prepare(`
    INSERT INTO publisher_users(
      user_id,email,email_normalized,user_status,email_verified_at
    ) VALUES ('u','owner@example.test','owner@example.test','active',CURRENT_TIMESTAMP)
  `).run();
  sqlite.prepare(`
    INSERT INTO publishers(
      publisher_id,slug,display_name,account_status,
      terms_version,terms_accepted_at,terms_accepted_by_user_id,
      install_public_key
    ) VALUES (
      'p','p','Publisher',?,
      'chinaflow-publisher-terms-v1',CURRENT_TIMESTAMP,'u',
      'cfi_0123456789abcdef0123456789abcdef'
    )
  `).run(accountStatus);
  sqlite.exec(`
    INSERT INTO publisher_memberships(
      membership_id,publisher_id,user_id,role,membership_status
    ) VALUES ('m','p','u','owner','active');
  `);
  sqlite.prepare(`
    INSERT INTO publisher_sessions(
      session_id,user_id,token_hash,expires_at,created_at
    ) VALUES ('s','u',?,'2099-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')
  `).run(tokenHash);
  sqlite.prepare(`
    INSERT INTO publisher_domains(
      domain_id,publisher_id,hostname,is_primary,
      install_status,verification_status,
      claim_status,claim_acquired_at,
      review_status,monetization_status,
      first_seen_at,last_seen_at,verified_at,reviewed_at
    ) VALUES (
      'd','p',?,1,
      'detected','verified',
      'claimed','2026-01-01T00:00:00.000Z',
      'approved',?,
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'
    )
  `).run(HOSTNAME, monetizationStatus);
  sqlite.exec(`
    INSERT INTO publisher_supplier_sites(
      supplier_site_id,publisher_id,domain_id,supplier,
      aid,sid,sid_name,provisioning_status,provisioned_at
    ) VALUES (
      'site','p','d','trip.com','10021103','330739613','claim-test',
      'active','2026-01-01T00:00:00.000Z'
    );
    INSERT INTO publisher_placements(
      placement_id,publisher_id,placement,supplier,
      external_tracking_key,is_active,effective_from
    ) VALUES (
      'placement','p','claim_test','trip.com','claim_test',1,
      '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO publisher_supplier_offers(
      supplier_offer_id,supplier_site_id,publisher_id,domain_id,
      offer_key,product,placement_id,affiliate_url,is_active
    ) VALUES (
      'offer','site','p','d','hotel','hotel','placement',
      'https://www.trip.com/hotels?Allianceid=10021103&SID=330739613&trip_sub1=claim_test',1
    );
  `);

  const database = {
    prepare(sql) {
      return {
        bind(...values) {
          const prepared = () => sqlite.prepare(sql);
          return {
            async first() { return prepared().get(...values) ?? null; },
            async all() { return { results: prepared().all(...values) }; },
            async run() {
              const result = prepared().run(...values);
              return { meta: { changes: Number(result.changes) } };
            }
          };
        }
      };
    }
  };

  t.after(() => {
    try { assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []); }
    finally { sqlite.close(); }
  });

  return { sqlite, database };
}

function claim(db) {
  return { ...db.prepare(`
    SELECT p.account_status,d.verification_status,d.verified_at,
      d.claim_status,d.claim_acquired_at,d.claim_ended_at,d.claim_end_reason,
      d.monetization_status
    FROM publishers p
    JOIN publisher_domains d ON d.publisher_id=p.publisher_id
    WHERE p.publisher_id='p' AND d.domain_id='d'
  `).get() };
}

function commercialGraph(db) {
  return {
    sites: db.prepare("SELECT * FROM publisher_supplier_sites ORDER BY supplier_site_id").all(),
    placements: db.prepare("SELECT * FROM publisher_placements ORDER BY placement_id").all(),
    offers: db.prepare("SELECT * FROM publisher_supplier_offers ORDER BY supplier_offer_id").all()
  };
}

test("claim mutation feature gate enables only exact string true", () => {
  assert.equal(claimLifecycleMutationsEnabled({ CLAIM_LIFECYCLE_MUTATIONS_ENABLED: "true" }), true);
  for (const value of [undefined, null, "", "false", "TRUE", true, 1]) {
    assert.equal(claimLifecycleMutationsEnabled({ CLAIM_LIFECYCLE_MUTATIONS_ENABLED: value }), false);
  }
});

test("claim mutation inputs are strict and hostname-normalized", () => {
  assert.deepEqual(validateOwnerReleaseInput({ hostname: "Example.Test" }), { hostname: HOSTNAME });
  for (const input of [null, {}, { hostname: "" }, { hostname: HOSTNAME, publisher_id: "p" }, { hostname: "https://example.test" }]) {
    assert.equal(validateOwnerReleaseInput(input), null);
  }

  assert.deepEqual(
    validateAdminRevokeInput({ publisher_id: "p", hostname: "Example.Test" }),
    { publisherId: "p", hostname: HOSTNAME }
  );
  for (const input of [
    null, {}, { publisher_id: "p" }, { hostname: HOSTNAME },
    { publisher_id: "", hostname: HOSTNAME },
    { publisher_id: "p", hostname: HOSTNAME, reason: "forged" }
  ]) assert.equal(validateAdminRevokeInput(input), null);
});

test("owner release preserves verification/commercial history and pauses active monetization", async t => {
  const f = await fixture(t);
  const graphBefore = commercialGraph(f.sqlite);
  const before = claim(f.sqlite);

  const result = await releasePublisherHostname(
    f.database,
    TOKEN,
    { hostname: HOSTNAME }
  );

  assert.deepEqual(result, {
    status: 200,
    body: {
      claim: {
        hostname: HOSTNAME,
        claim_status: "released",
        monetization_status: "paused",
        released: true
      }
    }
  });

  const after = claim(f.sqlite);
  assert.equal(after.account_status, "active");
  assert.equal(after.verification_status, "verified");
  assert.equal(after.verified_at, before.verified_at);
  assert.equal(after.claim_status, "released");
  assert.equal(after.claim_acquired_at, before.claim_acquired_at);
  assert.ok(after.claim_ended_at);
  assert.equal(after.claim_end_reason, "owner_release");
  assert.equal(after.monetization_status, "paused");
  assert.deepEqual(commercialGraph(f.sqlite), graphBefore);

  const retry = await releasePublisherHostname(f.database, TOKEN, { hostname: HOSTNAME });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.claim.released, false);
  assert.deepEqual(commercialGraph(f.sqlite), graphBefore);
});

for (const accountStatus of ["draft", "pending_review", "rejected", "active"]) {
  test(`owner release is available from supported account state ${accountStatus}`, async t => {
    const f = await fixture(t, { accountStatus, monetizationStatus: "disabled" });
    const result = await releasePublisherHostname(f.database, TOKEN, { hostname: HOSTNAME });
    assert.equal(result.status, 200);
    assert.equal(result.body.claim.released, true);
    assert.equal(claim(f.sqlite).account_status, accountStatus);
    assert.equal(claim(f.sqlite).monetization_status, "disabled");
  });
}

for (const accountStatus of ["suspended", "closed"]) {
  test(`owner release fails closed from unsupported account state ${accountStatus}`, async t => {
    const f = await fixture(t, { accountStatus });
    const before = claim(f.sqlite);
    assert.equal(
      (await releasePublisherHostname(f.database, TOKEN, { hostname: HOSTNAME })).status,
      409
    );
    assert.deepEqual(claim(f.sqlite), before);
  });
}

test("owner release requires current owner/session and never overrides admin revoke", async t => {
  const noOwner = await fixture(t);
  noOwner.sqlite.exec("UPDATE publisher_memberships SET role='member'");
  assert.equal((await releasePublisherHostname(noOwner.database, TOKEN, { hostname: HOSTNAME })).status, 404);

  const noSession = await fixture(t);
  noSession.sqlite.exec("UPDATE publisher_sessions SET revoked_at=CURRENT_TIMESTAMP");
  assert.equal((await releasePublisherHostname(noSession.database, TOKEN, { hostname: HOSTNAME })).status, 401);

  const revoked = await fixture(t);
  revoked.sqlite.exec(`
    UPDATE publisher_domains
    SET claim_status='revoked',claim_ended_at='2026-01-02T00:00:00.000Z',
        claim_end_reason='admin_revoke',monetization_status='paused'
    WHERE domain_id='d'
  `);
  const before = claim(revoked.sqlite);
  assert.equal((await releasePublisherHostname(revoked.database, TOKEN, { hostname: HOSTNAME })).status, 409);
  assert.deepEqual(claim(revoked.sqlite), before);
});

test("concurrent owner release calls converge without double mutation", async t => {
  const f = await fixture(t);
  const results = await Promise.all([
    releasePublisherHostname(f.database, TOKEN, { hostname: HOSTNAME }),
    releasePublisherHostname(f.database, TOKEN, { hostname: HOSTNAME })
  ]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.deepEqual(results.map(r => r.body.claim.released).sort(), [false, true]);
  assert.equal(claim(f.sqlite).claim_status, "released");
});

test("admin revoke preserves verification/commercial history and pauses active monetization", async t => {
  const f = await fixture(t);
  const graphBefore = commercialGraph(f.sqlite);
  const before = claim(f.sqlite);

  const result = await revokePublisherHostname(f.database, {
    publisher_id: "p",
    hostname: HOSTNAME
  });

  assert.deepEqual(result, {
    status: 200,
    body: {
      claim: {
        publisher_id: "p",
        hostname: HOSTNAME,
        claim_status: "revoked",
        monetization_status: "paused",
        revoked: true
      }
    }
  });

  const after = claim(f.sqlite);
  assert.equal(after.account_status, "active");
  assert.equal(after.verification_status, "verified");
  assert.equal(after.verified_at, before.verified_at);
  assert.equal(after.claim_status, "revoked");
  assert.equal(after.claim_acquired_at, before.claim_acquired_at);
  assert.ok(after.claim_ended_at);
  assert.equal(after.claim_end_reason, "admin_revoke");
  assert.equal(after.monetization_status, "paused");
  assert.deepEqual(commercialGraph(f.sqlite), graphBefore);

  const retry = await revokePublisherHostname(f.database, {
    publisher_id: "p",
    hostname: HOSTNAME
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.claim.revoked, false);
});

test("admin revoke cannot overwrite owner release and exact publisher/hostname are required", async t => {
  const f = await fixture(t);
  assert.equal((await releasePublisherHostname(f.database, TOKEN, { hostname: HOSTNAME })).status, 200);
  const released = claim(f.sqlite);
  assert.equal((await revokePublisherHostname(f.database, { publisher_id: "p", hostname: HOSTNAME })).status, 409);
  assert.deepEqual(claim(f.sqlite), released);

  assert.equal((await revokePublisherHostname(f.database, { publisher_id: "missing", hostname: HOSTNAME })).status, 404);
  assert.equal((await revokePublisherHostname(f.database, { publisher_id: "p", hostname: "other.test" })).status, 404);
});

test("concurrent admin revoke calls converge without double mutation", async t => {
  const f = await fixture(t);
  const input = { publisher_id: "p", hostname: HOSTNAME };
  const results = await Promise.all([
    revokePublisherHostname(f.database, input),
    revokePublisherHostname(f.database, input)
  ]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.deepEqual(results.map(r => r.body.claim.revoked).sort(), [false, true]);
  assert.equal(claim(f.sqlite).claim_status, "revoked");
});
