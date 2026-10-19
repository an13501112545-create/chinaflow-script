import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeTripProductLine, normalizeTripOrderStatus, normalizeTripBookingRow,
  createBookingRecordKey, preflightTripBookingRows, buildTripSub1PlacementMap
} from "../reporting-importer-core-v0.1.mjs";
import { prepareTripBookingImport } from "../reporting-importer-preparation-v0.1.mjs";
import { executeTripBookingImport } from "../reporting-importer-service-v0.1.mjs";
import { createSession } from "../../publisher-platform/auth-session-store-v0.1.mjs";
import { getPublisherReportingSummary } from "../../publisher-platform/publisher-reporting-query-v0.1.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "chinaflow-booking-synthetic-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, "synthetic.xlsx"), output = join(dir, "rows.json");
  execFileSync("python", ["-B", fileURLToPath(new URL("./trip-booking-xlsx-adapter-v0.1.test.py", import.meta.url)),
    "--fixture", input]);
  const command = ["-B", fileURLToPath(new URL("../trip-booking-xlsx-adapter-v0.1.py", import.meta.url)),
    "--input", input, "--output", output];
  const before = readFileSync(input);
  const report = JSON.parse(execFileSync("python", command, { encoding: "utf8" }));
  const json = readFileSync(output, "utf8");
  const repeated = JSON.parse(execFileSync("python", command, { encoding: "utf8" }));
  assert.deepEqual(repeated, report);
  assert.equal(readFileSync(output, "utf8"), json);
  assert.deepEqual(readFileSync(input), before);
  assert.equal(report.source_file_sha256, createHash("sha256").update(before).digest("hex"));
  return { rows: JSON.parse(json), bytes: before, report };
}

const placementRows = [
  { supplier: "trip.com", is_active: 1, external_tracking_key: "synthetic-p", publisher_id: "p", placement: "shared-name" },
  { supplier: "trip.com", is_active: 1, external_tracking_key: "synthetic-q", publisher_id: "q", placement: "shared-name" }
];
const context = { source: "trip.com", aid: "SYNTHETIC-AID", placementsByTripSub1: buildTripSub1PlacementMap(placementRows) };
const observation = { ingestion_run_id: "synthetic-run", started_at: "2026-10-02T00:00:00Z", observed_at: "2026-10-02T00:00:00Z" };

function inputFor(f, rows) {
  return { source: "trip.com", report_type: "booking", aid: context.aid,
    source_filename: "synthetic.xlsx", file_bytes: f.bytes, rows,
    placement_rows: placementRows, new_fact_ids: rows.map((_, i) => "synthetic-fact-" + i),
    context: observation };
}

test("exact measured aliases preserve raw values and legacy/unknown behavior", () => {
  for (const value of ["Hotels", "htl"]) {
    assert.deepEqual(normalizeTripProductLine(value), { raw: value, normalized: "hotel" });
  }
  for (const value of ["Pending", "P"]) {
    assert.deepEqual(normalizeTripOrderStatus(value), { raw: value, normalized: "pending" });
  }
  for (const value of ["hotels", "Future Product"]) {
    assert.deepEqual(normalizeTripProductLine(value), { raw: value, normalized: "unknown" });
  }
  for (const value of ["pending", "Future Status"]) {
    assert.deepEqual(normalizeTripOrderStatus(value), { raw: value, normalized: "unknown" });
  }
});

test("synthetic XLSX output preserves identity, money, dates, bytes and raw payload through preparation", async t => {
  const f = fixture(t);
  const prepared = await prepareTripBookingImport(inputFor(f, f.rows));
  const row = prepared.normalized_rows[0];
  assert.equal(row.source_order_id, "0009876543210987654");
  assert.equal(row.sid, "123456789");
  assert.equal(row.raw_product_line, "Hotels");
  assert.equal(row.normalized_product, "hotel");
  assert.equal(row.raw_order_status, "Pending");
  assert.equal(row.normalized_order_status, "pending");
  assert.equal(row.booking_amount_raw, "42.75");
  assert.equal(row.booking_amount_micros, 42750000);
  assert.equal(row.order_date, "2026-10-01 18:04");
  assert.equal(row.product_start_date, "2026-10-03 23:00");
  assert.equal(row.trip_sub3, null);
  assert.equal(row.attributed_publisher_id, "p");
  assert.equal(prepared.preflight.source_file_sha256, f.report.source_file_sha256);
  assert.deepEqual(JSON.parse(prepared.row_contexts[0].raw_payload_json), f.rows[0]);
  assert.equal(row.source_record_key, await createBookingRecordKey({ source: context.source,
    aid: context.aid, sid: "123456789", source_order_id: "0009876543210987654", raw_product_line: "Hotels" }));
  assert.notEqual(row.source_record_key, await createBookingRecordKey({ source: context.source,
    aid: context.aid, sid: "123456789", source_order_id: "0009876543210987654", raw_product_line: "htl" }));
  assert.deepEqual((await prepareTripBookingImport(inputFor(f, f.rows))).normalized_rows, prepared.normalized_rows);
});

