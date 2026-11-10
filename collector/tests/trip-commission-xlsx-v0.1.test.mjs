import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  parseTripCommissionXlsx, adaptTripCommissionTable, TRIP_COMMISSION_HEADERS
} from "../trip-commission-xlsx-v0.1.mjs";
import { prepareTripCommissionImport } from "../reporting-importer-preparation-v0.1.mjs";
import { preflightTripCommissionRows, planSourceFileDedupe } from "../reporting-importer-core-v0.1.mjs";

const SHA256 = "b16cdc4d6dccc6184df597055d06f4e878f0f675ca04aae00b0ad29897025085";
// Only this opt-in path reads private bytes; the normal suite is code-only.
const originalPath = process.env.CHINAFLOW_TRIP_COMMISSION_TEST_FILE;
const realFileOnly = { skip: originalPath ? false : "CHINAFLOW_TRIP_COMMISSION_TEST_FILE not set; real original not verified" };
let original;
let parsed;
if (originalPath) {
  // Suppress filesystem diagnostics that may contain private paths.
  try { original = await readFile(originalPath); }
  catch { throw new Error("Unable to read opted-in Trip commission test file"); }
  assert.equal(createHash("sha256").update(original).digest("hex"), SHA256);
  parsed = await parseTripCommissionXlsx(original);
}

function table() {
  // Sanitized inline schema fixture, independent of the original workbook.
  return [Array.from(TRIP_COMMISSION_HEADERS), [
    "Synthetic test site", "123456789", "10000001", "9000000000000001", "2026-10",
    "2026-10-12", "1970-01-01", "Hotels", "Hotel", "Synthetic region",
    "synthetic-private-value", "USD", "US$113.11", "US$5.66", "5%",
    "Synthetic type", "Completed", "agent_booking_trippal360", ""
  ]];
}

test("original binary: fixed hash, exact schema, one row and source-preserving adapter", realFileOnly, () => {
  assert.equal(parsed.source_file_sha256, SHA256);
  assert.ok(Buffer.compare(parsed.file_bytes, original) === 0);
  assert.equal(parsed.sheet_name, "Trip.com_Commission_Report");
  assert.equal(parsed.rows.length, 1);
  const row = parsed.rows[0];
  assert.equal(row.orderId, "1433815295641015");
  assert.equal(row.sid, "330567322");
  assert.equal(row.tripSub1, "agent_booking_trippal360");
  assert.equal(row.aid, "10021103");
  assert.equal(row.bookingAmount, "113.11");
  assert.equal(row.commissionAmount, "5.66");
  assert.equal(row.sourceEvidence.raw["Commission Amount"], "US$5.66");
  assert.equal(row.orderStatus, "Completed");
  assert.equal(row.commissionStatus, null);
  assert.equal(row.checkOutOrIssueDate, null);
  assert.deepEqual(row.sourceEvidence.invalidDates, [{
    field: "Check-out/Ticket Issue Date", raw: "1970-01-01", reason: "provider_placeholder"
  }]);
  // Never print OUID, including in an assertion failure.
  assert.ok(typeof row.ouid === "string" && row.ouid.length > 0);
  assert.ok(row.sourceEvidence.raw.OUID === row.ouid);
});

