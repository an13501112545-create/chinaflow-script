import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createSession } from "../auth-session-store-v0.1.mjs";
import * as installVerification from "../onboarding-install-verification-v0.1.mjs";

const APP_ORIGIN = "https://publisher.example.test";
const VERIFY_PATH = "/api/onboarding/verify-install";

test("second verified hostname claim returns exact conflict and preserves both tenants", async t => {
  const f = await verificationFixture(t);
  for (const n of [1, 2]) {
    f.sqlite.prepare(`INSERT INTO publishers
      (publisher_id,slug,display_name,terms_version,terms_accepted_at,terms_accepted_by_user_id,install_public_key)
      VALUES (?,?,?,'chinaflow-publisher-terms-v1',CURRENT_TIMESTAMP,?,?)`)
      .run(`claim-${n}`, `claim-${n}`, `Claim ${n}`, `verify-user-${n}`, `cfi_${String(n).repeat(32)}`);
    f.sqlite.prepare(`INSERT INTO publisher_domains (domain_id,publisher_id,hostname,is_primary)
      VALUES (?,?,'shared.example.test',1)`).run(`claim-domain-${n}`, `claim-${n}`);
    f.sqlite.prepare(`INSERT INTO publisher_memberships (membership_id,publisher_id,user_id,role,membership_status)
      VALUES (?,?,?,'owner','active')`).run(`claim-member-${n}`, `claim-${n}`, `verify-user-${n}`);
  }
  const contexts = [];
  for (const session of [f.session1, f.session2]) {
    const authorization = await installVerification.authorizeInstallVerification(f.db, session.token);
    assert.equal(authorization.status, 200);
    contexts.push(authorization.context);
  }
  const domains = () => f.sqlite.prepare("SELECT * FROM publisher_domains ORDER BY domain_id").all();
  const before = domains();
  assert.deepEqual(before.map(row => row.verification_status), ["unverified", "unverified"]);
  const record = installVerification.recordInstallVerificationResult;
  assert.deepEqual(await record(f.db, contexts[0], { detected: true }), {
    status: 200, body: { verification: {
      detected: true, install_status: "detected", verification_status: "verified"
    } }
  });
  const winner = domains()[0];
  assert.deepEqual(await record(f.db, contexts[1], { detected: true }), {
    status: 409, body: { error: "conflict" }
  });
  assert.deepEqual(domains(), [winner, before[1]]);
  assert.deepEqual(domains().map(row => row.verification_status), ["verified", "unverified"]);
  assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("verified UPDATE recognizes only exact hostname UNIQUE messages and causes", async () => {
  const context = {
    userId: "u", sessionId: "s", publisherId: "p", domainId: "d",
    hostname: "shared.example.test", installPublicKey: `cfi_${"1".repeat(32)}`
  };
  const invoke = (error, detected = true) => installVerification.recordInstallVerificationResult({
    prepare(sql) {
      assert.match(sql, /UPDATE publisher_domains/);
      return { bind() { return { async first() { throw error; } }; } };
    }
  }, context, detected ? { detected: true } : { detected: false, reason: "loader_not_found" });
  const exact = "UNIQUE constraint failed: publisher_domains.hostname";
  for (const suffix of ["", ": SQLITE_CONSTRAINT", ": SQLITE_CONSTRAINT_UNIQUE",
    ": SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)"]) {
    for (const prefix of ["", "D1_ERROR: "]) {
      for (const wrapped of [false, true]) {
        const cause = new Error(prefix + exact + suffix);
        const error = wrapped ? new Error("D1 query failed", { cause }) : cause;
        assert.deepEqual(await invoke(error), { status: 409, body: { error: "conflict" } });
        await assert.rejects(invoke(error, false), actual => actual === error);
      }
    }
  }
  for (const message of [
    "database unavailable", "FOREIGN KEY constraint failed",
    "UNIQUE constraint failed: publisher_domains.domain_id",
    "UNIQUE constraint failed: publisher_domains.publisher_id",
    "UNIQUE constraint failed: publishers.slug", exact + "_other",
    exact + ", publisher_domains.publisher_id", exact + ": SQLITE_CONSTRAINT_PRIMARYKEY",
    exact + ": unrelated error"
  ]) {
    for (const wrapped of [false, true]) {
      const cause = new Error(message);
      const error = wrapped ? new Error("D1 query failed", { cause }) : cause;
      await assert.rejects(invoke(error), actual => actual === error);
    }
  }
});

const built = await build({
  entryPoints: [
    fileURLToPath(new URL("../app-worker-v0.1.mjs", import.meta.url))
  ],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  minify: false,
  loader: { ".md": "text" }
});

const worker = (
  await import(
    `data:text/javascript;base64,${
      Buffer.from(built.outputFiles[0].text).toString("base64")
    }`
  )
).default;

test("verify-install route is POST-only", async () => {
  for (const method of [
    "GET",
    "PUT",
    "PATCH",
    "DELETE"
  ]) {
    const response = await worker.fetch(
      new Request(
        APP_ORIGIN + VERIFY_PATH,
        { method }
      ),
      {
        APP_ORIGIN
      }
    );

    assert.equal(response.status, 405);
    assert.equal(
      response.headers.get("Allow"),
      "POST"
    );
  }
});

test(
  "verify-install rejects missing or foreign Origin before D1",
  async () => {
    const badOrigins = [
      null,
      "null",
      "https://foreign.example.test",
      "http://publisher.example.test",
      "https://publisher.example.test/",
      "https://publisher.example.test.evil.test"
    ];

    for (const origin of badOrigins) {
      let d1Touched = false;

      const env = {
        APP_ORIGIN,
        get CHINAFLOW_EVENTS() {
          d1Touched = true;
          throw new Error(
            "verify-install touched D1 before Origin rejection"
          );
        }
      };

      const headers = {};

      if (origin !== null) {
        headers.Origin = origin;
      }

      const response = await worker.fetch(
        new Request(
          APP_ORIGIN + VERIFY_PATH,
          {
            method: "POST",
            headers
          }
        ),
        env
      );

      assert.equal(
        response.status,
        403,
        `origin=${origin}`
      );

      assert.equal(
        d1Touched,
        false,
        `D1 touched for origin=${origin}`
      );
    }
  }
);


async function verificationFixture(t) {
  const sqlite = new DatabaseSync(":memory:");

  t.after(() => sqlite.close());

  sqlite.exec("PRAGMA foreign_keys = ON");

  const migrations = new URL(
    "../../collector/migrations/",
    import.meta.url
  );

  const files = readdirSync(migrations)
    .filter(name => /^000[1-8]_.*\.sql$/.test(name))
    .sort();

  assert.equal(files.length, 8);

  for (const file of files) {
    sqlite.exec(
      readFileSync(
        new URL(file, migrations),
        "utf8"
      )
    );
  }

  sqlite.exec(`
    INSERT INTO publisher_users (
      user_id,
      email,
      email_normalized
    ) VALUES
      (
        'verify-user-1',
        'verify1@example.test',
        'verify1@example.test'
      ),
      (
        'verify-user-2',
        'verify2@example.test',
        'verify2@example.test'
      );
  `);

  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          const statement = sqlite.prepare(sql);

          return {
            async first() {
              return statement.get(...values) ?? null;
            },

            async all() {
              return {
                results: statement.all(...values)
              };
            },

            async run() {
              return {
                meta: statement.run(...values)
              };
            }
          };
        }
      };
    }
  };

  const session1 =
    await createSession(db, "verify-user-1");

  const session2 =
    await createSession(db, "verify-user-2");

  async function request(token = session1.token) {
    const headers = {
      Origin: APP_ORIGIN
    };

    if (token !== null) {
      headers.Cookie =
        `__Host-chinaflow_session=${token}`;
    }

    return worker.fetch(
      new Request(
        APP_ORIGIN + VERIFY_PATH,
        {
          method: "POST",
          headers
        }
      ),
      {
        APP_ORIGIN,
        CHINAFLOW_RUNTIME_ORIGIN:
          "https://runtime.example.test",
        VERIFY_INSTALL_IP_RATE_LIMITER: {
          async limit() {
            return { success: true };
          }
        },
        VERIFY_INSTALL_SESSION_RATE_LIMITER: {
          async limit() {
            return { success: true };
          }
        },
        CHINAFLOW_EVENTS: db
      }
    );
  }
  return {
    sqlite,
    db,
    session1,
    session2,
    request
  };
}

