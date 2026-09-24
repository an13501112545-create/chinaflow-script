import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const migrations = new URL("../../collector/migrations/", import.meta.url);

function migrationFiles(max = 12) {
  return readdirSync(migrations)
    .filter(name => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0,4)) <= max)
    .sort();
}

function apply(sqlite, files) {
  for (const file of files) sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
}

function seedAcceptedPublisher(sqlite, id = "p1", user = "u1") {
  sqlite.exec(`
    INSERT INTO publisher_users(user_id,email,email_normalized)
      VALUES ('${user}','${user}@example.test','${user}@example.test');
    INSERT INTO publishers(
      publisher_id,slug,display_name,account_status,
      terms_version,terms_accepted_at,terms_accepted_by_user_id
    ) VALUES (
      '${id}','${id}','Publisher ${id}','active',
      'chinaflow-publisher-terms-v1','2026-09-01 12:00:00','${user}'
    );
  `);
}

function standardRow(sqlite, publisherId = "p1") {
  const row = sqlite.prepare(`SELECT
    publisher_id,terms_source,terms_reference,publisher_share_bps,
    settlement_currency,minimum_payout_micros,settlement_cycle,
    payout_days_after_cycle_end,effective_from
    FROM publisher_commercial_terms WHERE publisher_id=?
  `).get(publisherId);
  return row ? { ...row } : row;
}

test("0012 backfills accepted v1 publishers with exact standard commercial terms", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys=ON");
    apply(sqlite, migrationFiles(11));
    seedAcceptedPublisher(sqlite);
    sqlite.exec(readFileSync(new URL("0012_publisher_commercial_terms_v1.sql", migrations), "utf8"));
    assert.deepEqual(standardRow(sqlite), {
      publisher_id: "p1",
      terms_source: "standard_terms",
      terms_reference: "chinaflow-publisher-terms-v1",
      publisher_share_bps: 7000,
      settlement_currency: "USD",
      minimum_payout_micros: 100000000,
      settlement_cycle: "monthly",
      payout_days_after_cycle_end: 30,
      effective_from: "2026-09-01 12:00:00"
    });
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { sqlite.close(); }
});

test("0012 acceptance trigger atomically creates one standard terms version", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys=ON");
    apply(sqlite, migrationFiles(12));
    sqlite.exec(`
      INSERT INTO publisher_users(user_id,email,email_normalized)
        VALUES ('u','u@example.test','u@example.test');
      INSERT INTO publishers(publisher_id,slug,display_name)
        VALUES ('p','p','Publisher');
    `);
    sqlite.exec(`UPDATE publishers SET
      terms_version='chinaflow-publisher-terms-v1',
      terms_accepted_at='2026-09-24 01:02:03',
      terms_accepted_by_user_id='u'
      WHERE publisher_id='p'`);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM publisher_commercial_terms WHERE publisher_id='p'").get().n, 1);
    assert.deepEqual(standardRow(sqlite, "p"), {
      publisher_id: "p",
      terms_source: "standard_terms",
      terms_reference: "chinaflow-publisher-terms-v1",
      publisher_share_bps: 7000,
      settlement_currency: "USD",
      minimum_payout_micros: 100000000,
      settlement_cycle: "monthly",
      payout_days_after_cycle_end: 30,
      effective_from: "2026-09-24 01:02:03"
    });
    sqlite.exec("UPDATE publishers SET updated_at=CURRENT_TIMESTAMP WHERE publisher_id='p'");
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM publisher_commercial_terms WHERE publisher_id='p'").get().n, 1);
  } finally { sqlite.close(); }
});

test("0012 commercial terms history is append-only and supports later account-specific versions", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys=ON");
    apply(sqlite, migrationFiles(11));
    seedAcceptedPublisher(sqlite);
    sqlite.exec(readFileSync(new URL("0012_publisher_commercial_terms_v1.sql", migrations), "utf8"));
    sqlite.prepare(`INSERT INTO publisher_commercial_terms(
      commercial_terms_id,publisher_id,terms_source,terms_reference,publisher_share_bps,
      settlement_currency,minimum_payout_micros,settlement_cycle,
      payout_days_after_cycle_end,effective_from
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      "pct_custom_1","p1","account_specific","agreement-2026-10",6500,
      "USD",50000000,"monthly",30,"2026-10-01 00:00:00"
    );
    const current = { ...sqlite.prepare(`SELECT terms_source,terms_reference,publisher_share_bps,
      minimum_payout_micros FROM publisher_commercial_terms
      WHERE publisher_id='p1' AND effective_from <= '2026-10-15 00:00:00'
      ORDER BY effective_from DESC, created_at DESC LIMIT 1`).get() };
    assert.deepEqual(current, {
      terms_source:"account_specific",
      terms_reference:"agreement-2026-10",
      publisher_share_bps:6500,
      minimum_payout_micros:50000000
    });
    assert.throws(() => sqlite.exec("UPDATE publisher_commercial_terms SET publisher_share_bps=1"), /append-only/);
    assert.throws(() => sqlite.exec("DELETE FROM publisher_commercial_terms"), /append-only/);
  } finally { sqlite.close(); }
});

test("0012 commercial term constraints reject invalid economic values", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys=ON");
    apply(sqlite, migrationFiles(12));
    sqlite.exec("INSERT INTO publishers(publisher_id,slug,display_name) VALUES ('p','p','P')");
    const base = ["p","account_specific","agreement",7000,"USD",100000000,"monthly",30,"2026-10-01"];
    const insert = sqlite.prepare(`INSERT INTO publisher_commercial_terms(
      commercial_terms_id,publisher_id,terms_source,terms_reference,publisher_share_bps,
      settlement_currency,minimum_payout_micros,settlement_cycle,payout_days_after_cycle_end,effective_from
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    for (const [id, patch] of [
      ["bad-share", {3:10001}],
      ["bad-currency", {4:"usd"}],
      ["bad-threshold", {5:-1}],
      ["bad-cycle", {6:"weekly"}],
      ["bad-days", {7:366}],
      ["bad-source", {1:"other"}]
    ]) {
      const values = [...base];
      for (const [index,value] of Object.entries(patch)) values[Number(index)] = value;
      assert.throws(() => insert.run(id, ...values), /CHECK constraint failed/);
    }
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM publisher_commercial_terms").get().n, 0);
  } finally { sqlite.close(); }
});
