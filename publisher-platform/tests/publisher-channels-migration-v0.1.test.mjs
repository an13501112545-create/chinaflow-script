import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

function dbWithMigrations(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../../collector/migrations/", import.meta.url);
  const files = readdirSync(dir)
    .filter(name => /^(?:000[1-9]|001[0-5])_.*\.sql$/.test(name))
    .sort();
  assert.equal(files.length, 15);
  for (const file of files) db.exec(readFileSync(new URL(file, dir), "utf8"));
  t.after(() => db.close());
  return db;
}

test("0015 preserves existing placements as content and supports agent booking", t => {
  const db = dbWithMigrations(t);

  db.exec(`
    INSERT INTO publishers(publisher_id,slug,display_name,account_status)
    VALUES ('p1','publisher-one','Publisher One','active');

    INSERT INTO publisher_placements(
      placement_id,publisher_id,placement,supplier,external_tracking_key,is_active
    ) VALUES (
      'pl_content','p1','hotel_content','trip.com','hotel_content',1
    );
  `);

  assert.deepEqual(
    { ...db.prepare(
      "SELECT placement,channel,is_active FROM publisher_placements WHERE placement_id='pl_content'"
    ).get() },
    { placement: "hotel_content", channel: "content", is_active: 1 }
  );

  db.exec(`
    INSERT INTO publisher_channel_capabilities(
      capability_id,publisher_id,channel,capability_status,enabled_at
    ) VALUES (
      'cap_agent','p1','agent_booking','enabled','2026-09-24T12:00:00Z'
    );

    INSERT INTO publisher_placements(
      placement_id,publisher_id,placement,supplier,external_tracking_key,
      is_active,channel
    ) VALUES (
      'pl_agent','p1','agent_booking_p1','trip.com','agent_booking_p1',
      1,'agent_booking'
    );
  `);

  assert.deepEqual(
    { ...db.prepare(`
      SELECT c.capability_status,p.channel,p.placement
      FROM publisher_channel_capabilities c
      JOIN publisher_placements p ON p.publisher_id=c.publisher_id
      WHERE c.publisher_id='p1'
        AND c.channel='agent_booking'
        AND p.channel='agent_booking'
    `).get() },
    {
      capability_status: "enabled",
      channel: "agent_booking",
      placement: "agent_booking_p1"
    }
  );
});

test("0015 channel capability and placement constraints fail closed", t => {
  const db = dbWithMigrations(t);
  db.exec(`
    INSERT INTO publishers(publisher_id,slug,display_name)
    VALUES ('p1','publisher-one','Publisher One');
  `);

  assert.throws(
    () => db.exec(`
      INSERT INTO publisher_channel_capabilities(
        capability_id,publisher_id,channel,capability_status
      ) VALUES ('bad','p1','unknown','enabled')
    `),
    /CHECK constraint failed/
  );

  db.exec(`
    INSERT INTO publisher_channel_capabilities(
      capability_id,publisher_id,channel,capability_status
    ) VALUES ('one','p1','agent_booking','enabled')
  `);

  assert.throws(
    () => db.exec(`
      INSERT INTO publisher_channel_capabilities(
        capability_id,publisher_id,channel,capability_status
      ) VALUES ('two','p1','agent_booking','disabled')
    `),
    /UNIQUE constraint failed/
  );

  assert.throws(
    () => db.exec(`
      INSERT INTO publisher_placements(
        placement_id,publisher_id,placement,supplier,external_tracking_key,channel
      ) VALUES ('badpl','p1','bad_channel','trip.com','bad_channel','unknown')
    `),
    /CHECK constraint failed/
  );
});
