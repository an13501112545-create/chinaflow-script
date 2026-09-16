# Runtime install TEST acceptance — future authorized procedure

Checkpoint C2 is local implementation and validation only. C2 itself does NOT
apply remote migrations, access remote D1, deploy anything, issue installs, or
implement verification. Production remains untouched. Future TEST migration and
TEST deployment require separate authorization. This document grants none.

Use placeholders below only after independently confirming their TEST scope.
Never paste credentials, actual identifiers, install keys, customer domains, or
production values into this document or acceptance logs. Retain any necessary
sensitive evidence privately and redact the shared result.

## Separately authorized sequence

1. **Verify the exact commit.** Require a clean worktree and the separately
   approved C2 commit. Check the five-file scope, unchanged runtime sources,
   unchanged migrations and dependencies, and run all local C2/B/C1 regressions.
   Record the currently deployed TEST Worker version privately as the rollback
   target. Inspect the TEST config and confirm its D1 binding resolves only to
   the intended TEST database. Stop on any target mismatch.
2. **Apply migration 0007 to TEST D1 only.** After explicit migration authorization,
   list pending migrations using the TEST config and `CHINAFLOW_EVENTS` binding.
   Inspect migration 0007 and confirm no unexpected pending migrations would be
   applied. Apply only the authorized TEST migration; stop if the command would
   apply other migrations. Do not use any production config or database.
3. **Verify migration.** List migrations again and inspect the resulting TEST
   schema/indexes against migration 0007. Record redacted acceptance evidence.
4. **Deploy the Config API TEST Worker.** After separate deployment authorization,
   validate syntax/config and run Wrangler dry-run packaging. Confirm the source
   checkpoint, TEST Worker target, and TEST D1 binding again; then deploy that
   exact checkpoint with `wrangler.publisher-config-api.test.jsonc`. No other
   Worker is part of this procedure.
5. **Verify runtime URLs on `<TEST_RUNTIME_ORIGIN>`.** Check GET and HEAD for
   `/runtime/loader.js`, `/runtime/loader-v0.3.js`, and
   `/runtime/chinaflow-v0.6.js`. Compare response bytes privately with the committed
   source files. Expect JavaScript UTF-8, nosniff, public wildcard asset CORS,
   no cookies, no redirects, and empty HEAD bodies with matching GET headers.
   The stable alias must use `no-store`; versioned paths must use
   `public, max-age=31536000, immutable`. Unknown runtime paths must return empty
   404; POST/PUT/DELETE on known assets must return 405 with `Allow: GET, HEAD`.
   Query parameters must never select other files. No generic asset directory
   or repository paths may be exposed.
6. **Create a synthetic TEST fixture with `install_public_key`.** With explicit
   fixture-write authorization, create only synthetic publisher/domain/placement
   and related records required by the existing schema. Use a fresh TEST-only
   public key, retain it privately, and track exact fixture ownership for cleanup.
   Do not create or call an install issuance endpoint. Start with an ineligible
   draft/unverified fixture and no production collector, affiliate destination,
   customer record, or production tracking value. Do not change eligibility logic.
7. **Test inert config.** Request `/v1/config?install_key=<SYNTHETIC_TEST_KEY>`
   with the exact controlled HTTPS TEST page Origin. Expect the existing inert
   config and specific Origin CORS. Missing/wrong Origin and unknown keys must
   remain generic denials without wildcard CORS. Also check the publisher selector.
8. **Test active synthetic config under controlled TEST conditions only.** With
   authorization for the synthetic fixture changes, satisfy existing eligibility
   requirements using synthetic data. Confirm active config, placement/attribution
   isolation, and exact Origin binding. Confirm every possible analytics and CTA
   destination is TEST-safe before browser execution; if an allowed synthetic
   fixture cannot prevent production traffic, stop this phase. Never loosen
   supplier validation or config eligibility to make a test pass.
9. **Browser acceptance.** On the controlled HTTPS TEST page, load
   `<TEST_RUNTIME_ORIGIN>/runtime/loader.js` with `data-chinaflow-install`
   set privately to the synthetic key. Observe the same-origin chain:
   loader → `/runtime/chinaflow-v0.6.js` → `/v1/config?install_key=…`.
   Confirm inert/active behavior, allowed Origin binding and fail-open behavior.
   Use a controlled browser network allowlist/interception to prevent any
   production service contact. Redact keys and query strings from shared evidence.
10. **Verify isolation.** Audit the commands, selected bindings, fixture ownership,
    and browser network evidence. Confirm no production services or data were
    touched; do not query production to perform this check.
11. **Clean up synthetic fixture.** Remove only the recorded synthetic TEST rows,
    in foreign-key-safe order, and the controlled snippet/page. Confirm cleanup
    using TEST-only readback. Never use broad deletes or delete the TEST database.
12. **Rollback if required.** Restore the privately recorded previous TEST Worker
    version/source and verify its expected config behavior. Disable/remove the
    synthetic snippet first if its runtime routes will disappear. Preserve D1
    history and the applied additive migration; do not edit or reverse migration
    history as a Worker rollback. Do not replace released versioned asset content:
    use a new immutable version for future changes. Stable alias changes must
    remain independently reviewable and reversible.

## Local C2 implementation contract

`runtime-assets-v0.1.mjs` uses literal text-module imports of the actual loader
and engine files, selected by exact path. No copied source body, network fetch,
filesystem access at runtime, authentication, or D1 lookup is involved. Query
parameters are ignored for asset selection. URL dot-segment normalization may
turn a traversal request into a non-runtime path; the tested config/manifest
traversals still receive generic 404 responses. Config API routing and its
Origin-specific CORS remain separate.

Run `node --test publisher-platform/tests/runtime-assets-v0.1.test.mjs` for
byte-integrity, route, method, header, D1-isolation, config, and actual Wrangler
packaging/workerd checks. The acceptance test invokes Wrangler **dry-run only**
and uses ephemeral local Miniflare D1 with synthetic fixtures. Its migrations
run locally in that disposable database, never in remote TEST or production D1.