test("verify-install authorization eligibility matrix", async t => {
  const f = await verificationFixture(t);

  /*
   * 1. No authenticated session.
   */
  assert.equal(
    (await f.request(null)).status,
    401
  );

  /*
   * 2. Authenticated user but no publisher ownership.
   */
  assert.equal(
    (await f.request()).status,
    403
  );

  /*
   * Seed one publisher manually.
   * No website/network access occurs in this test.
   */
  f.sqlite.exec(`
    INSERT INTO publishers (
      publisher_id,
      slug,
      display_name,
      account_status,
      install_public_key
    ) VALUES (
      'verify-publisher',
      'verify-publisher',
      'Verify Publisher',
      'draft',
      'cfi_11111111111111111111111111111111'
    );

    INSERT INTO publisher_domains (
      domain_id,
      publisher_id,
      hostname,
      is_primary
    ) VALUES (
      'verify-domain',
      'verify-publisher',
      'verify.example.test',
      1
    );

    INSERT INTO publisher_memberships (
      membership_id,
      publisher_id,
      user_id,
      role,
      membership_status
    ) VALUES (
      'verify-membership',
      'verify-publisher',
      'verify-user-1',
      'member',
      'active'
    );
  `);

  /*
   * 3. Membership exists, but caller is not owner.
   */
  assert.equal(
    (await f.request()).status,
    403
  );

  f.sqlite.exec(`
    UPDATE publisher_memberships
    SET role = 'owner'
    WHERE membership_id = 'verify-membership';
  `);

  /*
   * 4. Owner + draft, but current Terms are not accepted.
   */
  assert.equal(
    (await f.request()).status,
    409
  );

  f.sqlite.exec(`
    UPDATE publishers
    SET
      terms_version = 'chinaflow-publisher-terms-v1',
      terms_accepted_at = CURRENT_TIMESTAMP,
      terms_accepted_by_user_id = 'verify-user-1'
    WHERE publisher_id = 'verify-publisher';
  `);

  /*
   * 5. This is the only eligible authorization state.
   * Use a synthetic fetch response so this test remains
   * completely isolated from the real network.
   */
  const originalFetch =
    globalThis.fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let eligibleFetchCalls = 0;

  globalThis.fetch =
    async (url, options) => {
      eligibleFetchCalls++;

      assert.equal(
        String(url),
        "https://verify.example.test/"
      );

      assert.equal(
        options?.redirect,
        "manual"
      );

      return new Response(
        '<!doctype html><html><head>' +
        '<script async ' +
        'src="https://runtime.example.test/runtime/loader.js" ' +
        'data-chinaflow-install=' +
        '"cfi_11111111111111111111111111111111">' +
        '</script></head></html>',
        {
          status: 200,
          headers: {
            "Content-Type":
              "text/html; charset=utf-8"
          }
        }
      );
    };

  assert.equal(
    (await f.request()).status,
    200
  );

  assert.equal(
    eligibleFetchCalls,
    1
  );

  f.sqlite.exec(`
    UPDATE publishers
    SET account_status = 'pending_review'
    WHERE publisher_id = 'verify-publisher';
  `);

  /*
   * 6. Already transitioned beyond draft cannot invoke
   * onboarding installation verification.
   */
  assert.equal(
    (await f.request()).status,
    409
  );

  assert.equal(
    eligibleFetchCalls,
    1,
    "ineligible state must fail before network access"
  );

  assert.deepEqual(
    f.sqlite.prepare(
      "PRAGMA foreign_key_check"
    ).all(),
    []
  );
});


