import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readPersistentHalt, writePersistentHalt } from "../halt-guard-v1.mjs";

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chinaflow-halt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "halt.json");
}

test("missing halt lock permits startup", t => {
  const p=temp(t); const r=readPersistentHalt(p); assert.equal(r.present,false);
});

test("halt lock writes once with mode 0600 and reads metadata", t => {
  const p=temp(t); const w=writePersistentHalt({prospectId:"102",reason:"SEND_AMBIGUOUS",createdAt:"2026-10-01T14:04:13.000Z"},p);
  assert.equal(w.written,true); assert.equal(fs.statSync(p).mode & 0o777,0o600);
  const r=readPersistentHalt(p); assert.deepEqual({present:r.present,malformed:r.malformed,prospectId:r.prospectId,reason:r.reason,createdAt:r.createdAt},{present:true,malformed:false,prospectId:"102",reason:"SEND_AMBIGUOUS",createdAt:"2026-10-01T14:04:13.000Z"});
});

test("existing halt lock is never overwritten", t => {
  const p=temp(t); writePersistentHalt({prospectId:"1",reason:"FIRST"},p); const before=fs.readFileSync(p,"utf8");
  const r=writePersistentHalt({prospectId:"2",reason:"SECOND"},p); assert.equal(r.written,false); assert.equal(r.reason,"HALT_LOCK_ALREADY_EXISTS"); assert.equal(fs.readFileSync(p,"utf8"),before);
});

test("malformed halt lock fails closed", t => {
  const p=temp(t); fs.writeFileSync(p,"not-json",{mode:0o600}); const r=readPersistentHalt(p); assert.equal(r.present,true); assert.equal(r.malformed,true); assert.equal(r.reason,"HALT_LOCK_MALFORMED");
});
