# ChinaFlow Engineering Rules

## 1. Project mission

ChinaFlow is a production monetization and routing system.

Core production flow:

Publisher
→ loader.js
→ manifest.json
→ immutable production engine
→ config.json
→ intent/routing
→ affiliate offer
→ CTA
→ Trip.com

Analytics is a sidecar and must never become a dependency of the monetization path.

Primary priorities:

1. Preserve revenue-path reliability.
2. Preserve routing behavior unless a change is explicitly authorized.
3. Make the smallest possible change.
4. Test before production promotion.
5. Keep every production change independently reversible.

---

## 2. Operating discipline

Work one step at a time.

Never perform multiple production-changing actions in one step unless explicitly requested.

Default workflow:

inspect
→ change one small scope
→ validate
→ inspect diff
→ create checkpoint
→ push
→ test
→ explicitly authorize promotion

Do not jump ahead.

If one file can solve the task, do not modify three files.

Before modifying anything:

- inspect the actual current file
- inspect git status
- understand production impact
- identify rollback path

Never infer production state from memory when the repository can be inspected.

---

## 3. Git safety

Repository:

an13501112545-create/chinaflow-script

Default branch:

main

Never use:

git add -A

when unrelated or generated files exist.

Stage explicit paths only.

Before every commit:

- git status -sb
- inspect diff
- confirm exact intended file list

After every commit:

- git show --name-status --format=fuller HEAD

Before production deployment, prefer having the deployed source represented by a pushed Git commit.

Never commit Wrangler cache directories:

.wrangler/
collector/.wrangler/

These are local generated state.

---

## 4. Immutable production engine

Production engine files are immutable history.

Never overwrite an existing engine file.

Never convert an existing engine in place into a newer engine.

Current production engine:

engine_version:
0.4

engine file:
chinaflow-v0.4.js

immutable engine commit:
8bc504742d0a6f45d2cd920ffcb45aad5367eab2

production cutover commit:
90e59b2af0ec73ffbb4b0cda7b665798c3fb7e19

production tag:
chinaflow-v0.4-production

manifest currently points to v0.4.

Previous known-good rollback engine:

engine_version:
0.3

engine file:
chinaflow-v0.3.js

rollback engine commit:
c5fd2228dd06694cb7fadc25baa0bfde9c93e5ad

Any new production engine must be created as a new immutable versioned file, for example:

chinaflow-v0.5.js

Once promoted, old production engine files remain intact for rollback and audit.

---

## 5. Manifest is the production engine switch

manifest.json controls which immutable engine version is loaded.

Do not modify manifest.json early in a development cycle.

Preferred sequence:

1. build candidate engine
2. validate candidate
3. commit and push candidate
4. test candidate independently
5. prepare production config
6. validate production behavior
7. only then change manifest.json

Manifest promotion should preferably be a manifest-only commit.

Rollback should preferably also be manifest-only.

Default engine rollback target remains the pinned v0.3 commit unless explicitly superseded.

---

## 6. loader.js is infrastructure

loader.js is already installed permanently on the publisher.

Do not modify loader.js unless there is a demonstrated infrastructure-level requirement.

A normal engine, config, analytics, routing, or offer change should not require loader.js changes.

Do not use loader.js as a convenient place for feature logic.

---

## 7. config.json is production-live

Production engines load:

https://raw.githubusercontent.com/an13501112545-create/chinaflow-script/main/config.json

Therefore config.json is effectively unpinned production state.

Any pushed change to config.json can affect the currently running production engine immediately.

Treat config.json changes as production changes even before manifest promotion.

Config changes must be:

- minimal
- explicitly reviewed
- routing-safe
- attribution-safe
- independently reversible

Do not casually rename:

placement
trip_sub1
rule IDs
offer IDs
affiliate parameters

Do not alter Trip.com URLs unless explicitly authorized.

---

## 8. Existing attribution values

Some current production attribution values contain the suffix:

_test

Examples include:

flightflex_flights_yyz_bjs_test
flightflex_blog_china_inbound_hotels_generic_test
flightflex_auto_china_hotels_generic_test
flightflex_auto_china_flights_generic_test

Despite the suffix, these are existing production attribution values.

Do NOT remove or rename them during unrelated work.

Changing them is a separate attribution migration requiring explicit authorization.

---

## 9. Routing preservation

Unless explicitly changing routing behavior, preserve:

- exact path rule priority
- /post/ gating
- China travel intent detection
- intent thresholds
- product keyword lists
- product scoring
- flight/hotel thresholds
- generic fallback behavior
- offer lookup behavior
- CTA copy
- CTA styles
- CTA placement
- CTA destination URLs
- ordinary anchor navigation

Exact rules must continue to short-circuit automatic intent analysis.