test(
  "installation inspector enforces exact loader identity and safe fetch policy",
  async () => {
    const inspect =
      installVerification.inspectPublisherInstallation;

    assert.equal(
      typeof inspect,
      "function",
      "inspectPublisherInstallation must be exported"
    );

    const hostname = "verify.example.test";

    const installPublicKey =
      "cfi_11111111111111111111111111111111";

    const runtimeOrigin =
      "https://runtime.example.test";

    const expectedLoader =
      runtimeOrigin + "/runtime/loader.js";

    function html(body, init = {}) {
      return new Response(
        body,
        {
          status: init.status ?? 200,
          headers: {
            "Content-Type":
              init.contentType ??
              "text/html; charset=utf-8",
            ...(init.headers ?? {})
          }
        }
      );
    }

    /*
     * Exact generated installation snippet succeeds.
     */
    {
      const calls = [];

      const result = await inspect({
        hostname,
        installPublicKey,
        runtimeOrigin,

        fetchFn: async (url, options) => {
          calls.push({
            url: String(url),
            options
          });

          return html(
            '<!doctype html><html><head>' +
            '<script async src="' +
            expectedLoader +
            '" data-chinaflow-install="' +
            installPublicKey +
            '"></script>' +
            '</head><body></body></html>'
          );
        }
      });

      assert.deepEqual(
        result,
        {
          detected: true
        }
      );

      assert.equal(calls.length, 1);

      assert.equal(
        calls[0].url,
        "https://verify.example.test/"
      );

      assert.equal(
        calls[0].options?.method,
        "GET"
      );

      assert.equal(
        calls[0].options?.redirect,
        "manual"
      );
    }

    /*
     * Attribute ordering and single quotes are valid HTML
     * and must not affect exact identity matching.
     */
    {
      const result = await inspect({
        hostname,
        installPublicKey,
        runtimeOrigin,

        fetchFn: async () =>
          html(
            "<html><head>" +
            "<script " +
            "data-chinaflow-install='" +
            installPublicKey +
            "' defer src='" +
            expectedLoader +
            "'></script>" +
            "</head></html>"
          )
      });

      assert.deepEqual(
        result,
        {
          detected: true
        }
      );
    }

    /*
     * Wrong install key is not installation proof.
     */
    {
      const result = await inspect({
        hostname,
        installPublicKey,
        runtimeOrigin,

        fetchFn: async () =>
          html(
            '<script src="' +
            expectedLoader +
            '" data-chinaflow-install="' +
            'cfi_22222222222222222222222222222222' +
            '"></script>'
          )
      });

      assert.deepEqual(
        result,
        {
          detected: false,
          reason: "loader_not_found"
        }
      );
    }

    /*
     * Versioned loader is deliberately not the canonical
     * self-service installation URL.
     */
    {
      const result = await inspect({
        hostname,
        installPublicKey,
        runtimeOrigin,

        fetchFn: async () =>
          html(
            '<script src="' +
            runtimeOrigin +
            '/runtime/loader-v0.3.js" ' +
            'data-chinaflow-install="' +
            installPublicKey +
            '"></script>'
          )
      });

      assert.deepEqual(
        result,
        {
          detected: false,
          reason: "loader_not_found"
        }
      );
    }

    /*
     * Text that merely contains the snippet must not count.
     * Installation proof requires an actual script start tag.
     */
    {
      const result = await inspect({
        hostname,
        installPublicKey,
        runtimeOrigin,

        fetchFn: async () =>
          html(
            "<html><body><pre>" +
            '&lt;script src="' +
            expectedLoader +
            '" data-chinaflow-install="' +
            installPublicKey +
            '"&gt;&lt;/script&gt;' +
            "</pre></body></html>"
          )
      });

      assert.deepEqual(
        result,
        {
          detected: false,
          reason: "loader_not_found"
        }
      );
    }

    /*
     * Only HTML responses are verification evidence.
     */
    {
      const result = await inspect({
        hostname,
        installPublicKey,
        runtimeOrigin,

        fetchFn: async () =>
          new Response(
            "plain text",
            {
              status: 200,
              headers: {
                "Content-Type": "text/plain"
              }
            }
          )
      });

      assert.deepEqual(
        result,
        {
          detected: false,
          reason: "not_html"
        }
      );
    }

    /*
     * Same-origin redirect may be followed manually.
     */
    {
      const calls = [];

      const result = await inspect({
        hostname,
        installPublicKey,
        runtimeOrigin,

        fetchFn: async (url, options) => {
          calls.push({
            url: String(url),
            options
          });

          if (calls.length === 1) {
            return new Response(
              null,
              {
                status: 302,
                headers: {
                  Location: "/home"
                }
              }
            );
          }

          return html(
            '<script src="' +
            expectedLoader +
            '" data-chinaflow-install="' +
            installPublicKey +
            '"></script>'
          );
        }
      });

      assert.deepEqual(
        result,
        {
          detected: true
        }
      );

      assert.deepEqual(
        calls.map(call => call.url),
        [
          "https://verify.example.test/",
          "https://verify.example.test/home"
        ]
      );

      for (const call of calls) {
        assert.equal(
          call.options?.redirect,
          "manual"
        );
      }
    }

    /*
     * Cross-origin redirect must never be followed.
     */
    {
      let calls = 0;

      const result = await inspect({
        hostname,
        installPublicKey,
        runtimeOrigin,

        fetchFn: async () => {
          calls++;

          return new Response(
            null,
            {
              status: 302,
              headers: {
                Location:
                  "https://foreign.example.test/"
              }
            }
          );
        }
      });

      assert.equal(calls, 1);

      assert.deepEqual(
        result,
        {
          detected: false,
          reason: "unsafe_redirect"
        }
      );
    }

    /*
     * Non-success response is not proof.
     */
    {
      const result = await inspect({
        hostname,
        installPublicKey,
        runtimeOrigin,

        fetchFn: async () =>
          html(
            "not found",
            {
              status: 404
            }
          )
      });

      assert.deepEqual(
        result,
        {
          detected: false,
          reason: "http_status"
        }
      );
    }

    /*
     * Network failure is handled as a verification
     * failure, not an uncaught application exception.
     */
    {
      const result = await inspect({
        hostname,
        installPublicKey,
        runtimeOrigin,

        fetchFn: async () => {
          throw new Error("synthetic network failure");
        }
      });

      assert.deepEqual(
        result,
        {
          detected: false,
          reason: "fetch_failed"
        }
      );
    }
  }
);


