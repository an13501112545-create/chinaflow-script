import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const dir = new URL("../../collector/migrations/", import.meta.url);
const migration = "0009_publisher_domain_claim_lifecycle_v1.sql";
const historical = readdirSync(dir)
  .filter(name => /^000[1-8]_.*\.sql$/.test(name))
  .sort();

const read = name =>
  readFileSync(new URL(name, dir), "utf8");

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  assert.equal(historical.length, 8);
  for (const file of historical) db.exec(read(file));
  return db;
}

function addPublishers(db, ids) {
  const insert = db.prepare(
    "INSERT INTO publishers(publisher_id,slug,display_name) VALUES (?,?,?)"
  );
  for (const id of ids) insert.run(id, id, id);
}

test("0009 backfills verified claims and preserves the E15 uniqueness guard", t => {
  const db = fixture(t);
  addPublishers(db, ["p1","p2","p3","p4","p5"]);
  db.exec(`
    INSERT INTO publisher_domains(
      domain_id,publisher_id,hostname,verification_status,
      first_seen_at,last_seen_at,verified_at
    ) VALUES
      ('d1','p1','shared.example','verified',
       '2026-01-01','2026-01-02','2026-01-02'),
      ('d2','p2','shared.example','unverified',NULL,NULL,NULL),
      ('d3','p3','failed.example','failed',NULL,NULL,NULL),
      ('d4','p4','legacy.example','verified',NULL,NULL,NULL);
  `);

  db.exec(read(migration));

  const names = db.prepare("PRAGMA table_info(publisher_domains)")
    .all().map(row => row.name);
  for (const name of [
    "claim_status","claim_acquired_at","claim_ended_at","claim_end_reason"
  ]) assert.ok(names.includes(name));

  const rows = db.prepare(`
    SELECT domain_id,verification_status,claim_status,
           claim_acquired_at,claim_ended_at,claim_end_reason
    FROM publisher_domains ORDER BY domain_id
  `).all().map(row => ({ ...row }));

  assert.deepEqual(rows[0], {
    domain_id: "d1", verification_status: "verified",
    claim_status: "claimed", claim_acquired_at: "2026-01-02",
    claim_ended_at: null, claim_end_reason: null
  });
  assert.equal(rows[1].claim_status, "unclaimed");
  assert.equal(rows[1].claim_acquired_at, null);
  assert.equal(rows[2].claim_status, "unclaimed");
  assert.equal(rows[2].claim_acquired_at, null);
  assert.equal(rows[3].claim_status, "claimed");
  assert.notEqual(rows[3].claim_acquired_at, null);

  const oldIndex = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type='index' AND name='ux_publisher_domains_hostname'
  `).get();
  assert.match(oldIndex.sql, /verification_status\s*=\s*'verified'/i);

  const newIndex = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type='index' AND name='ux_publisher_domains_claimed_hostname'
  `).get();
  assert.match(newIndex.sql, /claim_status\s*=\s*'claimed'/i);

  db.exec(`
    INSERT INTO publisher_domains(domain_id,publisher_id,hostname,is_primary)
    VALUES ('d5','p5','rollout.example',1);
    UPDATE publisher_domains
    SET verification_status='verified'
    WHERE domain_id='d5';
  `);

  assert.deepEqual(
    {
      ...db.prepare(`
        SELECT verification_status,claim_status,claim_acquired_at
        FROM publisher_domains WHERE domain_id='d5'
      `).get()
    },
    {
      verification_status: "verified",
      claim_status: "unclaimed",
      claim_acquired_at: null
    }
  );

  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("0009 enforces claim lifecycle integrity without changing verification history", t => {
  const db = fixture(t);
  db.exec(read(migration));
  addPublishers(db, ["p1","p2","p3","p4"]);

  assert.throws(() => db.exec(`
    INSERT INTO publisher_domains(
      domain_id,publisher_id,hostname,verification_status,
      claim_status,claim_acquired_at
    ) VALUES (
      'd1','p1','unverified-claim.example','unverified',
      'claimed','2026-01-01'
    );
  `), /CHECK constraint failed/);

  assert.throws(() => db.exec(`
    INSERT INTO publisher_domains(
      domain_id,publisher_id,hostname,verification_status,claim_status
    ) VALUES ('d2','p2','missing-acquired.example','verified','claimed');
  `), /CHECK constraint failed/);

  assert.throws(() => db.exec(`
    INSERT INTO publisher_domains(
      domain_id,publisher_id,hostname,verification_status,
      claim_status,claim_acquired_at
    ) VALUES (
      'd3','p3','bad-release.example','verified',
      'released','2026-01-01'
    );
  `), /CHECK constraint failed/);

  assert.throws(() => db.exec(`
    INSERT INTO publisher_domains(
      domain_id,publisher_id,hostname,verification_status,
      claim_status,claim_acquired_at,claim_ended_at,claim_end_reason
    ) VALUES (
      'd3b','p3','bad-reason.example','verified',
      'released','2026-01-01','2026-01-02','admin_revoke'
    );
  `), /CHECK constraint failed/);

  db.exec(`
    INSERT INTO publisher_domains(
      domain_id,publisher_id,hostname,verification_status,
      claim_status,claim_acquired_at,claim_ended_at,claim_end_reason
    ) VALUES
      ('d3','p3','released.example','verified',
       'released','2026-01-01','2026-01-02','owner_release'),
      ('d4','p4','revoked.example','verified',
       'revoked','2026-01-01','2026-01-02','admin_revoke');
  `);

  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("claimed-hostname index independently arbitrates after the legacy E15 index is removed", t => {
  const db = fixture(t);
  db.exec(read(migration));
  addPublishers(db, ["p1","p2","p3"]);
  db.exec(`
    INSERT INTO publisher_domains(domain_id,publisher_id,hostname,is_primary)
    VALUES
      ('d1','p1','handoff.example',1),
      ('d2','p2','handoff.example',1),
      ('d3','p3','handoff.example',1);
    DROP INDEX ux_publisher_domains_hostname;
    UPDATE publisher_domains
    SET verification_status='verified',
        claim_status='claimed',
        claim_acquired_at='2026-01-01'
    WHERE domain_id='d1';
  `);

  assert.throws(() => db.exec(`
    UPDATE publisher_domains
    SET verification_status='verified',
        claim_status='claimed',
        claim_acquired_at='2026-01-02'
    WHERE domain_id='d2';
  `), /UNIQUE constraint failed: publisher_domains\.hostname/);

  db.exec(`
    UPDATE publisher_domains
    SET claim_status='released',
        claim_ended_at='2026-01-03',
        claim_end_reason='owner_release'
    WHERE domain_id='d1';

    UPDATE publisher_domains
    SET verification_status='verified',
        claim_status='claimed',
        claim_acquired_at='2026-01-03'
    WHERE domain_id='d2';
  `);

  assert.deepEqual(
    db.prepare(`
      SELECT domain_id,verification_status,claim_status,
             claim_acquired_at,claim_ended_at,claim_end_reason
      FROM publisher_domains
      WHERE domain_id IN ('d1','d2')
      ORDER BY domain_id
    `).all().map(row => ({ ...row })),
    [
      {
        domain_id: "d1", verification_status: "verified",
        claim_status: "released", claim_acquired_at: "2026-01-01",
        claim_ended_at: "2026-01-03", claim_end_reason: "owner_release"
      },
      {
        domain_id: "d2", verification_status: "verified",
        claim_status: "claimed", claim_acquired_at: "2026-01-03",
        claim_ended_at: null, claim_end_reason: null
      }
    ]
  );

  assert.throws(() => db.exec(`
    UPDATE publisher_domains
    SET verification_status='verified',
        claim_status='claimed',
        claim_acquired_at='2026-01-04'
    WHERE domain_id='d3';
  `), /UNIQUE constraint failed: publisher_domains\.hostname/);

  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