Do not add analytics requirements to routing decisions.

---

## 10. CTA revenue-path rule

CTA navigation must remain a normal HTML anchor:

<a href="...">

with normal browser navigation.

Do not replace monetization navigation with JavaScript redirect logic.

Analytics must never:

- call preventDefault()
- await network completion before navigation
- block Trip.com opening
- control destination selection
- become required for CTA rendering

Revenue path first.
Analytics sidecar second.

---

## 11. Analytics architecture

Current Event Collector schema:

0.1

Supported browser events only:

cta_impression
cta_click

Do not add new browser events without explicit authorization.

Do not infer:

page views
engine loads
bookings
revenue

from these two event types.

Future conversion data should be stored separately from immutable raw browser events.

Do not mutate historical raw events to add future conversion results.

---

## 12. Analytics privacy

Browser analytics must not collect:

- IP as an application field
- user-agent
- cookies
- persistent user identity
- authentication data
- query-string contents
- URL hashes
- localStorage identifiers

Session identity:

crypto.randomUUID()
+ sessionStorage

with in-memory fallback only.

No cookies.
No localStorage.

Event IDs are independent UUIDs.

page_url should contain only:

origin + pathname

referrer should contain origin only when parseable.

---

## 13. Analytics transport

Preferred accepted transport:

navigator.sendBeacon()

Payload content type:

text/plain;charset=UTF-8

Do not add fetch or XHR fallback unless explicitly authorized.

Do not add:

- retry queues
- background resend systems
- blocking delivery guarantees

Analytics is fail-open.

If analytics fails, monetization must continue normally.

---

## 14. Event impression semantics

cta_impression means the rendered CTA actually became visible in the viewport.

Use IntersectionObserver when available.

Emit once per CTA render.

If IntersectionObserver is unavailable, use the previously accepted render-time fallback.

Clean up observers when CTA instances are replaced or SPA navigation occurs.

Do not redefine impression as page load.

---

## 15. Wix SPA behavior

FlightFlex uses SPA-style navigation behavior.

Preserve MutationObserver-based re-evaluation.

When asynchronous evaluation can overlap, use a generation/version guard so stale evaluations cannot render into a newer page state.

Do not introduce routing changes merely while solving an SPA timing issue.

---

## 16. Test / production separation

Test resources must remain isolated from production.

Test Worker:

chinaflow-event-collector-v0-1-test

Test D1:

chinaflow-events-v0-1-test

Test D1 ID:

f8c07a5f-f9e7-4595-9f25-ce3d525241d9

Production Worker:

chinaflow-event-collector-v0-1

Production D1:

chinaflow-events-v0-1

Production D1 ID:

838917da-3fb8-437e-bc00-caff178798e8

Do not rename test resources into production resources.

Do not repurpose test D1 as production D1.

Do not mix test and production event data.

---

## 17. Production collector

Production collector source:

collector/worker-v0.1.js

Production Wrangler config:

collector/wrangler.production.jsonc

Production D1 binding:

CHINAFLOW_EVENTS

Current production collector endpoint:

https://chinaflow-event-collector-v0-1.an13501112545.workers.dev/v1/events

Collector behavior must preserve:

- POST /v1/events
- 32 KB body limit
- schema validation
- event type allowlist
- required-field validation
- timestamp validation
- INSERT OR IGNORE
- event_id idempotency
- privacy-safe storage
- empty 500 on unexpected database errors

Do not add authentication, rate limiting, queues, dashboards, or new event types without explicit scope.

---

## 18. D1 migrations

Migration files are append-only history once used in production.

Applied migrations:

0001_events.sql
→ original browser events schema

0002_publisher_reporting_v0_1.sql
→ Publisher Reporting schema (already applied)

Do not edit an already-applied migration to change production schema.

Future schema changes should use:

0003_...
0004_...

etc.

Always:

list migrations
→ inspect
→ apply explicitly
→ list again
→ validate resulting schema

For production migration commands using custom Wrangler config, prefer the D1 binding:

CHINAFLOW_EVENTS

rather than relying on database-name resolution.

---

## 19. Production deployment rules

Before deploying a Worker:

1. validate syntax
2. validate config
3. run Wrangler dry-run
4. confirm D1 binding
5. ensure source is in a Git checkpoint
6. preferably push the checkpoint
7. deploy
8. perform HTTP acceptance
9. verify D1 row

Do not deploy and modify the frontend production engine in the same uncontrolled step.

---

## 20. Testing philosophy

Prefer real acceptance tests over assumptions.

Examples:

- browser CTA render
- real CTA click
- real sendBeacon
- HTTP status
- D1 readback
- duplicate event ID test
- exact rule test
- auto route test
- session continuity test

