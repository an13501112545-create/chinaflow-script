import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { reviewPublisher } from "../publisher-review-v0.1.mjs";

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../../collector/migrations/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter(name => /^000[1-8]_.*\.sql$/.test(name)).sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }

  sqlite.exec(`
    INSERT INTO publisher_users (user_id,email,email_normalized)
      VALUES ('u','owner@example.test','owner@example.test');
    INSERT INTO publishers (
      publisher_id,slug,display_name,account_status,
      terms_version,terms_accepted_at,terms_accepted_by_user_id,
      install_public_key
    ) VALUES (
      'p','p','Publisher','pending_review',
      'chinaflow-publisher-terms-v1',CURRENT_TIMESTAMP,'u',
      'cfi_0123456789abcdef0123456789abcdef'
    );
    INSERT INTO publisher_domains (
      domain_id,publisher_id,hostname,is_primary,
      install_status,verification_status,review_status,
      monetization_status,first_seen_at,last_seen_at,verified_at
    ) VALUES (
      'd','p','example.test',1,
      'detected','verified','pending',
      'disabled',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    ),(
      'd-secondary','p','secondary.example.test',0,
      'pending','unverified','pending','disabled',NULL,NULL,NULL
    );
    INSERT INTO publisher_placements (
      placement_id,publisher_id,placement,supplier,external_tracking_key
    ) VALUES ('place','p','existing','trip','existing_key');
    INSERT INTO publisher_supplier_sites (
      supplier_site_id,publisher_id,domain_id,supplier,provisioning_status
    ) VALUES ('site','p','d','trip.com','pending');
    INSERT INTO publisher_supplier_offers (
      supplier_offer_id,supplier_site_id,publisher_id,domain_id,
      offer_key,product,placement_id,affiliate_url,is_active
    ) VALUES (
      'offer','site','p','d','hotel','hotel','place',
      'https://example.test/existing',0
    );
  `);

  const state = { failBatchAt: null };
  let batchQueue = Promise.resolve();
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
    },
    async batch(statements) {
      const execute = async () => {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const results = [];
          for (let index = 0; index < statements.length; index += 1) {
            if (state.failBatchAt === index) throw new Error("injected batch failure");
            results.push(await statements[index].run());
          }
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      };
      const result = batchQueue.then(execute, execute);
      batchQueue = result.catch(() => {});
      return result;
    }
  };

  t.after(() => {
    try { assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []); }
    finally { sqlite.close(); }
  });

  return { sqlite, database, state };
}

const input = decision => ({ publisher_id: "p", decision });

function row(db, sql) {
  return db.prepare(sql).get();
}

function protectedSnapshot(db) {
  return {
    placement: db.prepare("SELECT * FROM publisher_placements").all(),
    site: db.prepare("SELECT * FROM publisher_supplier_sites").all(),
    offer: db.prepare("SELECT * FROM publisher_supplier_offers").all(),
    secondary: db.prepare(
      "SELECT * FROM publisher_domains WHERE domain_id='d-secondary'"
    ).get()
  };
}

test("review input is strict and invalid requests do not write", async t => {
  const f = fixture(t);
  const before = row(f.sqlite, "SELECT * FROM publishers WHERE publisher_id='p'");
  for (const bad of [
    null, {}, { publisher_id: "", decision: "approve" },
    { publisher_id: "p", decision: "approved" },
    { publisher_id: "p", decision: "reject", extra: true }
  ]) {
    const result = await reviewPublisher(f.database, bad);
    assert.equal(result.status, 400);
  }
  assert.deepEqual(
    row(f.sqlite, "SELECT * FROM publishers WHERE publisher_id='p'"),
    before
  );
});

