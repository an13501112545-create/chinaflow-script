const result = (currentStage, nextActionOwner, nextAction, blocker = null) => ({
  current_stage: currentStage,
  next_action_owner: nextActionOwner,
  next_action: nextAction,
  blocker
});

export function derivePublisherLifecycleAction(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new TypeError("state must be an object");
  }

  if (state.account_status === "rejected") {
    return result("REJECTED", "NONE", "NONE", "PUBLISHER_REJECTED");
  }
  if (state.account_status === "suspended") {
    return result("SUSPENDED", "CHINAFLOW", "INVESTIGATE_SUSPENSION", "PUBLISHER_SUSPENDED");
  }
  if (state.account_status === "closed") {
    return result("CLOSED", "NONE", "NONE", "PUBLISHER_CLOSED");
  }

  if (state.terms_status !== "accepted") {
    return result("AWAITING_TERMS", "PUBLISHER", "ACCEPT_TERMS");
  }
  if (state.install_status !== "detected") {
    return result("AWAITING_INSTALL", "PUBLISHER", "INSTALL_CHINAFLOW");
  }
  if (state.verification_status === "failed") {
    return result("VERIFICATION_FAILED", "PUBLISHER", "FIX_AND_REVERIFY_INSTALL", "DOMAIN_VERIFICATION_FAILED");
  }
  if (state.verification_status !== "verified") {
    return result("AWAITING_VERIFICATION", "PUBLISHER", "VERIFY_INSTALL");
  }

  if (state.review_status === "rejected") {
    return result("REJECTED", "NONE", "NONE", "DOMAIN_REVIEW_REJECTED");
  }
  if (state.review_status !== "approved") {
    if (state.account_status === "pending_review") {
      return result("AWAITING_REVIEW", "CHINAFLOW", "REVIEW_PUBLISHER");
    }
    return result("AWAITING_SUBMISSION", "PUBLISHER", "SUBMIT_FOR_REVIEW");
  }

  if (state.provisioning_status === "failed") {
    return result("PROVISIONING_FAILED", "CHINAFLOW", "RETRY_SUPPLIER_PROVISIONING", "SUPPLIER_PROVISIONING_FAILED");
  }
  if (state.provisioning_status !== "active") {
    return result("AWAITING_SUPPLIER_PROVISIONING", "CHINAFLOW", "PROVISION_TRIP_COM");
  }

  if (state.monetization_status !== "enabled" ||
      state.account_status !== "active" ||
      state.commercial_terms_status !== "active") {
    return result("AWAITING_COMMERCIAL_ACTIVATION", "CHINAFLOW", "ACTIVATE_COMMERCIAL");
  }

  return result("ACTIVE", "NONE", "NONE");
}
