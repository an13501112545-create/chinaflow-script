import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { activatePublisherCommercially } from "../publisher-commercial-activation-v0.1.mjs";
import { buildInstallConfigFromD1 } from "../config-reader-d1-v0.1.mjs";

function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../../collector/migrations/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter(name => /^000[1-7]_.*\.sql$/.test(name)).sort()) {
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
      monetization_status,first_seen_at,last_seen_at,
      verified_at,reviewed_at
    ) VALUES (
      'd','p','example.test',1,
      'detected','verified','approved','disabled',
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    );

    INSERT INTO publisher_supplier_sites (
      supplier_site_id,publisher_id,domain_id,supplier,
      aid,sid,sid_name,provisioning_status,provisioned_at
    ) VALUES (
      'site','p','d','trip.com',
      '10021103','330739613','chinaflow-p',
      'active',CURRENT_TIMESTAMP
    );
  `);

  let queue = Promise.resolve();
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
      const result = queue.then(execute, execute);
      queue = result.catch(() => {});
      return result;
    }
  };

  t.after(() => {
    try { assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []); }
    finally { sqlite.close(); }
  });

  return { sqlite, database, state };
}

const hotel = {
  product: "hotel",
  placement: "p_auto_china_hotels_generic",
  affiliate_url:
    "https://www.trip.com/hotels?Allianceid=10021103&SID=330739613&trip_sub1=p_auto_china_hotels_generic&trip_sub3=E12TEST"
};

const flight = {
  product: "flight",
  placement: "p_auto_china_flights_generic",
  affiliate_url:
    "https://www.trip.com/flights?Allianceid=10021103&SID=330739613&trip_sub1=p_auto_china_flights_generic&trip_sub3=E12TEST"
};

const input = (offers = [hotel, flight]) => ({
  publisher_id: "p",
  offers
});

function publisherState(db) {
  return db.prepare(`
    SELECT p.account_status,d.monetization_status,d.review_status,
      d.verification_status
    FROM publishers p JOIN publisher_domains d
      ON d.publisher_id=p.publisher_id AND d.is_primary=1
    WHERE p.publisher_id='p'
  `).get();
}

function commercialRows(db) {
  return {
    placements: db.prepare(`
      SELECT publisher_id,placement,supplier,external_tracking_key,is_active,
        effective_from,effective_to
      FROM publisher_placements
      WHERE publisher_id='p'
      ORDER BY external_tracking_key
    `).all(),
    offers: db.prepare(`
      SELECT publisher_id,domain_id,supplier_site_id,offer_key,product,
        affiliate_url,is_active
      FROM publisher_supplier_offers
      WHERE publisher_id='p'
      ORDER BY product
    `).all()
  };
}

test("activation input is strict", async t => {
  const f = fixture(t);
  for (const bad of [
    null, {}, { publisher_id: "p" },
    { publisher_id: "", offers: [hotel] },
    { publisher_id: "p", offers: [] },
    { publisher_id: "p", offers: [hotel, flight, hotel] },
    { publisher_id: "p", offers: [hotel], supplier: "trip.com" },
    { publisher_id: "p", offers: [{ ...hotel, extra: true }] },
    { publisher_id: "p", offers: [{ ...hotel, product: "car" }] },
    { publisher_id: "p", offers: [{ ...hotel, placement: "bad placement" }] },
    { publisher_id: "p", offers: [hotel, { ...flight, product: "hotel" }] }
  ]) {
    const result = await activatePublisherCommercially(f.database, bad);
    assert.equal(result.status, 400);
  }
  assert.deepEqual(commercialRows(f.sqlite), { placements: [], offers: [] });
});

const badUrls = [
  "http://www.trip.com/hotels?Allianceid=10021103&SID=330739613&trip_sub1=p_auto_china_hotels_generic",
  "https://evil.test/hotels?Allianceid=10021103&SID=330739613&trip_sub1=p_auto_china_hotels_generic",
  "https://user:pass@www.trip.com/hotels?Allianceid=10021103&SID=330739613&trip_sub1=p_auto_china_hotels_generic",
  "https://www.trip.com:444/hotels?Allianceid=10021103&SID=330739613&trip_sub1=p_auto_china_hotels_generic",
  "https://www.trip.com/hotels?Allianceid=WRONG&SID=330739613&trip_sub1=p_auto_china_hotels_generic",
  "https://www.trip.com/hotels?Allianceid=10021103&SID=WRONG&trip_sub1=p_auto_china_hotels_generic",
  "https://www.trip.com/hotels?Allianceid=10021103&SID=330739613&trip_sub1=WRONG",
  "https://www.trip.com/hotels?Allianceid=10021103&Allianceid=10021103&SID=330739613&trip_sub1=p_auto_china_hotels_generic",
  "https://www.trip.com/hotels?Allianceid=10021103&SID=330739613&SID=330739613&trip_sub1=p_auto_china_hotels_generic",
  "https://www.trip.com/hotels?Allianceid=10021103&SID=330739613&trip_sub1=p_auto_china_hotels_generic&trip_sub1=p_auto_china_hotels_generic",
  " https://www.trip.com/hotels?Allianceid=10021103&SID=330739613&trip_sub1=p_auto_china_hotels_generic",
  "https://www.trip.com/\\hotels?Allianceid=10021103&SID=330739613&trip_sub1=p_auto_china_hotels_generic"
];

for (const affiliate_url of badUrls) {
  test("activation rejects invalid or mismatched supplier URL: " + affiliate_url.slice(0, 45), async t => {
    const f = fixture(t);
    const result = await activatePublisherCommercially(
      f.database,
      input([{ ...hotel, affiliate_url }])
    );
    assert.equal(result.status, 409);
    assert.deepEqual(commercialRows(f.sqlite), { placements: [], offers: [] });
  });
}

test("eligible single-offer activation is atomic and produces runtime config", async t => {
  const f = fixture(t);
  const result = await activatePublisherCommercially(
    f.database,
    input([hotel])
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.activation.activated, true);
  assert.equal(result.body.activation.account_status, "active");
  assert.equal(result.body.activation.monetization_status, "enabled");
  assert.equal(result.body.activation.offer_count, 1);

  assert.deepEqual({ ...publisherState(f.sqlite) }, {
    account_status: "active",
    monetization_status: "enabled",
    review_status: "approved",
    verification_status: "verified"
  });

  const rows = commercialRows(f.sqlite);
  assert.equal(rows.placements.length, 1);
  assert.equal(rows.offers.length, 1);
  assert.equal(rows.placements[0].placement, hotel.placement);
  assert.equal(rows.placements[0].external_tracking_key, hotel.placement);
  assert.equal(rows.placements[0].supplier, "trip.com");
  assert.equal(rows.placements[0].is_active, 1);
  assert.equal(rows.offers[0].offer_key, "hotel");
  assert.equal(rows.offers[0].product, "hotel");
  assert.equal(rows.offers[0].affiliate_url, hotel.affiliate_url);
  assert.equal(rows.offers[0].is_active, 1);

  const config = await buildInstallConfigFromD1(
    f.database,
    "cfi_0123456789abcdef0123456789abcdef",
    "example.test",
    "https://example.test"
  );
  assert.equal(config.runtime_enabled, true);
  assert.equal(config.offers.length, 1);
  assert.equal(config.offers[0].product, "hotel");
  assert.equal(config.offers[0].placement, hotel.placement);
  assert.equal(config.offers[0].url, hotel.affiliate_url);
});

test("eligible two-offer activation creates exact hotel and flight graph", async t => {
  const f = fixture(t);
  const result = await activatePublisherCommercially(f.database, input());
  assert.equal(result.status, 200);
  assert.equal(result.body.activation.offer_count, 2);

  const rows = commercialRows(f.sqlite);
  assert.equal(rows.placements.length, 2);
  assert.equal(rows.offers.length, 2);

  const config = await buildInstallConfigFromD1(
    f.database,
    "cfi_0123456789abcdef0123456789abcdef",
    "example.test",
    "https://example.test"
  );
  assert.equal(config.runtime_enabled, true);
  assert.deepEqual(
    config.offers.map(x => x.product).sort(),
    ["flight", "hotel"]
  );
});

const invalidEligibility = [
  "UPDATE publishers SET account_status='draft'",
  "UPDATE publishers SET account_status='rejected'",
  "UPDATE publishers SET terms_version=NULL",
  "UPDATE publishers SET terms_version='old'",
  "UPDATE publishers SET terms_accepted_at=NULL",
  "UPDATE publishers SET terms_accepted_by_user_id=NULL",
  "UPDATE publishers SET install_public_key=NULL",
  "UPDATE publishers SET install_public_key='bad'",
  "UPDATE publisher_domains SET install_status='not_detected'",
  "UPDATE publisher_domains SET verification_status='failed'",
  "UPDATE publisher_domains SET review_status='pending'",
  "UPDATE publisher_domains SET review_status='rejected'",
  "UPDATE publisher_domains SET monetization_status='enabled'",
  "UPDATE publisher_domains SET monetization_status='paused'",
  "UPDATE publisher_domains SET first_seen_at=NULL",
  "UPDATE publisher_domains SET last_seen_at=NULL",
  "UPDATE publisher_domains SET verified_at=NULL",
  "UPDATE publisher_domains SET reviewed_at=NULL",
  "UPDATE publisher_supplier_sites SET provisioning_status='pending'",
  "UPDATE publisher_supplier_sites SET provisioning_status='failed'",
  "UPDATE publisher_supplier_sites SET provisioning_status='disabled'",
  "UPDATE publisher_supplier_sites SET aid=NULL",
  "UPDATE publisher_supplier_sites SET sid=NULL",
  "UPDATE publisher_supplier_sites SET provisioned_at=NULL"
];

for (const mutation of invalidEligibility) {
  test("activation fails closed: " + mutation, async t => {
    const f = fixture(t);
    f.sqlite.exec(mutation);
    const before = publisherState(f.sqlite);
    const result = await activatePublisherCommercially(f.database, input());
    assert.equal(result.status, 409);
    assert.deepEqual(publisherState(f.sqlite), before);
    assert.deepEqual(commercialRows(f.sqlite), { placements: [], offers: [] });
  });
}

test("activation requires exactly one primary domain", async t => {
  const none = fixture(t);
  none.sqlite.exec("UPDATE publisher_domains SET is_primary=0");
  assert.equal(
    (await activatePublisherCommercially(none.database, input())).status,
    409
  );

  const ambiguous = fixture(t);
  ambiguous.sqlite.exec(`
    DROP INDEX ux_publisher_domains_one_primary;
    INSERT INTO publisher_domains (
      domain_id,publisher_id,hostname,is_primary,
      install_status,verification_status,review_status,
      monetization_status,first_seen_at,last_seen_at,verified_at,reviewed_at
    ) VALUES (
      'd2','p','other.example.test',1,
      'detected','verified','approved','disabled',
      CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    );
  `);
  assert.equal(
    (await activatePublisherCommercially(ambiguous.database, input())).status,
    409
  );
});

test("preexisting commercial rows block first activation", async t => {
  const f = fixture(t);
  f.sqlite.exec(`
    INSERT INTO publisher_placements (
      placement_id,publisher_id,placement,supplier,external_tracking_key
    ) VALUES ('legacy','p','legacy','trip.com','legacy');
  `);
  assert.equal(
    (await activatePublisherCommercially(f.database, input())).status,
    409
  );
  assert.equal(publisherState(f.sqlite).account_status, "pending_review");
  assert.equal(publisherState(f.sqlite).monetization_status, "disabled");
});

test("activation retry with exact same graph is idempotent", async t => {
  const f = fixture(t);
  assert.equal(
    (await activatePublisherCommercially(f.database, input())).status,
    200
  );
  f.sqlite.exec(`
    UPDATE publishers SET updated_at='2001-01-01 00:00:00';
    UPDATE publisher_domains SET updated_at='2001-01-01 00:00:00';
    UPDATE publisher_placements SET updated_at='2001-01-01 00:00:00';
    UPDATE publisher_supplier_offers SET updated_at='2001-01-01 00:00:00';
  `);

  const before = {
    publisher: f.sqlite.prepare("SELECT * FROM publishers WHERE publisher_id='p'").get(),
    domain: f.sqlite.prepare("SELECT * FROM publisher_domains WHERE domain_id='d'").get(),
    rows: commercialRows(f.sqlite)
  };
  const retry = await activatePublisherCommercially(f.database, input());
  assert.equal(retry.status, 200);
  assert.equal(retry.body.activation.activated, false);
  assert.deepEqual(
    f.sqlite.prepare("SELECT * FROM publishers WHERE publisher_id='p'").get(),
    before.publisher
  );
  assert.deepEqual(
    f.sqlite.prepare("SELECT * FROM publisher_domains WHERE domain_id='d'").get(),
    before.domain
  );
  assert.deepEqual(commercialRows(f.sqlite), before.rows);
});

test("active publisher rejects graph drift", async t => {
  const f = fixture(t);
  assert.equal(
    (await activatePublisherCommercially(f.database, input())).status,
    200
  );

  const drifts = [
    input([hotel]),
    input([{ ...hotel, placement: "different_key",
      affiliate_url: hotel.affiliate_url.replaceAll(hotel.placement, "different_key") }, flight]),
    input([{ ...hotel, affiliate_url: hotel.affiliate_url + "&x=1" }, flight])
  ];

  for (const drift of drifts) {
    assert.equal(
      (await activatePublisherCommercially(f.database, drift)).status,
      409
    );
  }
});

test("batch failure rolls back all commercial activation writes", async t => {
  for (const failAt of [0, 1, 2, 3, 4, 5]) {
    const f = fixture(t);
    f.state.failBatchAt = failAt;
    await assert.rejects(
      activatePublisherCommercially(f.database, input()),
      /injected batch failure/
    );
    assert.deepEqual(
      { ...publisherState(f.sqlite) },
      {
        account_status: "pending_review",
        monetization_status: "disabled",
        review_status: "approved",
        verification_status: "verified"
      }
    );
    assert.deepEqual(commercialRows(f.sqlite), { placements: [], offers: [] });
  }
});

test("same activation concurrent calls converge to one graph", async t => {
  const f = fixture(t);
  const results = await Promise.all([
    activatePublisherCommercially(f.database, input()),
    activatePublisherCommercially(f.database, input())
  ]);
  assert.deepEqual(results.map(x => x.status), [200, 200]);
  assert.equal(
    results.filter(x => x.body.activation.activated === true).length,
    1
  );
  assert.equal(
    results.filter(x => x.body.activation.activated === false).length,
    1
  );
  assert.equal(commercialRows(f.sqlite).placements.length, 2);
  assert.equal(commercialRows(f.sqlite).offers.length, 2);
  assert.equal(publisherState(f.sqlite).account_status, "active");
  assert.equal(publisherState(f.sqlite).monetization_status, "enabled");
});