For analytics:

console event
→ network delivery
→ Worker
→ D1

is the acceptance chain.

For monetization:

route
→ CTA render
→ normal click
→ Trip.com opens

is the critical chain.

---

## 21. Failure handling

When a command fails:

Do not immediately modify code.

First classify the failure:

- local environment
- DNS/network
- authentication
- Wrangler behavior
- configuration
- Worker runtime
- D1
- browser behavior
- engine logic

Use the smallest diagnostic that isolates one layer.

Do not redeploy merely because a local curl fails if browser acceptance can distinguish network-path issues.

---

## 22. Rollback principle

Every production change must have a clear rollback before it is promoted.

Engine rollback:

manifest.json
→ pinned immutable previous engine

Collector rollback:

redeploy prior known-good Worker version/source

Config rollback:

restore prior exact config content

Do not delete production D1 during rollback.

Historical event data should remain available for diagnosis.

---

## 23. Scope control

Do not over-engineer.

Specifically do not introduce, unless explicitly requested:

- dashboards
- user profiles
- cookies
- persistent identity
- queues
- event streaming infrastructure
- multiple OTA integrations
- LLM routing
- attribution redesign
- new databases
- new Workers
- new frameworks

Solve the current problem with the minimum architecture required.

The approved Publisher Reporting scope is an explicit exception to this section.

The approved Publisher Reporting architecture may include:

- trip_bookings facts
- trip_commissions facts
- report_ingestion_runs ledger
- publisher_placements
- reporting importer core
- a separate internal Reporting Importer Worker
- reporting queries
- later internal admin / publisher reporting surfaces when separately approved

Important boundaries:

- Reporting Importer must NOT be added to the public Event Collector Worker.
- The existing Event Collector remains dedicated to browser /v1/events.
- Reporting must reuse the existing CHINAFLOW_EVENTS D1 unless a new database is explicitly approved.
- Do not create additional Workers or databases merely for convenience.
- Do not infer bookings, commissions, revenue, or publisher payout from browser click events.

---

## 24. Communication expectations

When proposing a change, state:

- exact target file
- exact intended change
- production impact
- validation
- rollback

When asked to execute one step, do only that step.

Do not silently continue into the next phase.

When validation fails, stop and report the failure before modifying additional files.

---

## 25. Current project state

