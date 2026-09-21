import { TERMS_VERSION } from "./onboarding-terms-v0.1.mjs";
import { isValidInstallPublicKey } from "./install-public-key-v0.1.mjs";

const failure = (status, error) => ({ status, body: { error } });

export function validateReviewInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 2 ||
      !Object.hasOwn(input, "publisher_id") ||
      !Object.hasOwn(input, "decision")) return null;
  if (typeof input.publisher_id !== "string" ||
      input.publisher_id.length < 1 ||
      input.publisher_id.length > 256 ||
      /[\x00-\x1f\x7f]/u.test(input.publisher_id)) return null;
  if (input.decision !== "approve" && input.decision !== "reject") return null;
  return {
    publisherId: input.publisher_id,
    decision: input.decision
  };
}

async function readState(database, publisherId) {
  return database.prepare(`
    SELECT
      p.publisher_id,
      p.account_status,
      p.terms_version,
      p.terms_accepted_at,
      p.terms_accepted_by_user_id,
      p.install_public_key,
      d.domain_id,
      d.install_status,
      d.verification_status,
      d.review_status,
      d.monetization_status,
      d.first_seen_at,
      d.last_seen_at,
      d.verified_at,
      d.reviewed_at,
      (SELECT count(*)
       FROM publisher_domains px
       WHERE px.publisher_id = p.publisher_id
         AND px.is_primary = 1) AS primary_count
    FROM publishers p
    LEFT JOIN publisher_domains d
      ON d.publisher_id = p.publisher_id
     AND d.is_primary = 1
    WHERE p.publisher_id = ?
    ORDER BY d.domain_id
    LIMIT 1
  `).bind(publisherId).first();
}

function response(state, decision, reviewStatus) {
  return {
    status: 200,
    body: {
      review: {
        publisher_id: state.publisher_id,
        decision,
        account_status: state.account_status,
        review_status: reviewStatus,
        reviewed: true
      }
    }
  };
}

function isIdempotent(state, decision) {
  if (!state || Number(state.primary_count) !== 1) return false;
  if (decision === "approve") {
    return state.account_status === "pending_review" &&
      state.review_status === "approved";
  }
  return state.account_status === "rejected" &&
    state.review_status === "rejected";
}

async function reviewApprove(database, state) {
  if (state.account_status !== "pending_review" ||
      state.review_status !== "pending" ||
      Number(state.primary_count) !== 1 ||
      !isValidInstallPublicKey(state.install_public_key)) {
    return failure(409, "conflict");
  }

  const reviewed = await database.prepare(`
    UPDATE publisher_domains
    SET review_status = 'approved',
        reviewed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE domain_id = ?
      AND publisher_id = ?
      AND is_primary = 1
      AND review_status = 'pending'
      AND install_status = 'detected'
      AND verification_status = 'verified'
      AND first_seen_at IS NOT NULL
      AND last_seen_at IS NOT NULL
      AND verified_at IS NOT NULL
      AND (SELECT count(*)
           FROM publisher_domains px
           WHERE px.publisher_id = publisher_domains.publisher_id
             AND px.is_primary = 1) = 1
      AND EXISTS (
        SELECT 1
        FROM publishers p
        WHERE p.publisher_id = publisher_domains.publisher_id
          AND p.account_status = 'pending_review'
          AND p.terms_version = ?
          AND p.terms_accepted_at IS NOT NULL
          AND p.terms_accepted_by_user_id IS NOT NULL
          AND p.install_public_key = ?
      )
    RETURNING review_status, reviewed_at
  `).bind(
    state.domain_id,
    state.publisher_id,
    TERMS_VERSION,
    state.install_public_key
  ).first();

  if (reviewed) {
    return response(state, "approve", "approved");
  }

  const current = await readState(database, state.publisher_id);
  if (isIdempotent(current, "approve")) {
    return response(current, "approve", "approved");
  }
  return failure(409, "conflict");
}

async function reviewReject(database, state) {
  if (state.account_status !== "pending_review" ||
      state.review_status !== "pending" ||
      Number(state.primary_count) !== 1) {
    return failure(409, "conflict");
  }

  const results = await database.batch([
    database.prepare(`
      UPDATE publishers
      SET account_status = 'rejected',
          updated_at = CURRENT_TIMESTAMP
      WHERE publisher_id = ?
        AND account_status = 'pending_review'
        AND (SELECT count(*)
             FROM publisher_domains d
             WHERE d.publisher_id = publishers.publisher_id
               AND d.is_primary = 1
               AND d.review_status = 'pending') = 1
    `).bind(state.publisher_id),
    database.prepare(`
      UPDATE publisher_domains
      SET review_status = 'rejected',
          reviewed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE publisher_id = ?
        AND domain_id = ?
        AND is_primary = 1
        AND review_status = 'pending'
        AND changes() = 1
        AND EXISTS (
          SELECT 1
          FROM publishers p
          WHERE p.publisher_id = publisher_domains.publisher_id
            AND p.account_status = 'rejected'
        )
    `).bind(state.publisher_id, state.domain_id)
  ]);

  const publisherChanges = Number(results[0]?.meta?.changes ?? 0);
  const domainChanges = Number(results[1]?.meta?.changes ?? 0);

  if (publisherChanges === 1 && domainChanges === 1) {
    return response(
      { ...state, account_status: "rejected" },
      "reject",
      "rejected"
    );
  }

  if (publisherChanges !== domainChanges) {
    throw new Error("publisher review batch invariant violated");
  }

  const current = await readState(database, state.publisher_id);
  if (isIdempotent(current, "reject")) {
    return response(current, "reject", "rejected");
  }
  return failure(409, "conflict");
}

export async function reviewPublisher(database, input) {
  const valid = validateReviewInput(input);
  if (!valid) return failure(400, "invalid_input");

  const state = await readState(database, valid.publisherId);
  if (!state) return failure(404, "not_found");

  if (isIdempotent(state, valid.decision)) {
    return response(
      state,
      valid.decision,
      valid.decision === "approve" ? "approved" : "rejected"
    );
  }

  return valid.decision === "approve"
    ? reviewApprove(database, state)
    : reviewReject(database, state);
}