async function assertPreparationContract(parsed, expectedHash) {
  const result = await prepareTripCommissionImport({
    source: "trip.com", report_type: "commission", aid: parsed.aid,
    source_filename: ".trip-commission-report-20261110.xlsx", file_bytes: parsed.file_bytes,
    rows: parsed.rows, new_fact_ids: ["test-only-commission"],
    placement_rows: [{
      supplier: "trip.com", is_active: 1, external_tracking_key: "agent_booking_trippal360",
      publisher_id: "pub_c6accded-8a2f-4103-939f-438bcf653d4a",
      placement: "pl_agent_booking_trippalholiday"
    }],
    context: { ingestion_run_id: "test-only-run", started_at: "2026-11-10T00:00:00Z", observed_at: "2026-11-10T00:00:00Z" }
  });
  assert.equal(result.preflight.source_file_sha256, expectedHash);
  assert.deepEqual(planSourceFileDedupe(result.preflight, null), {
    dedupe_status: "new", should_import: true, existing_ingestion_run_id: null
  });
  const existingRun = { ...result.preflight, ingestion_run_id: "test-only-prior-run" };
  assert.deepEqual(planSourceFileDedupe(result.preflight, existingRun), {
    dedupe_status: "duplicate", should_import: false, existing_ingestion_run_id: "test-only-prior-run"
  });
  assert.throws(() => planSourceFileDedupe(result.preflight, {
    ...existingRun, source_file_sha256: "0".repeat(64)
  }), /Mismatched ingestion dedupe candidate/);
  const row = result.normalized_rows[0];
  assert.equal(row.normalized_product, "hotel");
  assert.equal(row.raw_product_line, "Hotels");
  assert.equal(row.booking_amount_micros, 113110000);
  assert.equal(row.commission_amount_micros, 5660000);
  assert.equal(row.currency, "USD");
  assert.equal(row.raw_order_status, "Completed");
  assert.equal(row.normalized_order_status, "completed");
  assert.equal(row.raw_commission_status, null);
  assert.equal(row.normalized_commission_status, null);
  assert.equal(row.check_out_or_issue_date, null);
  assert.equal(row.attributed_publisher_id, "pub_c6accded-8a2f-4103-939f-438bcf653d4a");
  assert.equal(row.attributed_placement, "pl_agent_booking_trippalholiday");
  const evidence = JSON.parse(result.row_contexts[0].raw_payload_json).sourceEvidence;
  assert.ok(evidence.raw.OUID === parsed.rows[0].ouid);
  assert.equal(evidence.raw["Check-out/Ticket Issue Date"], "1970-01-01");
  assert.deepEqual(evidence.invalidDates, [{
    field: "Check-out/Ticket Issue Date", raw: "1970-01-01", reason: "provider_placeholder"
  }]);
  const [again] = await preflightTripCommissionRows(parsed.rows, { source: "trip.com", aid: parsed.aid });
  assert.equal(again.commission_record_key, row.commission_record_key);
  assert.equal(again.source_row_hash, row.source_row_hash);
}

test("table adapter through preparation: exact micros, matched placement, statuses and evidence", async () => {
  const adapted = await adaptTripCommissionTable(table());
  const file_bytes = Buffer.from(JSON.stringify(table()));
  await assertPreparationContract({ ...adapted, file_bytes }, createHash("sha256").update(file_bytes).digest("hex"));
});

test("original binary through preparation: exact contract and fixed source hash", realFileOnly, async () => {
  await assertPreparationContract(parsed, SHA256);
});

test("schema: zero rows, missing/extra/reordered/duplicate headers and incorrect row widths fail closed", async () => {
  const cases = [[], [table()[0]]];
  for (const kind of ["missing", "extra", "reorder", "duplicate", "short-row", "long-row"]) {
    const t = table();
    if (kind === "missing") t[0].pop();
    if (kind === "extra") t[0].push("Unsupported");
    if (kind === "reorder") [t[0][0], t[0][1]] = [t[0][1], t[0][0]];
    if (kind === "duplicate") t[0][1] = t[0][0];
    if (kind === "short-row") t[1].pop();
    if (kind === "long-row") t[1].push("");
    cases.push(t);
  }
  for (const t of cases) await assert.rejects(adaptTripCommissionTable(t), /Trip commission XLSX/);
});

test("missing required source values and invalid identities fail closed without leaking private values", async () => {
  for (let index = 0; index < 17; index++) {
    const t = table();
    t[1][index] = "";
    await assert.rejects(adaptTripCommissionTable(t), /missing required field/);
  }
  const t = table();
  t[1][3] = "1.433815295641015e15";
  await assert.rejects(adaptTripCommissionTable(t), /invalid identity/);
});

