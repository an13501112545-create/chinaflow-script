import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../audit/production-publisher-lifecycle-snapshot-readonly.mjs", import.meta.url), "utf8");

test("lifecycle snapshot is production read-only guarded", () => {
  assert.match(source, /Snapshot SQL must be SELECT-only/);
  assert.match(source, /Multiple SQL statements rejected/);
  assert.match(source, /--remote/);
  assert.match(source, /Git must be clean and synced/);
});

test("lifecycle snapshot excludes publisher user identity data", () => {
  assert.doesNotMatch(source, /publisher_users/);
  assert.doesNotMatch(source, /email/i);
});

test("lifecycle snapshot covers core operating stages", () => {
  for (const marker of ["account_status", "terms_status", "install_status",
    "verification_status", "review_status", "monetization_status",
    "provisioning_status", "commercial_terms_status", "clicks",
    "bookings", "commission_facts", "earnings_entries"]) {
    assert.ok(source.includes(marker), `missing lifecycle marker: ${marker}`);
  }
});