test(
  "verification result persistence is fail-closed and race-safe",
  async t => {
    const record =
      installVerification.recordInstallVerificationResult;

    assert.equal(
      typeof record,
      "function",
      "recordInstallVerificationResult must be exported"
    );

    const f = await verificationFixture(t);

    /*
     * Two isolated eligible publishers:
     * user1 -> success path
     * user2 -> not-detected + stale-context path
     */
    f.sqlite.exec(`
      INSERT INTO publishers (
        publisher_id,
        slug,
        display_name,
        account_status,
        terms_version,
        terms_accepted_at,
        terms_accepted_by_user_id,
        install_public_key
      ) VALUES
        (
          'persist-publisher-1',
          'persist-publisher-1',
          'Persist Publisher 1',
          'draft',
          'chinaflow-publisher-terms-v1',
          CURRENT_TIMESTAMP,
          'verify-user-1',
          'cfi_11111111111111111111111111111111'
        ),
        (
          'persist-publisher-2',
          'persist-publisher-2',
          'Persist Publisher 2',
          'draft',
          'chinaflow-publisher-terms-v1',
          CURRENT_TIMESTAMP,
          'verify-user-2',
          'cfi_22222222222222222222222222222222'
        );

      INSERT INTO publisher_domains (
        domain_id,
        publisher_id,
        hostname,
        is_primary
      ) VALUES
        (
          'persist-domain-1',
          'persist-publisher-1',
          'persist1.example.test',
          1
        ),
        (
          'persist-domain-2',
          'persist-publisher-2',
          'persist2.example.test',
          1
        );

      INSERT INTO publisher_memberships (
        membership_id,
        publisher_id,
        user_id,
        role,
        membership_status
      ) VALUES
        (
          'persist-membership-1',
          'persist-publisher-1',
          'verify-user-1',
          'owner',
          'active'
        ),
        (
          'persist-membership-2',
          'persist-publisher-2',
          'verify-user-2',
          'owner',
          'active'
        );
    `);

    const auth1 =
      await installVerification
        .authorizeInstallVerification(
          f.db,
          f.session1.token
        );

    const auth2 =
      await installVerification
        .authorizeInstallVerification(
          f.db,
          f.session2.token
        );

    assert.equal(auth1.status, 200);
    assert.equal(auth2.status, 200);

    /*
     * SUCCESS:
     * exact verified installation advances both states
     * and writes successful observation timestamps.
     */
    const success =
      await record(
        f.db,
        auth1.context,
        {
          detected: true
        }
      );

    assert.deepEqual(
      success,
      {
        status: 200,
        body: {
          verification: {
            detected: true,
            install_status: "detected",
            verification_status: "verified"
          }
        }
      }
    );

    const successRow =
      f.sqlite.prepare(`
        SELECT
          install_status,
          verification_status,
          first_seen_at,
          last_seen_at,
          verified_at
        FROM publisher_domains
        WHERE domain_id = 'persist-domain-1'
      `).get();

    assert.equal(
      successRow.install_status,
      "detected"
    );

    assert.equal(
      successRow.verification_status,
      "verified"
    );

    assert.ok(successRow.first_seen_at);
    assert.ok(successRow.last_seen_at);
    assert.ok(successRow.verified_at);

    assert.equal(
      successRow.first_seen_at,
      successRow.last_seen_at
    );

    assert.equal(
      successRow.first_seen_at,
      successRow.verified_at
    );

    /*
     * A repeated successful verification is idempotent
     * for first_seen_at and remains verified.
     */
    const firstSeen =
      successRow.first_seen_at;

    const successAgain =
      await record(
        f.db,
        auth1.context,
        {
          detected: true
        }
      );

    assert.equal(
      successAgain.status,
      200
    );

    const successAgainRow =
      f.sqlite.prepare(`
        SELECT
          install_status,
          verification_status,
          first_seen_at,
          last_seen_at,
          verified_at
        FROM publisher_domains
        WHERE domain_id = 'persist-domain-1'
      `).get();

    assert.equal(
      successAgainRow.install_status,
      "detected"
    );

    assert.equal(
      successAgainRow.verification_status,
      "verified"
    );

    assert.equal(
      successAgainRow.first_seen_at,
      firstSeen
    );

    /*
     * NOT DETECTED:
     * this is a retryable installation state.
     * It must not mark the domain verified or create
     * successful-observation timestamps.
     */
    const missing =
      await record(
        f.db,
        auth2.context,
        {
          detected: false,
          reason: "loader_not_found"
        }
      );

    assert.deepEqual(
      missing,
      {
        status: 200,
        body: {
          verification: {
            detected: false,
            reason: "loader_not_found",
            install_status: "not_detected",
            verification_status: "unverified"
          }
        }
      }
    );

    const missingRow =
      f.sqlite.prepare(`
        SELECT
          install_status,
          verification_status,
          first_seen_at,
          last_seen_at,
          verified_at
        FROM publisher_domains
        WHERE domain_id = 'persist-domain-2'
      `).get();

    assert.equal(
      missingRow.install_status,
      "not_detected"
    );

    assert.equal(
      missingRow.verification_status,
      "unverified"
    );

    assert.equal(
      missingRow.first_seen_at,
      null
    );

    assert.equal(
      missingRow.last_seen_at,
      null
    );

    assert.equal(
      missingRow.verified_at,
      null
    );

    /*
     * TOCTOU:
     * authorization context is only a snapshot.
     * If eligibility changes before persistence, the
     * write boundary must re-check and fail closed.
     */
    f.sqlite.exec(`
      UPDATE publishers
      SET account_status = 'pending_review'
      WHERE publisher_id = 'persist-publisher-2';
    `);

    const stale =
      await record(
        f.db,
        auth2.context,
        {
          detected: true
        }
      );

    assert.deepEqual(
      stale,
      {
        status: 409,
        body: {
          error: "conflict"
        }
      }
    );

    const staleRow =
      f.sqlite.prepare(`
        SELECT
          install_status,
          verification_status,
          first_seen_at,
          last_seen_at,
          verified_at
        FROM publisher_domains
        WHERE domain_id = 'persist-domain-2'
      `).get();

    assert.equal(
      staleRow.install_status,
      "not_detected"
    );

    assert.equal(
      staleRow.verification_status,
      "unverified"
    );

    assert.equal(
      staleRow.first_seen_at,
      null
    );

    assert.equal(
      staleRow.last_seen_at,
      null
    );

    assert.equal(
      staleRow.verified_at,
      null
    );

    assert.deepEqual(
      f.sqlite.prepare(
        "PRAGMA foreign_key_check"
      ).all(),
      []
    );
  }
);