test("currency, prefix, malformed money and unsafe micros fail closed", async () => {
  for (const [currency, amount] of [
    ["EUR", "US$5.66"], ["usd", "US$5.66"], ["ZZZ", "US$5.66"],
    ["USD", "€5.66"], ["USD", "5.66"], ["USD", "US$5.1234567"],
    ["USD", "US$1,000.00"], ["USD", "US$9007199254.740992"]
  ]) {
    const t = table();
    t[1][11] = currency;
    t[1][13] = amount;
    await assert.rejects(adaptTripCommissionTable(t), /currency|money/);
  }
});

test("negative commission is preserved exactly; no funds-received status is invented", async () => {
  const t = table();
  t[1][13] = "US$-5.66";
  const { rows, aid } = await adaptTripCommissionTable(t);
  const [row] = await preflightTripCommissionRows(rows, { source: "trip.com", aid });
  assert.equal(row.commission_amount_micros, -5660000);
  assert.equal(row.normalized_commission_status, null);
});

test("malformed checkout is null with evidence; invalid order date/month fails closed", async () => {
  const t = table();
  t[1][6] = "2026-02-30";
  const { rows } = await adaptTripCommissionTable(t);
  assert.equal(rows[0].checkOutOrIssueDate, null);
  assert.equal(rows[0].sourceEvidence.invalidDates[0].reason, "invalid_date");
  t[1][5] = "2026-02-30";
  await assert.rejects(adaptTripCommissionTable(t), /invalid order date/);
  t[1][5] = "2026-10-12";
  t[1][4] = "2026-13";
  await assert.rejects(adaptTripCommissionTable(t), /invalid commission month/);
});

test("existing identity duplicate rejection and mixed-Alliance guard", async () => {
  const t = table();
  t.push([...t[1]]);
  await assert.rejects(adaptTripCommissionTable(t), /Duplicate commission record key/);
  t[2][13] = "US$7.00";
  await assert.rejects(adaptTripCommissionTable(t), /Duplicate commission record key/);
  t[2][2] = "999";
  await assert.rejects(adaptTripCommissionTable(t), /mixed Alliance/);
});

test("missing/unmatched tracking and unknown product never invent attribution", async () => {
  for (const tracking of ["", "unmatched", "agent_booking_trippal360 "]) {
    const t = table();
    t[1][17] = tracking;
    t[1][7] = "UnobservedProduct";
    const { rows, aid } = await adaptTripCommissionTable(t);
    const [row] = await preflightTripCommissionRows(rows, { source: "trip.com", aid });
    assert.equal(row.normalized_product, "unknown");
    assert.equal(row.attributed_publisher_id, null);
  }
});

function alteredWorkbook(mode) {
  // In-memory ZIP mutations only; original fixture is never rewritten.
  return execFileSync("python3", ["-c", `
import io,sys,zipfile
src=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
out=io.BytesIO()
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as dst:
 for item in src.infolist():
  data=src.read(item.filename)
  if item.filename=='xl/worksheets/sheet1.xml':
   if sys.argv[1]=='formula': data=data.replace(b'<v>330567322</v>',b'<f>1+1</f><v>330567322</v>')
   if sys.argv[1]=='duplicate': data=data.replace(b'</row>',b'<c r="B2"><v>1</v></c></row>')
   if sys.argv[1]=='extra': data=data.replace(b'r="S2"',b'r="T2"')
   if sys.argv[1]=='doctype': data=b'<!DOCTYPE sheet [<!ENTITY x "a">]>'+data
  dst.writestr(item.filename,data)
sys.stdout.buffer.write(out.getvalue())
`, mode], { input: original });
}

test("binary reader rejects corrupt ZIP without private fixture", async () => {
  await assert.rejects(parseTripCommissionXlsx(Buffer.from("invalid")), /unsupported or invalid workbook/);
});

test("original binary reader rejects formulas, duplicate cells, extra columns and XML declarations", realFileOnly, async () => {
  for (const bytes of ["formula", "duplicate", "extra", "doctype"].map(alteredWorkbook)) {
    await assert.rejects(parseTripCommissionXlsx(bytes), /unsupported or invalid workbook/);
  }
});
