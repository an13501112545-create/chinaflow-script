import { TERMS_VERSION } from "./onboarding-terms-v0.1.mjs";
import { isValidInstallPublicKey } from "./install-public-key-v0.1.mjs";

const SUPPLIER = "trip.com";
const failure = (status, error) => ({ status, body: { error } });

function validIdentifier(value, max = 256) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= max &&
    value.trim() === value &&
    !/[\x00-\x1f\x7f]/u.test(value);
}

export function validateStartProvisioningInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "publisher_id") return null;
  if (!validIdentifier(input.publisher_id)) return null;
  return { publisherId: input.publisher_id };
}

export function validateCompleteProvisioningInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const keys = Object.keys(input).sort();
  const allowed = [
    ["aid", "publisher_id", "sid"],
    ["aid", "publisher_id", "sid", "sid_name"]
  ];
  if (!allowed.some(expected =>
    expected.length === keys.length &&
    expected.every((key, index) => key === keys[index])
  )) return null;

  if (!validIdentifier(input.publisher_id) ||
      !validIdentifier(input.aid) ||
      !validIdentifier(input.sid) ||
      (Object.hasOwn(input, "sid_name") &&
        !validIdentifier(input.sid_name, 200))) {
    return null;
  }

  return {
    publisherId: input.publisher_id,
    aid: input.aid,
    sid: input.sid,
    sidName: input.sid_name ?? null
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
      d.claim_status,
      d.review_status,
      d.monetization_status,
      d.first_seen_at,
      d.last_seen_at,
      d.verified_at,
      d.reviewed_at,

      s.supplier_site_id,
      s.supplier,
      s.aid,
      s.sid,
      s.sid_name,
      s.provisioning_status,
      s.provisioned_at,
      s.created_at AS supplier_created_at,
      s.updated_at AS supplier_updated_at,

      (SELECT count(*)
       FROM publisher_domains px
       WHERE px.publisher_id = p.publisher_id
         AND px.is_primary = 1) AS primary_count

    FROM publishers p
    LEFT JOIN publisher_domains d
      ON d.publisher_id = p.publisher_id
     AND d.is_primary = 1
    LEFT JOIN publisher_supplier_sites s
      ON s.publisher_id = p.publisher_id
     AND s.domain_id = d.domain_id
     AND s.supplier = ?
    WHERE p.publisher_id = ?
    ORDER BY d.domain_id, s.supplier_site_id
    LIMIT 1
  `).bind(SUPPLIER, publisherId).first();
}

function eligible(state) {
  return !!state &&
    state.account_status === "pending_review" &&
    state.terms_version === TERMS_VERSION &&
    state.terms_accepted_at !== null &&
    state.terms_accepted_by_user_id !== null &&
    isValidInstallPublicKey(state.install_public_key) &&
    Number(state.primary_count) === 1 &&
    !!state.domain_id &&
    state.install_status === "detected" &&
    state.verification_status === "verified" &&
    state.claim_status === "claimed" &&
    state.review_status === "approved" &&
    state.monetization_status === "disabled" &&
    state.first_seen_at !== null &&
    state.last_seen_at !== null &&
    state.verified_at !== null &&
    state.reviewed_at !== null;
}

function provisioningBody(state, flags = {}) {
  return {
    status: flags.status ?? 200,
    body: {
      provisioning: {
        publisher_id: state.publisher_id,
        domain_id: state.domain_id,
        supplier_site_id: state.supplier_site_id,
        supplier: SUPPLIER,
        provisioning_status: state.provisioning_status,
        aid: state.aid ?? null,
        sid: state.sid ?? null,
        sid_name: state.sid_name ?? null,
        ...(Object.hasOwn(flags, "created")
          ? { created: flags.created }
          : {}),
        ...(Object.hasOwn(flags, "completed")
          ? { completed: flags.completed }
          : {})
      }
    }
  };
}

function sameCredentials(state, input) {
  return state?.aid === input.aid &&
    state?.sid === input.sid &&
    (state?.sid_name ?? null) === input.sidName;
}

export async function startSupplierProvisioning(database, input) {
  const valid = validateStartProvisioningInput(input);
  if (!valid) return failure(400, "invalid_input");

  const initial = await readState(database, valid.publisherId);
  if (!initial) return failure(404, "not_found");
  if (!eligible(initial)) return failure(409, "conflict");

  if (initial.supplier_site_id) {
    if (
      initial.supplier === SUPPLIER &&
      (initial.provisioning_status === "pending" ||
       initial.provisioning_status === "active")
    ) {
      return provisioningBody(initial, { created: false });
    }
    return failure(409, "conflict");
  }

  const supplierSiteId = "site_" + crypto.randomUUID();

  const inserted = await database.prepare(`
    INSERT INTO publisher_supplier_sites (
      supplier_site_id,
      publisher_id,
      domain_id,
      supplier,
      provisioning_status
    )
    SELECT
      ?,
      p.publisher_id,
      d.domain_id,
      ?,
      'pending'
    FROM publishers p
    JOIN publisher_domains d
      ON d.publisher_id = p.publisher_id
     AND d.is_primary = 1
    WHERE p.publisher_id = ?
      AND p.account_status = 'pending_review'
      AND p.terms_version = ?
      AND p.terms_accepted_at IS NOT NULL
      AND p.terms_accepted_by_user_id IS NOT NULL
      AND p.install_public_key = ?
      AND d.install_status = 'detected'
      AND d.verification_status = 'verified'
      AND d.claim_status = 'claimed'
      AND d.review_status = 'approved'
      AND d.monetization_status = 'disabled'
      AND d.first_seen_at IS NOT NULL
      AND d.last_seen_at IS NOT NULL
      AND d.verified_at IS NOT NULL
      AND d.reviewed_at IS NOT NULL
      AND (
        SELECT count(*)
        FROM publisher_domains px
        WHERE px.publisher_id = p.publisher_id
          AND px.is_primary = 1
      ) = 1
      AND NOT EXISTS (
        SELECT 1
        FROM publisher_supplier_sites sx
        WHERE sx.publisher_id = p.publisher_id
          AND sx.domain_id = d.domain_id
          AND sx.supplier = ?
      )
  `).bind(
    supplierSiteId,
    SUPPLIER,
    valid.publisherId,
    TERMS_VERSION,
    initial.install_public_key,
    SUPPLIER
  ).run();

  const changes = Number(inserted?.meta?.changes ?? 0);
  const current = await readState(database, valid.publisherId);

  if (
    changes === 1 &&
    current?.supplier_site_id === supplierSiteId &&
    current.provisioning_status === "pending"
  ) {
    return provisioningBody(current, {
      status: 201,
      created: true
    });
  }

  if (
    changes === 0 &&
    eligible(current) &&
    current?.supplier === SUPPLIER &&
    (current.provisioning_status === "pending" ||
     current.provisioning_status === "active")
  ) {
    return provisioningBody(current, { created: false });
  }

  if (changes !== 0) {
    throw new Error("supplier provisioning start invariant violated");
  }

  return failure(409, "conflict");
}

export async function completeSupplierProvisioning(database, input) {
  const valid = validateCompleteProvisioningInput(input);
  if (!valid) return failure(400, "invalid_input");

  const initial = await readState(database, valid.publisherId);
  if (!initial) return failure(404, "not_found");
  if (!eligible(initial) || !initial.supplier_site_id) {
    return failure(409, "conflict");
  }

  if (initial.provisioning_status === "active") {
    return sameCredentials(initial, valid)
      ? provisioningBody(initial, { completed: false })
      : failure(409, "conflict");
  }

  if (initial.provisioning_status !== "pending") {
    return failure(409, "conflict");
  }

  const updated = await database.prepare(`
    UPDATE publisher_supplier_sites
    SET aid = ?,
        sid = ?,
        sid_name = ?,
        provisioning_status = 'active',
        provisioned_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE supplier_site_id = ?
      AND publisher_id = ?
      AND domain_id = ?
      AND supplier = ?
      AND provisioning_status = 'pending'
      AND aid IS NULL
      AND sid IS NULL
      AND sid_name IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM publisher_supplier_sites sx
        WHERE sx.supplier = ?
          AND sx.sid = ?
          AND sx.supplier_site_id <> publisher_supplier_sites.supplier_site_id
      )
      AND EXISTS (
        SELECT 1
        FROM publishers p
        JOIN publisher_domains d
          ON d.publisher_id = p.publisher_id
         AND d.domain_id = publisher_supplier_sites.domain_id
         AND d.is_primary = 1
        WHERE p.publisher_id = publisher_supplier_sites.publisher_id
          AND p.account_status = 'pending_review'
          AND p.terms_version = ?
          AND p.terms_accepted_at IS NOT NULL
          AND p.terms_accepted_by_user_id IS NOT NULL
          AND p.install_public_key = ?
          AND d.install_status = 'detected'
          AND d.verification_status = 'verified'
          AND d.claim_status = 'claimed'
          AND d.review_status = 'approved'
          AND d.monetization_status = 'disabled'
          AND d.first_seen_at IS NOT NULL
          AND d.last_seen_at IS NOT NULL
          AND d.verified_at IS NOT NULL
          AND d.reviewed_at IS NOT NULL
          AND (
            SELECT count(*)
            FROM publisher_domains px
            WHERE px.publisher_id = p.publisher_id
              AND px.is_primary = 1
          ) = 1
      )
  `).bind(
    valid.aid,
    valid.sid,
    valid.sidName,
    initial.supplier_site_id,
    initial.publisher_id,
    initial.domain_id,
    SUPPLIER,
    SUPPLIER,
    valid.sid,
    TERMS_VERSION,
    initial.install_public_key
  ).run();

  const changes = Number(updated?.meta?.changes ?? 0);
  const current = await readState(database, valid.publisherId);

  if (
    changes === 1 &&
    eligible(current) &&
    current?.provisioning_status === "active" &&
    sameCredentials(current, valid)
  ) {
    return provisioningBody(current, { completed: true });
  }

  if (
    changes === 0 &&
    eligible(current) &&
    current?.provisioning_status === "active" &&
    sameCredentials(current, valid)
  ) {
    return provisioningBody(current, { completed: false });
  }

  if (changes !== 0) {
    throw new Error("supplier provisioning completion invariant violated");
  }

  return failure(409, "conflict");
}