test(
  "installation verification service orchestrates authorize inspect persist",
  async t => {
    const verify =
      installVerification.verifyPublisherInstallation;

    assert.equal(
      typeof verify,
      "function",
      "verifyPublisherInstallation must be exported"
    );

    const f = await verificationFixture(t);

    f.sqlite.exec(`
      INSERT INTO publishers (
        publisher_id,
        slug,
        display_name,
        account_status,
        terms_version,
        terms_accepted_at,
        terms_accepted_by_user_id,
        install_public_key
      ) VALUES (
        'service-publisher',
        'service-publisher',
        'Service Publisher',
        'draft',
        'chinaflow-publisher-terms-v1',
        CURRENT_TIMESTAMP,
        'verify-user-1',
        'cfi_33333333333333333333333333333333'
      );

      INSERT INTO publisher_domains (
        domain_id,
        publisher_id,
        hostname,
        is_primary
      ) VALUES (
        'service-domain',
        'service-publisher',
        'service.example.test',
        1
      );

      INSERT INTO publisher_memberships (
        membership_id,
        publisher_id,
        user_id,
        role,
        membership_status
      ) VALUES (
        'service-membership',
        'service-publisher',
        'verify-user-1',
        'owner',
        'active'
      );
    `);

    const runtimeOrigin =
      "https://runtime.example.test";

    const key =
      "cfi_33333333333333333333333333333333";

    let fetchCalls = 0;

    const success =
      await verify({
        database: f.db,
        token: f.session1.token,
        runtimeOrigin,

        fetchFn: async (url, options) => {
          fetchCalls++;

          assert.equal(
            String(url),
            "https://service.example.test/"
          );

          assert.equal(
            options?.redirect,
            "manual"
          );

          return new Response(
            '<!doctype html><html><head>' +
            '<script async src="' +
            runtimeOrigin +
            '/runtime/loader.js" ' +
            'data-chinaflow-install="' +
            key +
            '"></script>' +
            '</head></html>',
            {
              status: 200,
              headers: {
                "Content-Type":
                  "text/html; charset=utf-8"
              }
            }
          );
        }
      });

    assert.equal(fetchCalls, 1);

    assert.deepEqual(
      success,
      {
        status: 200,
        body: {
          verification: {
            detected: true,
            install_status: "detected",
            verification_status: "verified"
          }
        }
      }
    );

    const row =
      f.sqlite.prepare(`
        SELECT
          install_status,
          verification_status,
          first_seen_at,
          last_seen_at,
          verified_at
        FROM publisher_domains
        WHERE domain_id = 'service-domain'
      `).get();

    assert.equal(row.install_status, "detected");
    assert.equal(
      row.verification_status,
      "verified"
    );

    assert.ok(row.first_seen_at);
    assert.ok(row.last_seen_at);
    assert.ok(row.verified_at);

    /*
     * Unauthorized caller must fail before any
     * outbound network operation.
     */
    let unauthorizedFetches = 0;

    const unauthorized =
      await verify({
        database: f.db,
        token: f.session2.token,
        runtimeOrigin,

        fetchFn: async () => {
          unauthorizedFetches++;
          throw new Error(
            "unauthorized request reached network"
          );
        }
      });

    assert.equal(
      unauthorizedFetches,
      0
    );

    assert.deepEqual(
      unauthorized,
      {
        status: 403,
        body: {
          error: "forbidden"
        }
      }
    );

    assert.deepEqual(
      f.sqlite.prepare(
        "PRAGMA foreign_key_check"
      ).all(),
      []
    );
  }
);


