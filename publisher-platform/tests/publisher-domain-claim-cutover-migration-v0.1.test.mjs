import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const dir = new URL("../../collector/migrations/", import.meta.url);
const cutover = readFileSync(
  new URL("0010_publisher_domain_claim_cutover_v1.sql", dir),
  "utf8"
);
const historical = readdirSync(dir)
  .filter(name => /^000[1-9]_.*\.sql$/.test(name))
  .sort();

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  t.after(() => db.close());

  assert.equal(historical.length, 9);
  for (const file of historical) {
    db.exec(readFileSync(new URL(file, dir), "utf8"));
  }
  return db;
}

function addPublishers(db, ids) {
  const insert = db.prepare(
    "INSERT INTO publishers(publisher_id,slug,display_name) VALUES (?,?,?)"
  );
  for (const id of ids) insert.run(id, id, id);
}

function indexSql(db, name) {
  return db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type='index' AND name=?
  `).get(name)?.sql ?? null;
}

test("0010 compensates transitional verified-unclaimed owners before retiring E15 guard", t => {
  const db = fixture(t);
  addPublishers(db, ["p1", "p2"]);

  db.exec(`
    INSERT INTO publisher_domains(domain_id,publisher_id,hostname,is_primary)
    VALUES
      ('d1','p1','transition.example',1),
      ('d2','p2','transition.example',1);

    UPDATE publisher_domains
    SET verification_status='verified',
        first_seen_at='2026-01-01',
        last_seen_at='2026-01-02',
        verified_at='2026-01-02'
    WHERE domain_id='d1';
  `);

  assert.deepEqual(
    { ...db.prepare(`
      SELECT verification_status,claim_status,claim_acquired_at
      FROM publisher_domains WHERE domain_id='d1'
    `).get() },
    {
      verification_status: "verified",
      claim_status: "unclaimed",
      claim_acquired_at: null
    }
  );
  assert.match(
    indexSql(db, "ux_publisher_domains_hostname"),
    /verification_status\s*=\s*'verified'/i
  );

  db.exec(cutover);

  assert.equal(indexSql(db, "ux_publisher_domains_hostname"), null);
  assert.match(
    indexSql(db, "ux_publisher_domains_claimed_hostname"),
    /claim_status\s*=\s*'claimed'/i
  );
  assert.deepEqual(
    { ...db.prepare(`
      SELECT verification_status,claim_status,claim_acquired_at,
             claim_ended_at,claim_end_reason
      FROM publisher_domains WHERE domain_id='d1'
    `).get() },
    {
      verification_status: "verified",
      claim_status: "claimed",
      claim_acquired_at: "2026-01-02",
      claim_ended_at: null,
      claim_end_reason: null
    }
  );

  assert.throws(() => db.exec(`
    UPDATE publisher_domains
    SET verification_status='verified',
        claim_status='claimed',
        claim_acquired_at='2026-01-03'
    WHERE domain_id='d2';
  `), /UNIQUE constraint failed: publisher_domains\.hostname/);

  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("0010 allows released and revoked verified history to coexist with a new legitimate claim", t => {
  const db = fixture(t);
  addPublishers(db, ["p1", "p2", "p3", "p4"]);

  db.exec(`
    INSERT INTO publisher_domains(domain_id,publisher_id,hostname,is_primary)
    VALUES
      ('d1','p1','released.example',1),
      ('d2','p2','released.example',1),
      ('d3','p3','revoked.example',1),
      ('d4','p4','revoked.example',1);

    UPDATE publisher_domains
    SET verification_status='verified',
        claim_status='claimed',
        claim_acquired_at='2026-01-01'
    WHERE domain_id IN ('d1','d3');

    UPDATE publisher_domains
    SET claim_status='released',
        claim_ended_at='2026-01-02',
        claim_end_reason='owner_release'
    WHERE domain_id='d1';

    UPDATE publisher_domains
    SET claim_status='revoked',
        claim_ended_at='2026-01-02',
        claim_end_reason='admin_revoke'
    WHERE domain_id='d3';
  `);

  assert.throws(() => db.exec(`
    UPDATE publisher_domains
    SET verification_status='verified',
        claim_status='claimed',
        claim_acquired_at='2026-01-03'
    WHERE domain_id='d2';
  `), /UNIQUE constraint failed: publisher_domains\.hostname/);

  db.exec(cutover);

  db.exec(`
    UPDATE publisher_domains
    SET verification_status='verified',
        claim_status='claimed',
        claim_acquired_at='2026-01-03'
    WHERE domain_id IN ('d2','d4');
  `);

  assert.deepEqual(
    db.prepare(`
      SELECT domain_id,hostname,verification_status,claim_status,
             claim_acquired_at,claim_ended_at,claim_end_reason
      FROM publisher_domains
      ORDER BY domain_id
    `).all().map(row => ({ ...row })),
    [
      {
        domain_id: "d1", hostname: "released.example",
        verification_status: "verified", claim_status: "released",
        claim_acquired_at: "2026-01-01", claim_ended_at: "2026-01-02",
        claim_end_reason: "owner_release"
      },
      {
        domain_id: "d2", hostname: "released.example",
        verification_status: "verified", claim_status: "claimed",
        claim_acquired_at: "2026-01-03", claim_ended_at: null,
        claim_end_reason: null
      },
      {
        domain_id: "d3", hostname: "revoked.example",
        verification_status: "verified", claim_status: "revoked",
        claim_acquired_at: "2026-01-01", claim_ended_at: "2026-01-02",
        claim_end_reason: "admin_revoke"
      },
      {
        domain_id: "d4", hostname: "revoked.example",
        verification_status: "verified", claim_status: "claimed",
        claim_acquired_at: "2026-01-03", claim_ended_at: null,
        claim_end_reason: null
      }
    ]
  );

  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("claimed-hostname UNIQUE remains the final concurrency arbiter after 0010", t => {
  const db = fixture(t);
  db.exec(cutover);
  addPublishers(db, ["p1", "p2", "p3"]);

  db.exec(`
    INSERT INTO publisher_domains(domain_id,publisher_id,hostname,is_primary)
    VALUES
      ('d1','p1','race.example',1),
      ('d2','p2','race.example',1),
      ('d3','p3','race.example',1);

    UPDATE publisher_domains
    SET verification_status='verified',
        claim_status='claimed',
        claim_acquired_at='2026-01-01'
    WHERE domain_id='d1';
  `);

  for (const domainId of ["d2", "d3"]) {
    assert.throws(() => db.exec(`
      UPDATE publisher_domains
      SET verification_status='verified',
          claim_status='claimed',
          claim_acquired_at='2026-01-02'
      WHERE domain_id='${domainId}';
    `), /UNIQUE constraint failed: publisher_domains\.hostname/);
  }

  assert.deepEqual(
    db.prepare(`
      SELECT domain_id,verification_status,claim_status
      FROM publisher_domains ORDER BY domain_id
    `).all().map(row => ({ ...row })),
    [
      { domain_id: "d1", verification_status: "verified", claim_status: "claimed" },
      { domain_id: "d2", verification_status: "unverified", claim_status: "unclaimed" },
      { domain_id: "d3", verification_status: "unverified", claim_status: "unclaimed" }
    ]
  );

  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
