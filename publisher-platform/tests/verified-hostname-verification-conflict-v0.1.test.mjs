import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  recordInstallVerificationResult
} from "../onboarding-install-verification-v0.1.mjs";

test("second verified claim returns controlled 409 and preserves loser as unverified", async () => {
  const sqlite = new DatabaseSync(":memory:");

  try {
    sqlite.exec("PRAGMA foreign_keys = ON");

    const migrations =
      new URL("../../collector/migrations/", import.meta.url);

    const files = readdirSync(migrations)
      .filter(name => /^\d{4}_.*\.sql$/.test(name))
      .sort();

    assert.ok(
      files.includes("0008_verified_hostname_claim_v1.sql")
    );

    for (const file of files) {
      sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
    }
    sqlite.exec(`
      INSERT INTO publisher_users (
        user_id,email,email_normalized
      ) VALUES
        ('u1','one@example.test','one@example.test'),
        ('u2','two@example.test','two@example.test');

      INSERT INTO publishers (
        publisher_id,slug,display_name,terms_version,
        terms_accepted_at,terms_accepted_by_user_id,install_public_key
      ) VALUES
        ('p1','p1','Publisher One','chinaflow-publisher-terms-v1',
         CURRENT_TIMESTAMP,'u1','cfi_11111111111111111111111111111111'),
        ('p2','p2','Publisher Two','chinaflow-publisher-terms-v1',
         CURRENT_TIMESTAMP,'u2','cfi_22222222222222222222222222222222');

      INSERT INTO publisher_memberships (
        membership_id,publisher_id,user_id
      ) VALUES
        ('m1','p1','u1'),
        ('m2','p2','u2');

      INSERT INTO publisher_sessions (
        session_id,user_id,token_hash,expires_at
      ) VALUES
        ('s1','u1','hash-one','2999-01-01T00:00:00Z'),
        ('s2','u2','hash-two','2999-01-01T00:00:00Z');
      INSERT INTO publisher_domains (
        domain_id,publisher_id,hostname,is_primary
      ) VALUES
        ('d1','p1','shared.example.com',1),
        ('d2','p2','shared.example.com',1);
    `);

    const database = {
      prepare(sql) {
        return {
          bind(...values) {
            const statement = sqlite.prepare(sql);

            return {
              async first() {
                return statement.get(...values) ?? null;
              }
            };
          }
        };
      }
    };

    const context1 = {
      userId: "u1",
      sessionId: "s1",
      publisherId: "p1",
      domainId: "d1",
      hostname: "shared.example.com",
      installPublicKey: "cfi_11111111111111111111111111111111"
    };
    const context2 = {
      userId: "u2",
      sessionId: "s2",
      publisherId: "p2",
      domainId: "d2",
      hostname: "shared.example.com",
      installPublicKey: "cfi_22222222222222222222222222222222"
    };

    const first = await recordInstallVerificationResult(
      database,
      context1,
      { detected: true }
    );

    assert.equal(first.status, 200);

    const second = await recordInstallVerificationResult(
      database,
      context2,
      { detected: true }
    );

    assert.deepEqual(second, {
      status: 409,
      body: { error: "conflict" }
    });

    const rows = sqlite.prepare(`
      SELECT
        domain_id,
        verification_status,
        first_seen_at,
        last_seen_at,
        verified_at
      FROM publisher_domains
      ORDER BY domain_id
    `).all().map(row => ({ ...row }));
    assert.equal(rows[0].domain_id, "d1");
    assert.equal(rows[0].verification_status, "verified");
    assert.notEqual(rows[0].verified_at, null);

    assert.deepEqual(rows[1], {
      domain_id: "d2",
      verification_status: "unverified",
      first_seen_at: null,
      last_seen_at: null,
      verified_at: null
    });

    assert.deepEqual(
      sqlite.prepare("PRAGMA foreign_key_check").all(),
      []
    );
  } finally {
    sqlite.close();
  }
});