- production engine v0.4 is live
- config analytics is enabled
- Event Collector v0.1 is live
- Publisher Reporting migration 0002 has been applied
- publisher placement seeds exist for production and test
- reporting importer deterministic core exists
- row normalization, deterministic identity, money micros, source-row hashing, batch duplicate detection, source-file hashing, ingestion preflight, mixed trip_sub1 attribution, source-file dedupe, D1 placement lookup, insert/update/unchanged planning, and atomic D1 persistence are implemented and tested
- the separate internal Reporting Importer Worker is deployed in TEST and Production
- TEST and Production Reporting Importer Workers both use an isolated `CHINAFLOW_REPORTING_IMPORT_TOKEN`; Wrangler configs require that secret
- TEST has prior importer acceptance data; Production currently has no booking/commission ingestion facts
- the Reporting Importer Worker accepts authenticated multipart input containing the original file bytes plus caller-prepared `rows_json`; it does not parse raw Trip.com CSV/XLSX files itself
- the publisher Reporting Query Layer is live in TEST and Production at `GET /api/reporting/summary`
- the publisher Reporting UI is live in TEST and Production at `/reporting`; browser code reads only the session-isolated Query Layer and never queries D1 directly
- reporting query authorization derives publisher identity from the authenticated session and active membership; the client cannot select `publisher_id`
- reporting queries enforce `attributed_publisher_id` tenant isolation and never authorize via `trip_sub1` alone
- reporting summary accepts a bounded `YYYY-MM` range plus optional exact placement filter, keeps booking and commission period bases explicit, groups monetary totals by currency, and exposes amount-row completeness so missing amounts are not silently treated as zero
- supplier-reported commission is explicitly labeled as supplier reporting and is never presented as Publisher earnings
- migration `0012_publisher_commercial_terms_v1.sql` is live in TEST and Production
- `publisher_commercial_terms` is append-only version history; official v1 standard terms are Publisher 70%, ChinaFlow 30%, USD monthly settlement, US$100 regular minimum payout, payable within 30 days after the applicable monthly cycle
- the formal Production publisher has exactly one standard commercial-terms version effective from its original v1 Terms acceptance; TEST historical `test-v1` data is not silently mapped to official standard terms
- reporting exposes current effective commercial terms, but does not calculate Publisher earnings
- real Trip.com export parser acceptance is deferred until the first real booking/commission export exists; absence of a real export does not block the Query Layer or other reporting engineering
- migration `0013_publisher_net_commission_revenue_v1.sql` is live in TEST and Production
- `publisher_commission_reconciliations` is the append-only Approved Commission decision layer and snapshots the exact matched Supplier commission fact plus Publisher/placement identity
- `publisher_net_commission_revenue_entries` is the append-only actual received/retained Net Commission Revenue ledger; signed adjustments are preserved and currency is explicit
- neither reconciliation nor Net Commission Revenue rows are auto-created from Supplier facts
- no Publisher earnings, FX conversion, payout amount, or payment obligation is inferred from Supplier commission status or amount
- the internal reconciliation writer is live in TEST and Production on the existing Reporting Importer Worker and uses an authorization secret separate from `CHINAFLOW_REPORTING_IMPORT_TOKEN`
- TEST reconciliation acceptance has created one synthetic Approved Commission decision and one synthetic Net Commission Revenue entry with exact-retry idempotency; the fixture is explicitly TEST-only
- Production currently has zero `trip_commissions`, zero reconciliation rows, zero Net Commission Revenue rows, and zero Publisher earnings rows
- Production reconciliation enablement has been accepted only at the authorization/boundary level; no synthetic financial facts are created in Production
- migration `0014_publisher_earnings_v1.sql` is live in TEST and Production
- `publisher_earnings_entries` is an append-only accrued-earnings ledger and is created only from a specific Net Commission Revenue row plus the effective commercial-terms version
- the internal Publisher earnings writer is live in TEST and Production on the existing Reporting Importer Worker and reuses the isolated reconciliation/accounting authorization secret
- same-currency exact-micros earnings are supported; cross-currency earnings fail closed and no FX rate is invented
- TEST earnings acceptance has created one explicitly synthetic CNY earnings row: CNY 5,000,000 micros Net Commission Revenue × 70% = CNY 3,500,000 micros, with exact-retry idempotency
- Production earnings enablement has been accepted only at the authorization/boundary level; Production still contains zero earnings facts
- the session-isolated Publisher Reporting Query Layer and `/reporting` UI expose confirmed accrued Publisher earnings separately from Supplier commission; the UI explicitly does not label earnings as payout or paid status
- payout scheduling is not implemented; `publishers.account_status='closed'` has no immutable termination effective timestamp, so final-settlement threshold exemption cannot yet be applied safely
- `collector/publisher-payout-scheduling-foundation-v0.1.md` defines the current payout-layer prerequisites and blockers

Next approved engineering direction:

- keep real Trip.com parser mapping deferred until a real booking/commission export exists
- when a real export becomes available, follow `collector/trip-export-parser-acceptance-v0.1.md` and do not invent source columns
- preserve source currency and actual settlement/reconciliation evidence; do not invent FX conversion or USD earnings without an authoritative conversion fact
- before implementing payout scheduling, model an authoritative immutable Publisher relationship-termination fact with an effective timestamp; do not infer termination from `updated_at`, domain release, monetization disablement, or current account status alone
- after the termination fact exists, define recurring threshold/carry-forward semantics across commercial-terms versions and the final-settlement threshold exemption before creating a payout scheduling migration
- keep payout scheduling separate from payment execution, KYB/KYC/payment-readiness facts, and actual paid-state records
- do not create another Worker or database for settlement unless separately approved; continue using the existing D1 sidecar and accounting writer where safe

---

## 26. Publisher Reporting architecture

Publisher Reporting is a sidecar to the monetization path, same as analytics.

Durable data model:

events
→ browser engagement facts

trip_bookings
→ Trip.com booking facts

trip_commissions
→ Trip.com commission facts

publisher_commercial_terms
→ append-only publisher share / settlement rules

publisher_commission_reconciliations
→ append-only Approved Commission decisions over Supplier facts

publisher_net_commission_revenue_entries
→ append-only actual received/retained Net Commission Revenue facts

future settlement facts
→ Publisher earnings / payout ledger after authoritative FX where required

Attribution:

events.trip_sub1 = trip_bookings.trip_sub1

trip_sub1 is placement-level attribution, NOT a click ID.

Booking → Commission relationship uses the provider order identity (source_order_id / order_id) and may be one booking → multiple commission facts.

Unknown / missing trip_sub1 facts must be preserved.

Never estimate revenue facts.

Tenant isolation:

- trip_sub1 is the placement-level attribution key.
- publisher_id is the tenant / authorization boundary.
- Reporting queries and publisher-facing surfaces must always enforce publisher_id isolation.
- A trip_sub1 match must never by itself authorize access to another publisher's data.
- Unattributed Trip facts may remain with attributed_publisher_id = NULL and must not be exposed to a publisher merely because another field happens to match.

---
