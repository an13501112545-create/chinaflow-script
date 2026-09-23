import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSession } from "../auth-session-store-v0.1.mjs";
import { releasePublisherHostname } from "../publisher-domain-claim-mutations-v0.1.mjs";
import {
  authorizeInstallVerification,
  recordInstallVerificationResult
} from "../onboarding-install-verification-v0.1.mjs";
import { submitOnboarding } from "../onboarding-submit-v0.1.mjs";

async function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../../collector/migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter(name => /^(?:000[1-9]|0010)_.*\.sql$/.test(name))
    .sort();
  assert.equal(files.length, 10);
  for (const file of files) sqlite.exec(readFileSync(new URL(file, dir), "utf8"));

  sqlite.exec(`
    INSERT INTO publisher_users(user_id,email,email_normalized)
      VALUES ('u','owner@example.test','owner@example.test');
    INSERT INTO publishers(
      publisher_id,slug,display_name,account_status,
      terms_version,terms_accepted_at,terms_accepted_by_user_id,
      install_public_key
    ) VALUES (
      'p','p','Publisher','draft',
      'chinaflow-publisher-terms-v1',CURRENT_TIMESTAMP,'u',
      'cfi_0123456789abcdef0123456789abcdef'
    );
    INSERT INTO publisher_memberships(
      membership_id,publisher_id,user_id,role,membership_status
    ) VALUES ('m','p','u','owner','active');
    INSERT INTO publisher_domains(
      domain_id,publisher_id,hostname,is_primary,
      install_status,verification_status,claim_status,claim_acquired_at,
      review_status,monetization_status,
      first_seen_at,last_seen_at,verified_at
    ) VALUES (
      'd','p','example.test',1,
      'detected','verified','claimed','2026-01-01',
      'pending','disabled',
      '2026-01-01','2026-01-01','2026-01-01'
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
  const session = await createSession(database, "u");

  t.after(() => {
    try { assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []); }
    finally { sqlite.close(); }
  });

  return { sqlite, database, token: session.token };
}

test("draft owner release requires fresh proof before reacquire and submit", async t => {
  const f = await fixture(t);

  const released = await releasePublisherHostname(
    f.database,
    f.token,
    { hostname: "example.test" }
  );
  assert.equal(released.status, 200);
  assert.equal(released.body.claim.released, true);

  assert.equal((await submitOnboarding(f.database, f.token)).status, 409);

  const authorization = await authorizeInstallVerification(f.database, f.token);
  assert.equal(authorization.status, 200);
  assert.equal(authorization.context.hostname, "example.test");

  const verified = await recordInstallVerificationResult(
    f.database,
    authorization.context,
    { detected: true }
  );
  assert.deepEqual(verified, {
    status: 200,
    body: {
      verification: {
        detected: true,
        install_status: "detected",
        verification_status: "verified"
      }
    }
  });

  const claim = f.sqlite.prepare(`
    SELECT verification_status,claim_status,claim_acquired_at,
           claim_ended_at,claim_end_reason
    FROM publisher_domains WHERE domain_id='d'
  `).get();
  assert.equal(claim.verification_status, "verified");
  assert.equal(claim.claim_status, "claimed");
  assert.ok(claim.claim_acquired_at);
  assert.equal(claim.claim_ended_at, null);
  assert.equal(claim.claim_end_reason, null);

  const submitted = await submitOnboarding(f.database, f.token);
  assert.deepEqual(submitted, {
    status: 200,
    body: {
      submission: {
        account_status: "pending_review",
        submitted: true
      }
    }
  });
});
