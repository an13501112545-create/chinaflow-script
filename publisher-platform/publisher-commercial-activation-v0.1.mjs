import { TERMS_VERSION } from "./onboarding-terms-v0.1.mjs";
import { isValidInstallPublicKey } from "./install-public-key-v0.1.mjs";

const SUPPLIER = "trip.com";
const failure = (status, error) => ({ status, body: { error } });

function validPublisherId(value) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\x00-\x1f\x7f]/u.test(value);
}

function validPlacement(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9_-]{2,64}$/.test(value);
}

export function validateCommercialActivationInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;

  const keys = Object.keys(input).sort();
  if (keys.length !== 2 ||
      keys[0] !== "offers" ||
      keys[1] !== "publisher_id" ||
      !validPublisherId(input.publisher_id) ||
      !Array.isArray(input.offers) ||
      input.offers.length < 1 ||
      input.offers.length > 2) {
    return null;
  }

  const products = new Set();
  const placements = new Set();
  const offers = [];

  for (const offer of input.offers) {
    if (!offer || typeof offer !== "object" || Array.isArray(offer)) return null;

    const offerKeys = Object.keys(offer).sort();
    if (
      offerKeys.length !== 3 ||
      offerKeys[0] !== "affiliate_url" ||
      offerKeys[1] !== "placement" ||
      offerKeys[2] !== "product"
    ) {
      return null;
    }

    if (!["hotel", "flight"].includes(offer.product) ||
        products.has(offer.product) ||
        !validPlacement(offer.placement) ||
        placements.has(offer.placement) ||
        typeof offer.affiliate_url !== "string" ||
        offer.affiliate_url.length < 1 ||
        offer.affiliate_url.length > 4096) {
      return null;
    }

    products.add(offer.product);
    placements.add(offer.placement);
    offers.push({
      product: offer.product,
      placement: offer.placement,
      affiliateUrl: offer.affiliate_url
    });
  }

  offers.sort((a, b) => a.product.localeCompare(b.product));
  return { publisherId: input.publisher_id, offers };
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

      s.supplier_site_id,
      s.supplier,
      s.aid,
      s.sid,
      s.sid_name,
      s.provisioning_status,
      s.provisioned_at,

      (SELECT count(*)
       FROM publisher_domains px
       WHERE px.publisher_id = p.publisher_id
         AND px.is_primary = 1) AS primary_count,

      (SELECT count(*)
       FROM publisher_placements pp
       WHERE pp.publisher_id = p.publisher_id) AS placement_count,

      (SELECT count(*)
       FROM publisher_supplier_offers po
       WHERE po.publisher_id = p.publisher_id) AS offer_count

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

function commonEligibility(state) {
  return !!state &&
    state.terms_version === TERMS_VERSION &&
    state.terms_accepted_at !== null &&
    state.terms_accepted_by_user_id !== null &&
    isValidInstallPublicKey(state.install_public_key) &&
    Number(state.primary_count) === 1 &&
    !!state.domain_id &&
    state.install_status === "detected" &&
    state.verification_status === "verified" &&
    state.review_status === "approved" &&
    state.first_seen_at !== null &&
    state.last_seen_at !== null &&
    state.verified_at !== null &&
    state.reviewed_at !== null &&
    !!state.supplier_site_id &&
    state.supplier === SUPPLIER &&
    state.provisioning_status === "active" &&
    state.provisioned_at !== null &&
    typeof state.aid === "string" &&
    state.aid.length > 0 &&
    typeof state.sid === "string" &&
    state.sid.length > 0;
}

function eligiblePending(state) {
  return commonEligibility(state) &&
    state.account_status === "pending_review" &&
    state.monetization_status === "disabled" &&
    Number(state.placement_count) === 0 &&
    Number(state.offer_count) === 0;
}

function eligibleActive(state) {
  return commonEligibility(state) &&
    state.account_status === "active" &&
    state.monetization_status === "enabled";
}