test("unknown products/statuses remain unknown and missing/unmatched tracking stays unattributed", async t => {
  const { rows } = fixture(t);
  for (const [tripSub1, status] of [[null, "missing_trip_sub1"], ["unmatched-synthetic", "unmatched"]]) {
    const row = await normalizeTripBookingRow({ ...rows[0], tripSub1,
      productLine: "Future Product", orderStatus: "Future Status" }, context);
    assert.equal(row.normalized_product, "unknown");
    assert.equal(row.normalized_order_status, "unknown");
    assert.equal(row.raw_product_line, "Future Product");
    assert.equal(row.raw_order_status, "Future Status");
    assert.equal(row.attributed_publisher_id, null);
    assert.equal(row.attributed_placement, null);
    assert.equal(row.attribution_status, status);
  }
});

test("duplicate identities still fail and different unique orders are accepted", async t => {
  const { rows } = fixture(t);
  await assert.rejects(preflightTripBookingRows([rows[0], rows[0]], context), /Duplicate booking record key/);
  assert.equal((await preflightTripBookingRows([rows[0], { ...rows[0], orderId: "SYNTHETIC-OTHER" }], context)).length, 2);
});

test("adapter rows ingested into local SQLite never expose other publishers or unattributed facts", async t => {
  const f = fixture(t);
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys=ON");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) {
    sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  const database = {
    prepare(sql) {
      const bind = (...values) => ({
        sql, values,
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; }
      });
      return { bind };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(s => ({ success: true, meta: { changes: Number(sqlite.prepare(s.sql).run(...s.values).changes) } }));
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    }
  };
  sqlite.exec(
    "INSERT INTO publisher_users(user_id,email,email_normalized) VALUES ('u','p@example.test','p@example.test'),('v','q@example.test','q@example.test');" +
    "INSERT INTO publishers(publisher_id,slug,display_name,account_status) VALUES ('p','p','P','active'),('q','q','Q','active');" +
    "INSERT INTO publisher_memberships(membership_id,publisher_id,user_id,role,membership_status) VALUES ('m','p','u','owner','active'),('n','q','v','owner','active');"
  );
  for (const row of placementRows) {
    sqlite.prepare("INSERT INTO publisher_placements(placement_id,publisher_id,placement,supplier,external_tracking_key,is_active) VALUES (?,?,?,?,?,?)")
      .run("synthetic-placement-" + row.publisher_id, row.publisher_id, row.placement, row.supplier, row.external_tracking_key, row.is_active);
  }
  const rows = [f.rows[0],
    { ...f.rows[0], orderId: "SYNTHETIC-Q", tripSub1: "synthetic-q", amount: "200.00" },
    { ...f.rows[0], orderId: "SYNTHETIC-UNMATCHED", tripSub1: "unmatched-synthetic", amount: "300.00" },
    { ...f.rows[0], orderId: "SYNTHETIC-MISSING", tripSub1: null, amount: "400.00" }];
  await executeTripBookingImport(database, inputFor(f, rows));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_bookings").get().n, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM trip_bookings WHERE attributed_publisher_id IS NULL").get().n, 2);
  for (const [user, publisher, amount] of [["u", "p", 42750000], ["v", "q", 200000000]]) {
    const session = await createSession(database, user);
    const response = await getPublisherReportingSummary(database, session.token,
      { from: "2026-10", to: "2026-10", placement: "shared-name" });
    assert.equal(response.status, 200);
    assert.equal(response.body.reporting.publisher_id, publisher);
    assert.equal(response.body.reporting.bookings.rows, 1);
    assert.equal(response.body.reporting.bookings.by_currency[0].booking_amount_micros, amount);
    assert.equal(response.body.reporting.commissions.rows, 0);
    assert.equal(response.body.reporting.earnings.rows, 0);
  }
});