test("approve reviews the primary domain but does not activate or monetize", async t => {
  const f = fixture(t);
  const protectedBefore = protectedSnapshot(f.sqlite);
  const result = await reviewPublisher(f.database, input("approve"));
  assert.deepEqual(result, {
    status: 200,
    body: {
      review: {
        publisher_id: "p",
        decision: "approve",
        account_status: "pending_review",
        review_status: "approved",
        reviewed: true
      }
    }
  });
  const publisher = row(f.sqlite,
    "SELECT account_status FROM publishers WHERE publisher_id='p'");
  const domain = row(f.sqlite,
    "SELECT review_status,reviewed_at,monetization_status FROM publisher_domains WHERE domain_id='d'");
  assert.equal(publisher.account_status, "pending_review");
  assert.equal(domain.review_status, "approved");
  assert.ok(domain.reviewed_at);
  assert.equal(domain.monetization_status, "disabled");
  assert.deepEqual(protectedSnapshot(f.sqlite), protectedBefore);
});

test("approve retry is idempotent and preserves timestamps", async t => {
  const f = fixture(t);
  assert.equal((await reviewPublisher(f.database, input("approve"))).status, 200);
  f.sqlite.exec(`
    UPDATE publisher_domains
    SET reviewed_at='2001-01-01 00:00:00',
        updated_at='2001-01-01 00:00:00'
    WHERE domain_id='d'
  `);
  const before = row(f.sqlite, "SELECT * FROM publisher_domains WHERE domain_id='d'");
  assert.equal((await reviewPublisher(f.database, input("approve"))).status, 200);
  assert.deepEqual(
    row(f.sqlite, "SELECT * FROM publisher_domains WHERE domain_id='d'"),
    before
  );
});

test("reject atomically rejects publisher and primary domain without monetization", async t => {
  const f = fixture(t);
  const protectedBefore = protectedSnapshot(f.sqlite);
  const result = await reviewPublisher(f.database, input("reject"));
  assert.equal(result.status, 200);
  const publisher = row(f.sqlite,
    "SELECT account_status FROM publishers WHERE publisher_id='p'");
  const domain = row(f.sqlite,
    "SELECT review_status,reviewed_at,monetization_status FROM publisher_domains WHERE domain_id='d'");
  assert.equal(publisher.account_status, "rejected");
  assert.equal(domain.review_status, "rejected");
  assert.ok(domain.reviewed_at);
  assert.equal(domain.monetization_status, "disabled");
  assert.deepEqual(protectedSnapshot(f.sqlite), protectedBefore);
});

test("reject retry is idempotent and opposite decisions conflict", async t => {
  const rejected = fixture(t);
  assert.equal((await reviewPublisher(rejected.database, input("reject"))).status, 200);
  rejected.sqlite.exec(`
    UPDATE publishers SET updated_at='2001-01-01 00:00:00' WHERE publisher_id='p';
    UPDATE publisher_domains
      SET reviewed_at='2001-01-01 00:00:00', updated_at='2001-01-01 00:00:00'
      WHERE domain_id='d';
  `);
  const publisherBefore = row(rejected.sqlite,
    "SELECT * FROM publishers WHERE publisher_id='p'");
  const domainBefore = row(rejected.sqlite,
    "SELECT * FROM publisher_domains WHERE domain_id='d'");
  assert.equal((await reviewPublisher(rejected.database, input("reject"))).status, 200);
  assert.deepEqual(row(rejected.sqlite,
    "SELECT * FROM publishers WHERE publisher_id='p'"), publisherBefore);
  assert.deepEqual(row(rejected.sqlite,
    "SELECT * FROM publisher_domains WHERE domain_id='d'"), domainBefore);
  assert.equal((await reviewPublisher(rejected.database, input("approve"))).status, 409);

  const approved = fixture(t);
  assert.equal((await reviewPublisher(approved.database, input("approve"))).status, 200);
  assert.equal((await reviewPublisher(approved.database, input("reject"))).status, 409);
});

const approvalInvalid = [
  "UPDATE publishers SET terms_version=NULL",
  "UPDATE publishers SET terms_version='old'",
  "UPDATE publishers SET terms_accepted_at=NULL",
  "UPDATE publishers SET terms_accepted_by_user_id=NULL",
  "UPDATE publishers SET install_public_key=NULL",
  "UPDATE publishers SET install_public_key='cfi_INVALID'",
  "UPDATE publisher_domains SET install_status='not_detected' WHERE domain_id='d'",
  "UPDATE publisher_domains SET verification_status='failed' WHERE domain_id='d'",
  "UPDATE publisher_domains SET first_seen_at=NULL WHERE domain_id='d'",
  "UPDATE publisher_domains SET last_seen_at=NULL WHERE domain_id='d'",
  "UPDATE publisher_domains SET verified_at=NULL WHERE domain_id='d'"
];

