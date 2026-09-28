import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { derivePublisherLifecycleAction } from "../publisher-lifecycle-action-v0.1.mjs";
import { buildPublisherOperatorWorkQueue } from "../publisher-operator-work-queue-v0.1.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROD_CONFIG = "collector/wrangler.production.jsonc";
const PROD_DB = "chinaflow-events-v0-1";
process.chdir(ROOT);

function run(command, args) {
  return execFileSync(command, args, {
    cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024
  });
}

assert.equal(run("git", ["status", "-sb"]).trim(), "## main...origin/main",
  "Git must be clean and synced");
assert.equal(run("git", ["rev-parse", "HEAD"]).trim(),
  run("git", ["rev-parse", "origin/main"]).trim());

function d1(sql) {
  const q = sql.trim();
  assert.match(q, /^SELECT\b/i, "Snapshot SQL must be SELECT-only");
  assert.ok(!q.slice(0, -1).includes(";"), "Multiple SQL statements rejected");
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const raw = run(npx, ["--no-install", "wrangler", "d1", "execute", PROD_DB,
    "--remote", "--config", PROD_CONFIG, "--yes", "--json", "--command", q]);
  const parsed = JSON.parse(raw);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  assert.equal(first?.success, true, "Production read-only query failed");
  return first.results ?? [];
}

const rows = d1(`
SELECT
  p.publisher_id,
  p.slug,
  p.display_name,
  p.account_status,
  CASE WHEN p.terms_accepted_at IS NULL THEN 'pending' ELSE 'accepted' END AS terms_status,
  d.hostname,
  d.install_status,
  d.verification_status,
  d.review_status,
  d.monetization_status,
  COALESCE(s.provisioning_status, 'not_started') AS provisioning_status,
  CASE WHEN ct.commercial_terms_id IS NULL THEN 'missing' ELSE 'active' END AS commercial_terms_status,
  COALESCE(ev.clicks, 0) AS clicks,
  COALESCE(b.bookings, 0) AS bookings,
  COALESCE(c.commission_facts, 0) AS commission_facts,
  COALESCE(e.earnings_entries, 0) AS earnings_entries,
  p.created_at,
  d.verified_at,
  d.reviewed_at,
  s.provisioned_at
FROM publishers p
LEFT JOIN publisher_domains d
  ON d.publisher_id=p.publisher_id AND d.is_primary=1
LEFT JOIN publisher_supplier_sites s
  ON s.publisher_id=p.publisher_id AND s.domain_id=d.domain_id AND s.supplier='trip.com'
LEFT JOIN publisher_commercial_terms ct
  ON ct.commercial_terms_id=(
    SELECT ct2.commercial_terms_id FROM publisher_commercial_terms ct2
    WHERE ct2.publisher_id=p.publisher_id
    ORDER BY ct2.effective_from DESC, ct2.created_at DESC LIMIT 1
  )
LEFT JOIN (
  SELECT publisher_id, sum(CASE WHEN event_type='cta_click' THEN 1 ELSE 0 END) AS clicks
  FROM events GROUP BY publisher_id
) ev ON ev.publisher_id=p.publisher_id
LEFT JOIN (
  SELECT attributed_publisher_id AS publisher_id, count(*) AS bookings
  FROM trip_bookings WHERE attribution_status='matched'
  GROUP BY attributed_publisher_id
) b ON b.publisher_id=p.publisher_id
LEFT JOIN (
  SELECT attributed_publisher_id AS publisher_id, count(*) AS commission_facts
  FROM trip_commissions WHERE attribution_status='matched'
  GROUP BY attributed_publisher_id
) c ON c.publisher_id=p.publisher_id
LEFT JOIN (
  SELECT publisher_id, count(*) AS earnings_entries
  FROM publisher_earnings_entries GROUP BY publisher_id
) e ON e.publisher_id=p.publisher_id
ORDER BY p.created_at, p.publisher_id
`);

const snapshots = rows.map(row => ({
  ...row,
  ...derivePublisherLifecycleAction(row)
}));

const operatorWorkQueue = buildPublisherOperatorWorkQueue(snapshots);

console.log(JSON.stringify(snapshots, null, 2));
console.log("OPERATOR_WORK_QUEUE=" + JSON.stringify(operatorWorkQueue, null, 2));
console.log(`OPERATOR_WORK_QUEUE_COUNT=${operatorWorkQueue.length}`);
console.log(`PUBLISHER_COUNT=${snapshots.length}`);
console.log("PRODUCTION_PUBLISHER_LIFECYCLE_SNAPSHOT_READ_ONLY=PASS");
