import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

test("unverified drafts may share hostname but only one verified claim may exist", () => {
  const sqlite = new DatabaseSync(":memory:");

  try {
    sqlite.exec("PRAGMA foreign_keys = ON");

    const dir = new URL("../../collector/migrations/", import.meta.url);
    const files = readdirSync(dir)
      .filter(name => /^000[1-8]_.*\.sql$/.test(name))
      .sort();

    assert.equal(files.length, 8);
    assert.ok(files.includes("0008_verified_hostname_claim_v1.sql"));

    for (const file of files) {
      sqlite.exec(readFileSync(new URL(file, dir), "utf8"));
    }

    sqlite.exec(`
      INSERT INTO publishers (publisher_id,slug,display_name)
      VALUES ('p1','p1','Publisher 1'),('p2','p2','Publisher 2');

      INSERT INTO publisher_domains (
        domain_id,publisher_id,hostname,is_primary
      ) VALUES
        ('d1','p1','shared.example.com',1),
        ('d2','p2','shared.example.com',1);
    `);

    const rowsBefore = sqlite.prepare(`
      SELECT domain_id,verification_status
      FROM publisher_domains
      ORDER BY domain_id
    `).all().map(row => ({ ...row }));

    assert.deepEqual(rowsBefore, [
      { domain_id: "d1", verification_status: "unverified" },
      { domain_id: "d2", verification_status: "unverified" }
    ]);

    sqlite.prepare(`
      UPDATE publisher_domains
      SET verification_status='verified'
      WHERE domain_id='d1'
    `).run();

    assert.throws(
      () => sqlite.prepare(`
        UPDATE publisher_domains
        SET verification_status='verified'
        WHERE domain_id='d2'
      `).run(),
      /UNIQUE constraint failed: publisher_domains\.hostname/
    );

    const index = sqlite.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE type='index'
        AND name='ux_publisher_domains_hostname'
    `).get();

    assert.match(
      index.sql,
      /WHERE\s+verification_status\s*=\s*'verified'/i
    );

    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    sqlite.close();
  }
});
