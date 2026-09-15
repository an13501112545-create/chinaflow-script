import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const dir = new URL('collector/migrations/', root);
const migration = '0007_publisher_install_identity_v1.sql';
const historical = readdirSync(dir).filter(name => /^000[1-6]_.*\.sql$/.test(name)).sort();
const read = name => readFileSync(new URL(name, dir), 'utf8');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.equal(historical.length, 6);
  for (const file of historical) db.exec(read(file));
  return db;
}

function snapshot(db) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => ({ ...row }))]));
}

test('historical migrations match expected HEAD byte-for-byte and still apply', t => {
  for (const file of historical) {
    const original = execFileSync('git', ['show', `6f9eb360461b63e19fd6be7360201a1dc75d44fa:collector/migrations/${file}`], { cwd: root, encoding: 'utf8' });
    assert.ok(read(file) === original, 'historical migration unchanged');
  }
  const db = fixture(t);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('0007 adds only nullable TEXT and binary unique index, preserving all existing state', t => {
  const db = fixture(t);
  // Entirely synthetic, in-memory fixture; no deployed data or credentials.
  db.exec(`INSERT INTO publishers(publisher_id,slug,display_name,account_status,terms_version,terms_accepted_at)
    VALUES ('fixture-a','fixture-a','Fixture A','active','prior','2020-01-01'),
           ('fixture-b','fixture-b','Fixture B','draft',NULL,NULL);
    INSERT INTO publisher_domains(domain_id,publisher_id,hostname,is_primary,install_status,verification_status,review_status,monetization_status)
    VALUES ('fixture-domain','fixture-a','fixture.invalid',1,'detected','verified','approved','enabled');
    INSERT INTO publisher_placements(placement_id,publisher_id,placement,supplier,external_tracking_key)
    VALUES ('fixture-placement','fixture-a','fixture','fixture','fixture');
    INSERT INTO publisher_supplier_sites(supplier_site_id,publisher_id,domain_id,supplier,provisioning_status)
    VALUES ('fixture-site','fixture-a','fixture-domain','fixture','active');
    INSERT INTO publisher_supplier_offers(supplier_offer_id,supplier_site_id,publisher_id,domain_id,offer_key,product,placement_id,affiliate_url)
    VALUES ('fixture-offer','fixture-site','fixture-a','fixture-domain','fixture','hotel','fixture-placement','https://fixture.invalid/');`);
  const before = snapshot(db);
  const schemaBefore = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all();
  const columnsBefore = db.prepare('PRAGMA table_info(publishers)').all();
  assert.equal(read(migration).trim(), `ALTER TABLE publishers
    ADD COLUMN install_public_key TEXT;

CREATE UNIQUE INDEX ux_publishers_install_public_key
    ON publishers (install_public_key COLLATE BINARY);`);
  db.exec(read(migration));
  const columns = db.prepare('PRAGMA table_info(publishers)').all();
  assert.deepEqual(columns.slice(0, -1), columnsBefore);
  assert.deepEqual({ ...columns.at(-1) }, { cid: columnsBefore.length, name: 'install_public_key', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 });
  const after = snapshot(db);
  assert.deepEqual(after.publishers, before.publishers.map(row => ({ ...row, install_public_key: null })));
  delete after.publishers;
  delete before.publishers;
  assert.deepEqual(after, before);
  const schemaAfter = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all();
  assert.deepEqual(schemaAfter.filter(row => row.name !== 'publishers' && row.name !== 'ux_publishers_install_public_key'),
    schemaBefore.filter(row => row.name !== 'publishers'));
  const index = db.prepare('PRAGMA index_list(publishers)').all().find(row => row.name === 'ux_publishers_install_public_key');
  assert.equal(index.unique, 1);
  assert.equal(index.partial, 0);
  const indexed = db.prepare('PRAGMA index_xinfo(ux_publishers_install_public_key)').all().filter(row => row.key === 1);
  assert.equal(indexed.length, 1);
  assert.equal(indexed[0].name, 'install_public_key');
  assert.equal(indexed[0].coll, 'BINARY');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('0001–0007 allow multiple NULLs and distinct keys but reject duplicate non-null keys', t => {
  const db = fixture(t);
  db.exec(read(migration));
  const insert = db.prepare('INSERT INTO publishers(publisher_id,slug,display_name,install_public_key) VALUES (?,?,?,?)');
  for (let i = 0; i < 3; i++) insert.run(`fixture-${i}`, `fixture-${i}`, 'Fixture', null);
  const first = `cfi_${'0'.repeat(32)}`;
  const second = `cfi_${'f'.repeat(32)}`;
  insert.run('fixture-key-a', 'fixture-key-a', 'Fixture', first);
  insert.run('fixture-key-b', 'fixture-key-b', 'Fixture', second);
  assert.throws(() => insert.run('fixture-duplicate', 'fixture-duplicate', 'Fixture', first), /UNIQUE constraint failed: publishers.install_public_key/);
  assert.throws(() => db.prepare('UPDATE publishers SET install_public_key=? WHERE install_public_key=?').run(first, second), /UNIQUE constraint failed/);
  assert.equal(db.prepare('SELECT count(*) n FROM publishers WHERE install_public_key IS NULL').get().n, 3);
  assert.equal(db.prepare('SELECT count(*) n FROM publishers').get().n, 5);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