test(
  "verify-install route executes verification service end to end",
  async t => {
    const f = await verificationFixture(t);

    const runtimeOrigin =
      "https://runtime.example.test";

    const key =
      "cfi_44444444444444444444444444444444";

    f.sqlite.exec(`
      INSERT INTO publishers (
        publisher_id,
        slug,
        display_name,
        account_status,
        terms_version,
        terms_accepted_at,
        terms_accepted_by_user_id,
        install_public_key
      ) VALUES (
        'route-publisher',
        'route-publisher',
        'Route Publisher',
        'draft',
        'chinaflow-publisher-terms-v1',
        CURRENT_TIMESTAMP,
        'verify-user-1',
        '${key}'
      );

      INSERT INTO publisher_domains (
        domain_id,
        publisher_id,
        hostname,
        is_primary
      ) VALUES (
        'route-domain',
        'route-publisher',
        'route.example.test',
        1
      );

      INSERT INTO publisher_memberships (
        membership_id,
        publisher_id,
        user_id,
        role,
        membership_status
      ) VALUES (
        'route-membership',
        'route-publisher',
        'verify-user-1',
        'owner',
        'active'
      );
    `);

    const originalFetch =
      globalThis.fetch;

    t.after(() => {
      globalThis.fetch = originalFetch;
    });

    let outboundCalls = 0;

    globalThis.fetch =
      async (url, options) => {
        outboundCalls++;

        assert.equal(
          String(url),
          "https://route.example.test/"
        );

        assert.equal(
          options?.method,
          "GET"
        );

        assert.equal(
          options?.redirect,
          "manual"
        );

        return new Response(
          '<!doctype html><html><head>' +
          '<script async src="' +
          runtimeOrigin +
          '/runtime/loader.js" ' +
          'data-chinaflow-install="' +
          key +
          '"></script>' +
          '</head></html>',
          {
            status: 200,
            headers: {
              "Content-Type":
                "text/html; charset=utf-8"
            }
          }
        );
      };

    const response =
      await worker.fetch(
        new Request(
          APP_ORIGIN + VERIFY_PATH,
          {
            method: "POST",
            headers: {
              Origin: APP_ORIGIN,
              Cookie:
                "__Host-chinaflow_session=" +
                f.session1.token
            }
          }
        ),
        {
          APP_ORIGIN,
          CHINAFLOW_RUNTIME_ORIGIN:
            runtimeOrigin,
          VERIFY_INSTALL_IP_RATE_LIMITER: {
            async limit() {
              return { success: true };
            }
          },
          VERIFY_INSTALL_SESSION_RATE_LIMITER: {
            async limit() {
              return { success: true };
            }
          },
          CHINAFLOW_EVENTS:
            f.db
        }
      );

    assert.equal(
      response.status,
      200
    );

    assert.equal(
      outboundCalls,
      1
    );

    assert.deepEqual(
      await response.json(),
      {
        verification: {
          detected: true,
          install_status: "detected",
          verification_status: "verified"
        }
      }
    );

    const row =
      f.sqlite.prepare(`
        SELECT
          install_status,
          verification_status,
          first_seen_at,
          last_seen_at,
          verified_at
        FROM publisher_domains
        WHERE domain_id = 'route-domain'
      `).get();

    assert.equal(
      row.install_status,
      "detected"
    );

    assert.equal(
      row.verification_status,
      "verified"
    );

    assert.ok(row.first_seen_at);
    assert.ok(row.last_seen_at);
    assert.ok(row.verified_at);

    assert.deepEqual(
      f.sqlite.prepare(
        "PRAGMA foreign_key_check"
      ).all(),
      []
    );
  }
);
