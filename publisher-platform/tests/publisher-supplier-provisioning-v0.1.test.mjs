import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  startSupplierProvisioning,
  completeSupplierProvisioning
} from "../publisher-supplier-provisioning-v0.1.mjs";

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");

  const migrations = new URL("../../collector/migrations/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter(name => /^000[1-9]_.*\.sql$/.test(name)).sort()) {
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
      install_status,verification_status,claim_status,claim_acquired_at,review_status,
      monetization_status,first_seen_at,last_seen_at,
      verified_at,reviewed_at
    ) VALUES (
      'd','p','example.test',1,
      'detected','verified','claimed',CURRENT_TIMESTAMP,'approved',
      'disabled',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    );
  `);

  let batchQueue = Promise.resolve();
  const state = { failBatchAt: null };
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
            if (state.failBatchAt === index) {
              throw new Error("injected batch failure");
            }
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
    try {
      assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      sqlite.close();
    }
  });

  return { sqlite, database, state };
}

function row(db, sql) {
  return db.prepare(sql).get();
}

function protectedSnapshot(db) {
  return {
    publisher: row(db, "SELECT * FROM publishers WHERE publisher_id='p'"),
    domain: row(db, "SELECT * FROM publisher_domains WHERE domain_id='d'"),
    offers: db.prepare("SELECT * FROM publisher_supplier_offers").all(),
    placements: db.prepare("SELECT * FROM publisher_placements").all()
  };
}

function site(db) {
  return row(
    db,
    "SELECT * FROM publisher_supplier_sites WHERE publisher_id='p' AND domain_id='d' AND supplier='trip.com'"
  );
}

test("start input is strict and supplier cannot be client-selected", async t => {
  const f = fixture(t);
  for (const input of [
    null,
    {},
    { publisher_id: "" },
    { publisher_id: "p", supplier: "trip.com" },
    { publisher_id: "p", action: "start" },
    { publisher_id: "p", sid: "forged" }
  ]) {
    const result = await startSupplierProvisioning(f.database, input);
    assert.equal(result.status, 400);
  }
  assert.equal(site(f.sqlite), undefined);
});

test("eligible start creates one real pending Trip.com supplier site only", async t => {
  const f = fixture(t);
  const before = protectedSnapshot(f.sqlite);

  const result = await startSupplierProvisioning(
    f.database,
    { publisher_id: "p" }
  );

  assert.equal(result.status, 201);
  assert.equal(result.body.provisioning.publisher_id, "p");
  assert.equal(result.body.provisioning.domain_id, "d");
  assert.equal(result.body.provisioning.supplier, "trip.com");
  assert.equal(result.body.provisioning.provisioning_status, "pending");
  assert.equal(result.body.provisioning.created, true);
  assert.match(
    result.body.provisioning.supplier_site_id,
    /^site_[0-9a-f-]{36}$/
  );

  const stored = site(f.sqlite);
  assert.equal(stored.supplier_site_id, result.body.provisioning.supplier_site_id);
  assert.equal(stored.supplier, "trip.com");
  assert.equal(stored.provisioning_status, "pending");
  assert.equal(stored.aid, null);
  assert.equal(stored.sid, null);
  assert.equal(stored.sid_name, null);
  assert.equal(stored.provisioned_at, null);

  const after = protectedSnapshot(f.sqlite);
  assert.deepEqual(after.publisher, before.publisher);
  assert.deepEqual(after.domain, before.domain);
  assert.deepEqual(after.offers, []);
  assert.deepEqual(after.placements, []);
});

test("start retry is idempotent and preserves supplier-site timestamps", async t => {
  const f = fixture(t);
  const first = await startSupplierProvisioning(
    f.database,
    { publisher_id: "p" }
  );
  assert.equal(first.status, 201);

  f.sqlite.exec(`
    UPDATE publisher_supplier_sites
    SET created_at='2001-01-01 00:00:00',
        updated_at='2001-01-01 00:00:00'
  `);
  const before = site(f.sqlite);

  const retry = await startSupplierProvisioning(
    f.database,
    { publisher_id: "p" }
  );
  assert.equal(retry.status, 200);
  assert.equal(retry.body.provisioning.created, false);
  assert.deepEqual(site(f.sqlite), before);
});

const startInvalid = [
  "UPDATE publishers SET account_status='draft'",
  "UPDATE publishers SET account_status='rejected'",
  "UPDATE publishers SET terms_version=NULL",
  "UPDATE publishers SET terms_version='old'",
  "UPDATE publishers SET terms_accepted_at=NULL",
  "UPDATE publishers SET terms_accepted_by_user_id=NULL",
  "UPDATE publishers SET install_public_key=NULL",
  "UPDATE publishers SET install_public_key='bad'",
  "UPDATE publisher_domains SET review_status='pending'",
  "UPDATE publisher_domains SET review_status='rejected'",
  "UPDATE publisher_domains SET monetization_status='enabled'",
  "UPDATE publisher_domains SET monetization_status='paused'",
  "UPDATE publisher_domains SET install_status='not_detected'",
  "UPDATE publisher_domains SET verification_status='failed', claim_status='unclaimed', claim_acquired_at=NULL",
  "UPDATE publisher_domains SET claim_status='released', claim_ended_at=CURRENT_TIMESTAMP, claim_end_reason='owner_release'",
  "UPDATE publisher_domains SET claim_status='revoked', claim_ended_at=CURRENT_TIMESTAMP, claim_end_reason='admin_revoke'",
  "UPDATE publisher_domains SET first_seen_at=NULL",
  "UPDATE publisher_domains SET last_seen_at=NULL",
  "UPDATE publisher_domains SET verified_at=NULL",
  "UPDATE publisher_domains SET reviewed_at=NULL"
];

for (const mutation of startInvalid) {
  test(`start fails closed: ${mutation}`, async t => {
    const f = fixture(t);
    f.sqlite.exec(mutation);
    const result = await startSupplierProvisioning(
      f.database,
      { publisher_id: "p" }
    );
    assert.equal(result.status, 409);
    assert.equal(site(f.sqlite), undefined);
  });
}

test("start requires exactly one primary domain", async t => {
  const none = fixture(t);
  none.sqlite.exec("UPDATE publisher_domains SET is_primary=0");
  assert.equal(
    (await startSupplierProvisioning(
      none.database,
      { publisher_id: "p" }
    )).status,
    409
  );

  const ambiguous = fixture(t);
  ambiguous.sqlite.exec(`
    DROP INDEX ux_publisher_domains_one_primary;
    INSERT INTO publisher_domains (
      domain_id,publisher_id,hostname,is_primary,
      install_status,verification_status,review_status,
      monetization_status,first_seen_at,last_seen_at,
      verified_at,reviewed_at
    ) VALUES (
      'd2','p','second.example.test',1,
      'detected','verified','approved','disabled',
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    );
  `);
  assert.equal(
    (await startSupplierProvisioning(
      ambiguous.database,
      { publisher_id: "p" }
    )).status,
    409
  );
});

for (const existingStatus of ["failed", "disabled"]) {
  test(`start does not silently restart an existing ${existingStatus} site`, async t => {
    const f = fixture(t);
    f.sqlite.prepare(`
      INSERT INTO publisher_supplier_sites (
        supplier_site_id,publisher_id,domain_id,
        supplier,provisioning_status
      ) VALUES ('site-existing','p','d','trip.com',?)
    `).run(existingStatus);

    const before = site(f.sqlite);
    const result = await startSupplierProvisioning(
      f.database,
      { publisher_id: "p" }
    );
    assert.equal(result.status, 409);
    assert.deepEqual(site(f.sqlite), before);
  });
}

test("start acknowledges an already active site without mutation", async t => {
  const f = fixture(t);
  f.sqlite.exec(`
    INSERT INTO publisher_supplier_sites (
      supplier_site_id,publisher_id,domain_id,supplier,
      aid,sid,sid_name,provisioning_status,provisioned_at
    ) VALUES (
      'site-existing','p','d','trip.com',
      '10021103','330739613','existing',
      'active','2001-01-01 00:00:00'
    )
  `);
  const before = site(f.sqlite);
  const result = await startSupplierProvisioning(
    f.database,
    { publisher_id: "p" }
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.provisioning.provisioning_status, "active");
  assert.equal(result.body.provisioning.created, false);
  assert.deepEqual(site(f.sqlite), before);
});

test("complete input is strict and supplier cannot be client-selected", async t => {
  const f = fixture(t);
  await startSupplierProvisioning(f.database, { publisher_id: "p" });
  const before = site(f.sqlite);

  for (const input of [
    null,
    {},
    { publisher_id: "p" },
    { publisher_id: "p", aid: "", sid: "330739613" },
    { publisher_id: "p", aid: "10021103", sid: "" },
    { publisher_id: "p", aid: " 10021103", sid: "330739613" },
    { publisher_id: "p", aid: "10021103", sid: "330739613", supplier: "trip.com" },
    { publisher_id: "p", aid: "10021103", sid: "330739613", sid_name: 123 }
  ]) {
    const result = await completeSupplierProvisioning(f.database, input);
    assert.equal(result.status, 400);
  }

  assert.deepEqual(site(f.sqlite), before);
});

test("complete activates the pending supplier site and nothing else", async t => {
  const f = fixture(t);
  await startSupplierProvisioning(f.database, { publisher_id: "p" });
  const protectedBefore = protectedSnapshot(f.sqlite);

  const result = await completeSupplierProvisioning(f.database, {
    publisher_id: "p",
    aid: "10021103",
    sid: "330739613",
    sid_name: "chinaflow-e11"
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.provisioning.provisioning_status, "active");
  assert.equal(result.body.provisioning.aid, "10021103");
  assert.equal(result.body.provisioning.sid, "330739613");
  assert.equal(result.body.provisioning.sid_name, "chinaflow-e11");
  assert.equal(result.body.provisioning.completed, true);

  const stored = site(f.sqlite);
  assert.equal(stored.provisioning_status, "active");
  assert.equal(stored.aid, "10021103");
  assert.equal(stored.sid, "330739613");
  assert.equal(stored.sid_name, "chinaflow-e11");
  assert.ok(stored.provisioned_at);

  const protectedAfter = protectedSnapshot(f.sqlite);
  assert.deepEqual(protectedAfter.publisher, protectedBefore.publisher);
  assert.deepEqual(protectedAfter.domain, protectedBefore.domain);
  assert.deepEqual(protectedAfter.offers, []);
  assert.deepEqual(protectedAfter.placements, []);
});

test("complete retry with identical credentials is idempotent", async t => {
  const f = fixture(t);
  await startSupplierProvisioning(f.database, { publisher_id: "p" });
  const input = {
    publisher_id: "p",
    aid: "10021103",
    sid: "330739613",
    sid_name: "chinaflow-e11"
  };
  assert.equal(
    (await completeSupplierProvisioning(f.database, input)).status,
    200
  );

  f.sqlite.exec(`
    UPDATE publisher_supplier_sites
    SET provisioned_at='2001-01-01 00:00:00',
        updated_at='2001-01-01 00:00:00'
  `);
  const before = site(f.sqlite);
  const retry = await completeSupplierProvisioning(f.database, input);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.provisioning.completed, false);
  assert.deepEqual(site(f.sqlite), before);
});

test("complete and exact retry fail closed after hostname claim release", async t => {
  const pending = fixture(t);
  assert.equal((await startSupplierProvisioning(pending.database, { publisher_id: "p" })).status, 201);
  pending.sqlite.exec(`
    UPDATE publisher_domains
    SET claim_status='released', claim_ended_at=CURRENT_TIMESTAMP,
        claim_end_reason='owner_release'
    WHERE domain_id='d'
  `);
  assert.equal((await completeSupplierProvisioning(pending.database, {
    publisher_id: "p", aid: "10021103", sid: "330739613", sid_name: "chinaflow-e11"
  })).status, 409);
  assert.equal(site(pending.sqlite).provisioning_status, "pending");

  const active = fixture(t);
  assert.equal((await startSupplierProvisioning(active.database, { publisher_id: "p" })).status, 201);
  const credentials = { publisher_id: "p", aid: "10021103", sid: "330739613", sid_name: "chinaflow-e11" };
  assert.equal((await completeSupplierProvisioning(active.database, credentials)).status, 200);
  active.sqlite.exec(`
    UPDATE publisher_domains
    SET claim_status='released', claim_ended_at=CURRENT_TIMESTAMP,
        claim_end_reason='owner_release'
    WHERE domain_id='d'
  `);
  assert.equal((await completeSupplierProvisioning(active.database, credentials)).status, 409);
});

test("complete rejects credential drift after activation", async t => {
  const f = fixture(t);
  await startSupplierProvisioning(f.database, { publisher_id: "p" });
  assert.equal(
    (await completeSupplierProvisioning(f.database, {
      publisher_id: "p",
      aid: "10021103",
      sid: "330739613",
      sid_name: "chinaflow-e11"
    })).status,
    200
  );

  for (const input of [
    {
      publisher_id: "p",
      aid: "DIFFERENT",
      sid: "330739613",
      sid_name: "chinaflow-e11"
    },
    {
      publisher_id: "p",
      aid: "10021103",
      sid: "DIFFERENT",
      sid_name: "chinaflow-e11"
    },
    {
      publisher_id: "p",
      aid: "10021103",
      sid: "330739613",
      sid_name: "different"
    }
  ]) {
    assert.equal(
      (await completeSupplierProvisioning(f.database, input)).status,
      409
    );
  }
});

test("complete requires an existing pending site", async t => {
  const f = fixture(t);
  assert.equal(
    (await completeSupplierProvisioning(f.database, {
      publisher_id: "p",
      aid: "10021103",
      sid: "330739613"
    })).status,
    409
  );
});

for (const mutation of startInvalid) {
  test(`complete rechecks approval boundary: ${mutation}`, async t => {
    const f = fixture(t);
    await startSupplierProvisioning(f.database, { publisher_id: "p" });
    f.sqlite.exec(mutation);
    const before = site(f.sqlite);

    const result = await completeSupplierProvisioning(f.database, {
      publisher_id: "p",
      aid: "10021103",
      sid: "330739613"
    });

    assert.equal(result.status, 409);
    assert.deepEqual(site(f.sqlite), before);
  });
}

test("complete fails closed on a supplier SID collision", async t => {
  const f = fixture(t);
  await startSupplierProvisioning(f.database, { publisher_id: "p" });

  f.sqlite.exec(`
    INSERT INTO publishers (
      publisher_id,slug,display_name
    ) VALUES ('other','other','Other');
    INSERT INTO publisher_domains (
      domain_id,publisher_id,hostname
    ) VALUES ('other-d','other','other.example.test');
    INSERT INTO publisher_supplier_sites (
      supplier_site_id,publisher_id,domain_id,supplier,
      sid,provisioning_status
    ) VALUES (
      'other-site','other','other-d','trip.com',
      '330739613','active'
    );
  `);

  const before = site(f.sqlite);
  const result = await completeSupplierProvisioning(f.database, {
    publisher_id: "p",
    aid: "10021103",
    sid: "330739613"
  });
  assert.equal(result.status, 409);
  assert.deepEqual(site(f.sqlite), before);
});

test("same-operation concurrent calls converge", async t => {
  const start = fixture(t);
  const starts = await Promise.all([
    startSupplierProvisioning(start.database, { publisher_id: "p" }),
    startSupplierProvisioning(start.database, { publisher_id: "p" })
  ]);
  assert.deepEqual(starts.map(x => x.status).sort(), [200, 201]);
  assert.equal(
    start.sqlite.prepare(
      "SELECT count(*) AS n FROM publisher_supplier_sites"
    ).get().n,
    1
  );

  const complete = fixture(t);
  await startSupplierProvisioning(
    complete.database,
    { publisher_id: "p" }
  );
  const input = {
    publisher_id: "p",
    aid: "10021103",
    sid: "330739613",
    sid_name: "chinaflow-e11"
  };
  const completions = await Promise.all([
    completeSupplierProvisioning(complete.database, input),
    completeSupplierProvisioning(complete.database, input)
  ]);
  assert.deepEqual(completions.map(x => x.status), [200, 200]);
  assert.equal(site(complete.sqlite).provisioning_status, "active");
});

