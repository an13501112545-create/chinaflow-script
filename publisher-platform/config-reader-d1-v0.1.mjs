import {
  buildPublisherConfig
} from "./config-builder-v0.1.mjs";

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function assertDatabase(database) {
  if (
    !database ||
    typeof database !== "object" ||
    typeof database.prepare !== "function"
  ) {
    throw new Error("D1 binding unavailable");
  }
}

function normalizeHostname(value) {
  const raw = requireString(value, "hostname");

  let url;

  try {
    url = new URL(
      raw.includes("://")
        ? raw
        : `https://${raw}`
    );
  } catch {
    throw new Error("hostname is invalid");
  }

  return url.hostname
    .toLowerCase()
    .replace(/\.$/, "");
}

export async function loadPublisherConfigInput(
  database,
  publisherId,
  hostname
) {
  assertDatabase(database);

  const normalizedPublisherId =
    requireString(publisherId, "publisherId");

  const normalizedHostname =
    normalizeHostname(hostname);

  const result =
    await database
      .prepare(`
SELECT
  p.publisher_id,
  p.account_status,

  d.domain_id,
  d.hostname,
  d.verification_status,
  d.review_status,
  d.monetization_status,

  s.supplier_site_id,
  s.publisher_id AS supplier_publisher_id,
  s.domain_id AS supplier_domain_id,
  s.supplier,
  s.provisioning_status,

  o.supplier_offer_id,
  o.product,
  o.affiliate_url,

  pp.external_tracking_key

FROM publishers p

JOIN publisher_domains d
  ON d.publisher_id = p.publisher_id

LEFT JOIN publisher_supplier_sites s
  ON s.publisher_id = p.publisher_id
 AND s.domain_id = d.domain_id
 AND s.supplier = 'trip.com'

LEFT JOIN publisher_supplier_offers o
  ON o.supplier_site_id = s.supplier_site_id
 AND o.publisher_id = p.publisher_id
 AND o.domain_id = d.domain_id
 AND o.is_active = 1

LEFT JOIN publisher_placements pp
  ON pp.placement_id = o.placement_id
 AND pp.publisher_id = p.publisher_id
 AND pp.supplier = s.supplier
 AND pp.is_active = 1

WHERE p.publisher_id = ?1
  AND d.hostname = ?2

ORDER BY o.supplier_offer_id
`)
      .bind(
        normalizedPublisherId,
        normalizedHostname
      )
      .all();

  if (!Array.isArray(result?.results)) {
    throw new Error(
      "Invalid D1 result: publisher config"
    );
  }

  const rows = result.results;

  if (rows.length === 0) {
    return null;
  }

  const first = rows[0];

  const publisher = {
    publisher_id: first.publisher_id,
    account_status: first.account_status
  };

  const domain = {
    domain_id: first.domain_id,
    hostname: first.hostname,
    verification_status:
      first.verification_status,
    review_status:
      first.review_status,
    monetization_status:
      first.monetization_status
  };

  /*
   * A publisher may install ChinaFlow before Trip.com
   * provisioning is complete.
   *
   * In that case return a synthetic pending supplier site.
   * The builder will return a valid config with zero offers.
   */
  if (!first.supplier_site_id) {
    return {
      publisher,
      domain,

      supplierSite: {
        publisher_id: first.publisher_id,
        domain_id: first.domain_id,
        supplier: "trip.com",
        provisioning_status: "pending",
        offers: []
      }
    };
  }

  for (const row of rows) {
    if (
      row.publisher_id !== first.publisher_id ||
      row.domain_id !== first.domain_id ||
      row.supplier_site_id !== first.supplier_site_id ||
      row.supplier_publisher_id !== first.publisher_id ||
      row.supplier_domain_id !== first.domain_id
    ) {
      throw new Error(
        "Publisher config tenant integrity violation"
      );
    }
  }

  const offers = rows
    .filter(
      row =>
        row.supplier_offer_id &&
        row.product &&
        row.affiliate_url &&
        row.external_tracking_key
    )
    .map(row => ({
      product: row.product,

      /*
       * This is the actual Trip.com attribution key.
       * Do not expose internal placement_id here.
       */
      placement:
        row.external_tracking_key,

      url:
        row.affiliate_url
    }));

  return {
    publisher,
    domain,

    supplierSite: {
      publisher_id:
        first.supplier_publisher_id,

      domain_id:
        first.supplier_domain_id,

      supplier:
        first.supplier,

      provisioning_status:
        first.provisioning_status,

      offers
    }
  };
}

export async function buildPublisherConfigFromD1(
  database,
  publisherId,
  hostname
) {
  const input =
    await loadPublisherConfigInput(
      database,
      publisherId,
      hostname
    );

  if (input === null) {
    return null;
  }

  return buildPublisherConfig(input);
}