function validSupplierUrl(raw, offer, state) {
  if (
    typeof raw !== "string" ||
    raw.trim() !== raw ||
    /[\s\x00-\x1f\x7f\\]/u.test(raw) ||
    !/^https:\/\//i.test(raw)
  ) {
    return false;
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (
    url.protocol !== "https:" ||
    !["www.trip.com", "trip.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  ) {
    return false;
  }

  const alliance = url.searchParams.getAll("Allianceid");
  const sid = url.searchParams.getAll("SID");
  const sub1 = url.searchParams.getAll("trip_sub1");

  return alliance.length === 1 &&
    alliance[0] === state.aid &&
    sid.length === 1 &&
    sid[0] === state.sid &&
    sub1.length === 1 &&
    sub1[0] === offer.placement;
}

async function readGraph(database, state) {
  const [placements, offers] = await Promise.all([
    database.prepare(`
      SELECT placement, supplier, external_tracking_key, is_active
      FROM publisher_placements
      WHERE publisher_id = ?
      ORDER BY external_tracking_key
    `).bind(state.publisher_id).all(),
    database.prepare(`
      SELECT supplier_site_id, domain_id, offer_key, product,
        affiliate_url, is_active,
        (SELECT pp.external_tracking_key
         FROM publisher_placements pp
         WHERE pp.placement_id = publisher_supplier_offers.placement_id
           AND pp.publisher_id = publisher_supplier_offers.publisher_id
        ) AS external_tracking_key,
        (SELECT pp.placement
         FROM publisher_placements pp
         WHERE pp.placement_id = publisher_supplier_offers.placement_id
           AND pp.publisher_id = publisher_supplier_offers.publisher_id
        ) AS placement_label,
        (SELECT pp.supplier
         FROM publisher_placements pp
         WHERE pp.placement_id = publisher_supplier_offers.placement_id
           AND pp.publisher_id = publisher_supplier_offers.publisher_id
        ) AS placement_supplier,
        (SELECT pp.is_active
         FROM publisher_placements pp
         WHERE pp.placement_id = publisher_supplier_offers.placement_id
           AND pp.publisher_id = publisher_supplier_offers.publisher_id
        ) AS placement_active
      FROM publisher_supplier_offers
      WHERE publisher_id = ?
      ORDER BY product
    `).bind(state.publisher_id).all()
  ]);

  return {
    placements: placements?.results ?? [],
    offers: offers?.results ?? []
  };
}

function graphMatches(state, graph, expectedOffers) {
  if (
    graph.placements.length !== expectedOffers.length ||
    graph.offers.length !== expectedOffers.length
  ) {
    return false;
  }

  for (const expected of expectedOffers) {
    const placement = graph.placements.find(
      row => row.external_tracking_key === expected.placement
    );
    const offer = graph.offers.find(
      row => row.product === expected.product
    );

    if (
      !placement ||
      placement.placement !== expected.placement ||
      placement.supplier !== SUPPLIER ||
      Number(placement.is_active) !== 1 ||
      !offer ||
      offer.supplier_site_id !== state.supplier_site_id ||
      offer.domain_id !== state.domain_id ||
      offer.offer_key !== expected.product ||
      offer.affiliate_url !== expected.affiliateUrl ||
      offer.external_tracking_key !== expected.placement ||
      offer.placement_label !== expected.placement ||
      offer.placement_supplier !== SUPPLIER ||
      Number(offer.placement_active) !== 1 ||
      Number(offer.is_active) !== 1
    ) {
      return false;
    }
  }

  return true;
}

function response(state, offerCount, activated) {
  return {
    status: 200,
    body: {
      activation: {
        publisher_id: state.publisher_id,
        account_status: state.account_status,
        monetization_status: state.monetization_status,
        supplier: SUPPLIER,
        offer_count: offerCount,
        activated
      }
    }
  };
}

function placementStatement(database, state, offer, ids, requirePreviousChange) {
  return database.prepare(`
    INSERT INTO publisher_placements (
      placement_id, publisher_id, placement, supplier,
      external_tracking_key, is_active, effective_from
    )
    SELECT ?, p.publisher_id, ?, ?, ?, 1, CURRENT_TIMESTAMP
    FROM publishers p
    JOIN publisher_domains d
      ON d.publisher_id = p.publisher_id
     AND d.is_primary = 1
    JOIN publisher_supplier_sites s
      ON s.publisher_id = p.publisher_id
     AND s.domain_id = d.domain_id
     AND s.supplier = ?
    WHERE p.publisher_id = ?
      ${requirePreviousChange ? "AND changes() = 1" : ""}
      AND p.account_status = 'pending_review'
      AND p.terms_version = ?
      AND p.terms_accepted_at IS NOT NULL
      AND p.terms_accepted_by_user_id IS NOT NULL
      AND p.install_public_key = ?
      AND d.install_status = 'detected'
      AND d.verification_status = 'verified'
      AND d.review_status = 'approved'
      AND d.monetization_status = 'disabled'
      AND d.first_seen_at IS NOT NULL
      AND d.last_seen_at IS NOT NULL
      AND d.verified_at IS NOT NULL
      AND d.reviewed_at IS NOT NULL
      AND s.supplier_site_id = ?
      AND s.provisioning_status = 'active'
      AND s.provisioned_at IS NOT NULL
      AND s.aid = ?
      AND s.sid = ?
      AND (SELECT count(*) FROM publisher_domains px
           WHERE px.publisher_id=p.publisher_id AND px.is_primary=1) = 1
      AND (SELECT count(*) FROM publisher_placements pp
           WHERE pp.publisher_id=p.publisher_id) = ?
      AND (SELECT count(*) FROM publisher_supplier_offers po
           WHERE po.publisher_id=p.publisher_id) = ?
  `).bind(
    ids.placementId,
    offer.placement,
    SUPPLIER,
    offer.placement,
    SUPPLIER,
    state.publisher_id,
    TERMS_VERSION,
    state.install_public_key,
    state.supplier_site_id,
    state.aid,
    state.sid,
    ids.expectedPlacements,
    ids.expectedOffers
  );
}

function offerStatement(database, state, offer, ids) {
  return database.prepare(`
    INSERT INTO publisher_supplier_offers (
      supplier_offer_id, supplier_site_id, publisher_id, domain_id,
      offer_key, product, placement_id, affiliate_url, is_active
    )
    SELECT ?, s.supplier_site_id, p.publisher_id, d.domain_id,
      ?, ?, ?, ?, 1
    FROM publishers p
    JOIN publisher_domains d
      ON d.publisher_id=p.publisher_id AND d.is_primary=1
    JOIN publisher_supplier_sites s
      ON s.publisher_id=p.publisher_id
     AND s.domain_id=d.domain_id
     AND s.supplier=?
    WHERE p.publisher_id=?
      AND changes() = 1
      AND p.account_status='pending_review'
      AND d.monetization_status='disabled'
      AND d.review_status='approved'
      AND s.supplier_site_id=?
      AND s.provisioning_status='active'
  `).bind(
    ids.offerId,
    offer.product,
    offer.product,
    ids.placementId,
    offer.affiliateUrl,
    SUPPLIER,
    state.publisher_id,
    state.supplier_site_id
  );
}

export async function activatePublisherCommercially(database, input) {
  const valid = validateCommercialActivationInput(input);
  if (!valid) return failure(400, "invalid_input");

  const initial = await readState(database, valid.publisherId);
  if (!initial) return failure(404, "not_found");

  if (eligibleActive(initial)) {
    const graph = await readGraph(database, initial);
    return graphMatches(initial, graph, valid.offers)
      ? response(initial, valid.offers.length, false)
      : failure(409, "conflict");
  }

  if (!eligiblePending(initial)) return failure(409, "conflict");

  for (const offer of valid.offers) {
    if (!validSupplierUrl(offer.affiliateUrl, offer, initial)) {
      return failure(409, "conflict");
    }
  }

  const statements = [];
  let placementCount = 0;
  let offerCount = 0;

  for (const offer of valid.offers) {
    const ids = {
      placementId: "placement_" + crypto.randomUUID(),
      offerId: "offer_" + crypto.randomUUID(),
      expectedPlacements: placementCount,
      expectedOffers: offerCount
    };
    statements.push(
      placementStatement(
        database,
        initial,
        offer,
        ids,
        statements.length > 0
      )
    );
    placementCount += 1;
    statements.push(offerStatement(database, initial, offer, ids));
    offerCount += 1;
  }

  statements.push(
    database.prepare(`
      UPDATE publisher_domains
      SET monetization_status='enabled',
          updated_at=CURRENT_TIMESTAMP
      WHERE domain_id=?
        AND publisher_id=?
        AND is_primary=1
        AND changes()=1
        AND monetization_status='disabled'
        AND review_status='approved'
        AND verification_status='verified'
        AND install_status='detected'
        AND (SELECT count(*) FROM publisher_supplier_offers o
             WHERE o.publisher_id=publisher_domains.publisher_id
               AND o.domain_id=publisher_domains.domain_id
               AND o.is_active=1) = ?
        AND (SELECT count(*) FROM publisher_placements pp
             WHERE pp.publisher_id=publisher_domains.publisher_id
               AND pp.is_active=1) = ?
    `).bind(
      initial.domain_id,
      initial.publisher_id,
      valid.offers.length,
      valid.offers.length
    )
  );

  statements.push(
    database.prepare(`
      UPDATE publishers
      SET account_status='active',
          updated_at=CURRENT_TIMESTAMP
      WHERE publisher_id=?
        AND account_status='pending_review'
        AND changes()=1
        AND EXISTS (
          SELECT 1
          FROM publisher_domains d
          JOIN publisher_supplier_sites s
            ON s.publisher_id=publishers.publisher_id
           AND s.domain_id=d.domain_id
           AND s.supplier=?
          WHERE d.publisher_id=publishers.publisher_id
            AND d.is_primary=1
            AND d.review_status='approved'
            AND d.verification_status='verified'
            AND d.monetization_status='enabled'
            AND s.provisioning_status='active'
            AND s.provisioned_at IS NOT NULL
        )
    `).bind(initial.publisher_id, SUPPLIER)
  );

  const results = await database.batch(statements);
  const changes = results.map(
    result => Number(result?.meta?.changes ?? 0)
  );
  const allOne = changes.every(value => value === 1);

  const current = await readState(database, valid.publisherId);

  if (allOne && eligibleActive(current)) {
    const graph = await readGraph(database, current);
    if (!graphMatches(current, graph, valid.offers)) {
      throw new Error("commercial activation graph invariant violated");
    }
    return response(current, valid.offers.length, true);
  }

  if (changes.every(value => value === 0) && eligibleActive(current)) {
    const graph = await readGraph(database, current);
    if (graphMatches(current, graph, valid.offers)) {
      return response(current, valid.offers.length, false);
    }
  }

  if (changes.some(value => value !== 0)) {
    throw new Error("commercial activation batch invariant violated");
  }

  return failure(409, "conflict");
}