for (const mutation of approvalInvalid) {
  test(`approve fails closed: ${mutation}`, async t => {
    const f = fixture(t);
    f.sqlite.exec(mutation);
    const before = row(f.sqlite,
      "SELECT * FROM publisher_domains WHERE domain_id='d'");
    assert.equal((await reviewPublisher(f.database, input("approve"))).status, 409);
    assert.deepEqual(row(f.sqlite,
      "SELECT * FROM publisher_domains WHERE domain_id='d'"), before);
  });
}

test("reject remains available for a degraded submitted application", async t => {
  const f = fixture(t);
  f.sqlite.exec(`
    UPDATE publishers
      SET terms_version=NULL,terms_accepted_at=NULL,
          terms_accepted_by_user_id=NULL,install_public_key=NULL
      WHERE publisher_id='p';
    UPDATE publisher_domains
      SET install_status='not_detected',verification_status='failed',
          first_seen_at=NULL,last_seen_at=NULL,verified_at=NULL
      WHERE domain_id='d';
  `);
  assert.equal((await reviewPublisher(f.database, input("reject"))).status, 200);
  assert.equal(row(f.sqlite,
    "SELECT account_status FROM publishers WHERE publisher_id='p'").account_status,
    "rejected");
});

test("review requires exactly one primary domain", async t => {
  const none = fixture(t);
  none.sqlite.exec("UPDATE publisher_domains SET is_primary=0 WHERE domain_id='d'");
  assert.equal((await reviewPublisher(none.database, input("approve"))).status, 409);
  assert.equal((await reviewPublisher(none.database, input("reject"))).status, 409);

  const ambiguous = fixture(t);
  ambiguous.sqlite.exec(`
    DROP INDEX ux_publisher_domains_one_primary;
    UPDATE publisher_domains SET is_primary=1 WHERE domain_id='d-secondary';
  `);
  assert.equal((await reviewPublisher(ambiguous.database, input("approve"))).status, 409);
  assert.equal((await reviewPublisher(ambiguous.database, input("reject"))).status, 409);
});

for (const status of ["draft", "active", "suspended", "closed"]) {
  test(`non-pending publisher ${status} cannot be reviewed`, async t => {
    const f = fixture(t);
    f.sqlite.exec(`UPDATE publishers SET account_status='${status}' WHERE publisher_id='p'`);
    assert.equal((await reviewPublisher(f.database, input("approve"))).status, 409);
    assert.equal((await reviewPublisher(f.database, input("reject"))).status, 409);
  });
}

test("reject batch failure rolls both tables back", async t => {
  const f = fixture(t);
  const publisherBefore = row(f.sqlite,
    "SELECT * FROM publishers WHERE publisher_id='p'");
  const domainBefore = row(f.sqlite,
    "SELECT * FROM publisher_domains WHERE domain_id='d'");
  f.state.failBatchAt = 1;
  await assert.rejects(
    reviewPublisher(f.database, input("reject")),
    /injected batch failure/
  );
  assert.deepEqual(row(f.sqlite,
    "SELECT * FROM publishers WHERE publisher_id='p'"), publisherBefore);
  assert.deepEqual(row(f.sqlite,
    "SELECT * FROM publisher_domains WHERE domain_id='d'"), domainBefore);
});

test("same-decision concurrent calls converge to one stable result", async t => {
  const approve = fixture(t);
  const a = await Promise.all([
    reviewPublisher(approve.database, input("approve")),
    reviewPublisher(approve.database, input("approve"))
  ]);
  assert.deepEqual(a.map(x => x.status), [200, 200]);

  const reject = fixture(t);
  const r = await Promise.all([
    reviewPublisher(reject.database, input("reject")),
    reviewPublisher(reject.database, input("reject"))
  ]);
  assert.deepEqual(r.map(x => x.status), [200, 200]);
});
