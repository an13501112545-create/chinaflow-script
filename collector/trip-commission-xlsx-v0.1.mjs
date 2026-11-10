import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  parseMoneyToMicros,
  preflightTripCommissionRows
} from "./reporting-importer-core-v0.1.mjs";

export const TRIP_COMMISSION_HEADERS = Object.freeze([
  "Site Name", "Site ID", "Alliance ID", "Booking ID", "Commission Date",
  "Date (GMT+8)", "Check-out/Ticket Issue Date", "Product Type", "Prod. Sub-Type",
  "Region", "OUID", "Currency", "Booking Amount", "Commission Amount", "Ratio",
  "Type", "Booking Status", "tripSub1", "tripSub3"
]);

function fail(message) {
  // Do not include raw row values (particularly OUID) in diagnostics.
  throw new Error(`Trip commission XLSX: ${message}`);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value !== "1970-01-01" &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function money(value, currency) {
  // Only the observed currency/prefix pair is accepted. Other formats need evidence.
  if (currency !== "USD" || !/^US\$[+-]?\d+(?:\.\d{1,6})?$/.test(value)) {
    fail("unsupported currency or money format");
  }
  const decimal = value.slice(3);
  if (parseMoneyToMicros(decimal) === null) fail("invalid money amount");
  return decimal;
}

// Public table adapter permits focused schema tests without generating fake XLSX files.
export async function adaptTripCommissionTable(table) {
  if (!Array.isArray(table) || table.length < 2) fail("report has no data rows");
  if (!Array.isArray(table[0]) || table[0].length !== 19 ||
      !TRIP_COMMISSION_HEADERS.every((header, index) => table[0][index] === header)) {
    fail("expected exact 19-column header schema");
  }
  let aid;
  const rows = table.slice(1).map(values => {
    if (!Array.isArray(values) || values.length !== 19 ||
        !values.every(value => typeof value === "string")) fail("invalid row shape");
    const raw = Object.fromEntries(TRIP_COMMISSION_HEADERS.map((key, i) => [key, values[i]]));
    // Tracking may legitimately be absent; never guess attribution.
    for (const header of TRIP_COMMISSION_HEADERS.slice(0, 17)) {
      if (!raw[header].trim()) fail(`missing required field: ${header}`);
    }
    for (const header of ["Site ID", "Alliance ID", "Booking ID"]) {
      if (!/^\d+$/.test(raw[header])) fail(`invalid identity field: ${header}`);
    }
    if (aid !== undefined && aid !== raw["Alliance ID"]) fail("mixed Alliance IDs");
    aid = raw["Alliance ID"];
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(raw["Commission Date"])) fail("invalid commission month");
    if (!validDate(raw["Date (GMT+8)"])) fail("invalid order date");
    const checkout = raw["Check-out/Ticket Issue Date"];
    const checkoutValid = validDate(checkout);
    return {
      orderId: raw["Booking ID"], sid: raw["Site ID"], aid,
      sidName: raw["Site Name"], tripSub1: raw.tripSub1, tripSub3: raw.tripSub3,
      productLine: raw["Product Type"], subOrderType: raw["Prod. Sub-Type"],
      planType: raw.Type, orderStatus: raw["Booking Status"],
      // Booking completion is not a commission or receipt-of-funds status.
      commissionStatus: null,
      bookingAmount: money(raw["Booking Amount"], raw.Currency),
      commissionAmount: money(raw["Commission Amount"], raw.Currency),
      currency: raw.Currency, commissionMonth: raw["Commission Date"],
      orderDate: raw["Date (GMT+8)"], checkOutOrIssueDate: checkoutValid ? checkout : null,
      ratio: raw.Ratio, region: raw.Region, ouid: raw.OUID,
      sourceEvidence: {
        raw,
        invalidDates: checkoutValid ? [] : [{
          field: "Check-out/Ticket Issue Date", raw: checkout,
          reason: checkout === "1970-01-01" ? "provider_placeholder" : "invalid_date"
        }]
      }
    };
  });
  // Reuse existing canonical identity and duplicate protection, with no DB access.
  await preflightTripCommissionRows(rows, { source: "trip.com", aid });
  return { aid, rows };
}

export async function parseTripCommissionXlsx(fileBytes) {
  if (!(fileBytes instanceof Uint8Array) || !fileBytes.length || fileBytes.length > 4 * 1024 * 1024) {
    fail("invalid file bytes");
  }
  const bytes = Buffer.from(fileBytes);
  const reader = fileURLToPath(new URL("./trip-commission-xlsx-reader-v0.1.py", import.meta.url));
  const table = await new Promise((resolve, reject) => {
    const child = spawn("python3", [reader], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let oversized = false;
    const timer = setTimeout(() => child.kill(), 10000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      output += chunk;
      if (output.length > 16 * 1024 * 1024) { oversized = true; child.kill(); }
    });
    // Reader errors deliberately contain no source values; do not echo subprocess output.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Trip commission XLSX: Python 3 reader unavailable"));
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0 || oversized) return reject(new Error("Trip commission XLSX: unsupported or invalid workbook"));
      try { resolve(JSON.parse(output)); }
      catch { reject(new Error("Trip commission XLSX: invalid reader output")); }
    });
    child.stdin.end(bytes);
  });
  return {
    ...await adaptTripCommissionTable(table),
    sheet_name: "Trip.com_Commission_Report",
    file_bytes: bytes,
    source_file_sha256: createHash("sha256").update(bytes).digest("hex")
  };
}
