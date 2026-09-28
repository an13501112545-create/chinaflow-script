import assert from "node:assert/strict";
import test from "node:test";
import { derivePublisherLifecycleAction as derive } from "../publisher-lifecycle-action-v0.1.mjs";

const base = {
  account_status: "draft", terms_status: "pending",
  install_status: "pending", verification_status: "unverified",
  review_status: "pending", monetization_status: "disabled",
  provisioning_status: "not_started", commercial_terms_status: "missing"
};
const withState = overrides => ({ ...base, ...overrides });
const expectAction = (overrides, stage, owner, action, blocker = null) => {
  assert.deepEqual(derive(withState(overrides)), {
    current_stage: stage, next_action_owner: owner,
    next_action: action, blocker
  });
};

test("normal lifecycle actions", () => {
  expectAction({}, "AWAITING_TERMS", "PUBLISHER", "ACCEPT_TERMS");
  expectAction({ terms_status:"accepted" }, "AWAITING_INSTALL", "PUBLISHER", "INSTALL_CHINAFLOW");
  expectAction({ terms_status:"accepted", install_status:"detected" }, "AWAITING_VERIFICATION", "PUBLISHER", "VERIFY_INSTALL");
  expectAction({ terms_status:"accepted", install_status:"detected", verification_status:"verified" }, "AWAITING_SUBMISSION", "PUBLISHER", "SUBMIT_FOR_REVIEW");
  expectAction({ terms_status:"accepted", install_status:"detected", verification_status:"verified", account_status:"pending_review" }, "AWAITING_REVIEW", "CHINAFLOW", "REVIEW_PUBLISHER");
  expectAction({ terms_status:"accepted", install_status:"detected", verification_status:"verified", account_status:"pending_review", review_status:"approved" }, "AWAITING_SUPPLIER_PROVISIONING", "CHINAFLOW", "PROVISION_TRIP_COM");
  expectAction({ terms_status:"accepted", install_status:"detected", verification_status:"verified", account_status:"pending_review", review_status:"approved", provisioning_status:"active" }, "AWAITING_COMMERCIAL_ACTIVATION", "CHINAFLOW", "ACTIVATE_COMMERCIAL");
  expectAction({ terms_status:"accepted", install_status:"detected", verification_status:"verified", account_status:"active", review_status:"approved", provisioning_status:"active", monetization_status:"enabled", commercial_terms_status:"active" }, "ACTIVE", "NONE", "NONE");
});

test("failure and terminal actions", () => {
  expectAction({ account_status:"rejected" }, "REJECTED", "NONE", "NONE", "PUBLISHER_REJECTED");
  expectAction({ account_status:"suspended" }, "SUSPENDED", "CHINAFLOW", "INVESTIGATE_SUSPENSION", "PUBLISHER_SUSPENDED");
  expectAction({ account_status:"closed" }, "CLOSED", "NONE", "NONE", "PUBLISHER_CLOSED");
  expectAction({ terms_status:"accepted", install_status:"detected", verification_status:"failed" }, "VERIFICATION_FAILED", "PUBLISHER", "FIX_AND_REVERIFY_INSTALL", "DOMAIN_VERIFICATION_FAILED");
  expectAction({ terms_status:"accepted", install_status:"detected", verification_status:"verified", review_status:"rejected" }, "REJECTED", "NONE", "NONE", "DOMAIN_REVIEW_REJECTED");
  expectAction({ terms_status:"accepted", install_status:"detected", verification_status:"verified", review_status:"approved", provisioning_status:"failed" }, "PROVISIONING_FAILED", "CHINAFLOW", "RETRY_SUPPLIER_PROVISIONING", "SUPPLIER_PROVISIONING_FAILED");
});

test("invalid state fails closed", () => {
  assert.throws(() => derive(null), /state must be an object/);
  assert.throws(() => derive([]), /state must be an object/);
});
