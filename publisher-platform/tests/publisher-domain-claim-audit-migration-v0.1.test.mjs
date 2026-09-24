import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

function dbWithMigrations(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../../collector/migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter(name => /^(?:000[1-9]|0010|0011)_.*\.sql$/.test(name))
    .sort();
  assert.equal(files.length, 11);
  for (const file of files) db.exec(readFileSync(new URL(file, dir), "utf8"));
  t.after(() => db.close());
  return db;
}

function seedClaim(db, suffix, monetization = "enabled") {
  db.prepare(`
    INSERT INTO publishers(publisher_id,slug,display_name,account_status)
    VALUES (?,?,?,'active')
  `).run(`p_${suffix}`, `p-${suffix}`, `Publisher ${suffix}`);
  db.prepare(`
    INSERT INTO publisher_domains(
      domain_id,publisher_id,hostname,is_primary,
      install_status,verification_status,claim_status,claim_acquired_at,
      review_status,monetization_status,verified_at
    ) VALUES (?,?,?,1,'detected','verified','claimed','2026-01-01',
              'approved',?,'2026-01-01')
  `).run(`d_${suffix}`, `p_${suffix}`, `${suffix}.example.test`, monetization);
}

test("0011 records owner release and admin revoke as append-only audit events", t => {
  const db = dbWithMigrations(t);
  seedClaim(db, "release");
  seedClaim(db, "revoke");

  db.exec(`
    UPDATE publisher_domains
    SET claim_status='released',
        claim_ended_at='2026-01-02',
        claim_end_reason='owner_release',
        monetization_status='paused'
    WHERE domain_id='d_release';

    UPDATE publisher_domains
    SET claim_status='revoked',
        claim_ended_at='2026-01-03',
        claim_end_reason='admin_revoke',
        monetization_status='paused'
    WHERE domain_id='d_revoke';
  `);

  assert.deepEqual(
    db.prepare(`
      SELECT domain_id,publisher_id,hostname,actor_class,event_type,
             previous_claim_status,new_claim_status,verification_status,
             monetization_status_before,monetization_status_after,
             claim_acquired_at,claim_ended_at
      FROM publisher_domain_claim_audit
      ORDER BY audit_id
    `).all().map(row => ({ ...row })),
    [
      {
        domain_id: "d_release",
        publisher_id: "p_release",
        hostname: "release.example.test",
        actor_class: "publisher_owner_session",
        event_type: "owner_release",
        previous_claim_status: "claimed",
        new_claim_status: "released",
        verification_status: "verified",
        monetization_status_before: "enabled",
        monetization_status_after: "paused",
        claim_acquired_at: "2026-01-01",
        claim_ended_at: "2026-01-02"
      },
      {
        domain_id: "d_revoke",
        publisher_id: "p_revoke",
        hostname: "revoke.example.test",
        actor_class: "claim_admin_api",
        event_type: "admin_revoke",
        previous_claim_status: "claimed",
        new_claim_status: "revoked",
        verification_status: "verified",
        monetization_status_before: "enabled",
        monetization_status_after: "paused",
        claim_acquired_at: "2026-01-01",
        claim_ended_at: "2026-01-03"
      }
    ]
  );

  assert.throws(
    () => db.exec("UPDATE publisher_domain_claim_audit SET hostname='changed.test' WHERE audit_id=1"),
    /append-only/
  );
  assert.throws(
    () => db.exec("DELETE FROM publisher_domain_claim_audit WHERE audit_id=1"),
    /append-only/
  );
});

test("0011 emits exactly one destructive event and does not audit reclaim", t => {
  const db = dbWithMigrations(t);
  seedClaim(db, "lifecycle", "disabled");

  db.exec(`
    UPDATE publisher_domains
    SET claim_status='released',
        claim_ended_at='2026-01-02',
        claim_end_reason='owner_release'
    WHERE domain_id='d_lifecycle';

    UPDATE publisher_domains
    SET claim_status='released'
    WHERE domain_id='d_lifecycle';
  `);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM publisher_domain_claim_audit").get().n,
    1
  );

  db.exec(`
    UPDATE publisher_domains
    SET claim_status='claimed',
        claim_acquired_at='2026-01-04',
        claim_ended_at=NULL,
        claim_end_reason=NULL
    WHERE domain_id='d_lifecycle';
  `);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM publisher_domain_claim_audit").get().n,
    1
  );
});
