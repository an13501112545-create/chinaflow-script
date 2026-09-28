import assert from "node:assert/strict";
import test from "node:test";
import { buildPublisherOperatorWorkQueue as build } from "../publisher-operator-work-queue-v0.1.mjs";

test("queue includes only ChinaFlow-owned actions", () => {
  const q = build([
    { publisher_id:"p1", next_action_owner:"PUBLISHER", next_action:"ACCEPT_TERMS" },
    { publisher_id:"p2", display_name:"B", hostname:"b.test", current_stage:"AWAITING_REVIEW", next_action_owner:"CHINAFLOW", next_action:"REVIEW_PUBLISHER", created_at:"2026-01-02" },
    { publisher_id:"p3", next_action_owner:"NONE", next_action:"NONE" }
  ]);
  assert.equal(q.length, 1);
  assert.equal(q[0].publisher_id, "p2");
  assert.equal(q[0].next_action, "REVIEW_PUBLISHER");
});

test("queue is deterministic and operationally prioritized", () => {
  const q = build([
    { publisher_id:"activation", next_action_owner:"CHINAFLOW", next_action:"ACTIVATE_COMMERCIAL", created_at:"2026-01-01" },
    { publisher_id:"review-new", next_action_owner:"CHINAFLOW", next_action:"REVIEW_PUBLISHER", created_at:"2026-01-03" },
    { publisher_id:"failed", next_action_owner:"CHINAFLOW", next_action:"RETRY_SUPPLIER_PROVISIONING", blocker:"SUPPLIER_PROVISIONING_FAILED", created_at:"2026-01-04" },
    { publisher_id:"review-old", next_action_owner:"CHINAFLOW", next_action:"REVIEW_PUBLISHER", created_at:"2026-01-02" }
  ]);
  assert.deepEqual(q.map(x => x.publisher_id), ["failed", "review-old", "review-new", "activation"]);
  assert.equal(q[0].blocker, "SUPPLIER_PROVISIONING_FAILED");
});

test("unknown ChinaFlow action remains visible rather than dropped", () => {
  const q = build([{ publisher_id:"future", next_action_owner:"CHINAFLOW", next_action:"FUTURE_ACTION" }]);
  assert.equal(q.length, 1);
  assert.equal(q[0].priority, 999);
});

test("invalid input fails closed", () => {
  assert.throws(() => build(null), /snapshots must be an array/);
});
