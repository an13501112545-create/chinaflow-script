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
- row normalization, deterministic identity, money micros, source-row hashing, batch duplicate detection, source-file hashing, ingestion preflight, and mixed trip_sub1 attribution are implemented and tested
- no Reporting Importer Worker has been deployed yet
- real Trip.com export parser is NOT yet accepted because a real booking/export file is not yet available

Next approved engineering direction:

- strengthen ingestion preflight validation
- source-file dedupe
- D1 placement lookup
- insert/update/unchanged planning
- atomic D1 persistence
- then a separate internal Reporting Importer Worker

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

future commercial terms
→ publisher payout / share rules

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
