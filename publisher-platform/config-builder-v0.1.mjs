const DEFAULT_COLLECTOR_URL =
  "https://chinaflow-event-collector-v0-1.an13501112545.workers.dev/v1/events";

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }

  return value.trim();
}

function safeId(value, name) {
  const id = requireString(value, name);

  if (!/^[A-Za-z0-9_-]{2,64}$/.test(id)) {
    throw new Error(`${name} contains invalid characters`);
  }

  return id;
}

function normalizeHostname(value) {
  const raw = requireString(value, "domain.hostname");

  let url;

  try {
    url = new URL(
      raw.includes("://")
        ? raw
        : `https://${raw}`
    );
  } catch {
    throw new Error("domain.hostname is invalid");
  }

  const hostname =
    url.hostname.toLowerCase().replace(/\.$/, "");

  if (!hostname || hostname.includes(" ")) {
    throw new Error("domain.hostname is invalid");
  }

  return hostname;
}

function validateAffiliateUrl(
  value,
  name,
  expectedPlacement
) {
  const raw = requireString(value, name);

  let url;

  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is invalid`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`${name} must use https`);
  }

  if (
    url.hostname !== "www.trip.com" &&
    url.hostname !== "trip.com"
  ) {
    throw new Error(`${name} must use trip.com`);
  }

  const tripSub1Values =
    url.searchParams.getAll("trip_sub1");

  if (
    tripSub1Values.length !== 1 ||
    tripSub1Values[0] !== expectedPlacement
  ) {
    throw new Error(
      `${name} trip_sub1 must match placement`
    );
  }

  /*
   * Validate, but preserve the exact supplier-provided URL.
   * ChinaFlow must not rewrite supplier affiliate parameters.
   */
  return raw;
}

function monetizationReady({
  publisher,
  domain,
  supplierSite
}) {
  return (
    publisher.account_status === "active" &&
    domain.verification_status === "verified" &&
    domain.review_status === "approved" &&
    domain.monetization_status === "enabled" &&
    supplierSite.supplier === "trip.com" &&
    supplierSite.provisioning_status === "active"
  );
}

function buildOffer(rawOffer, index) {
  if (!rawOffer || typeof rawOffer !== "object") {
    throw new Error(`supplier offer ${index} is invalid`);
  }

  const product =
    requireString(
      rawOffer.product,
      `supplier offers[${index}].product`
    );

  if (!["hotel", "flight"].includes(product)) {
    throw new Error(`Unsupported product: ${product}`);
  }

  const placement =
    safeId(
      rawOffer.placement,
      `supplier offers[${index}].placement`
    );

  const url =
    validateAffiliateUrl(
      rawOffer.url,
      `supplier offers[${index}].url`,
      placement
    );

  if (product === "hotel") {
    return {
      id: "china-hotels-generic",
      enabled: true,
      product,
      placement,
      eyebrow: "PLAN YOUR CHINA TRIP",
      title: "Find Hotels for Your China Trip",
      subtitle:
        "Compare hotel options and book your stay",
      icon: "▣",
      url
    };
  }

  return {
    id: "china-flights-generic",
    enabled: true,
    product,
    placement,
    eyebrow: "PLAN YOUR CHINA TRIP",
    title: "Compare Flights for Your China Trip",
    subtitle:
      "Check flight options and fares",
    icon: "✈",
    url
  };
}

export function buildPublisherConfig(input) {
  if (!input || typeof input !== "object") {
    throw new Error("input is required");
  }

  const publisher = input.publisher || {};
  const domain = input.domain || {};
  const supplierSite = input.supplierSite || {};

  const publisherId =
    safeId(
      publisher.publisher_id,
      "publisher.publisher_id"
    );

  const domainId =
    safeId(
      domain.domain_id,
      "domain.domain_id"
    );

  normalizeHostname(domain.hostname);

  const supplierPublisherId =
    safeId(
      supplierSite.publisher_id,
      "supplierSite.publisher_id"
    );

  const supplierDomainId =
    safeId(
      supplierSite.domain_id,
      "supplierSite.domain_id"
    );

  if (supplierPublisherId !== publisherId) {
    throw new Error(
      "supplierSite publisher ownership mismatch"
    );
  }

  if (supplierDomainId !== domainId) {
    throw new Error(
      "supplierSite domain ownership mismatch"
    );
  }

  const config = {
    version: "0.1",
    publisher: publisherId,

    analytics: {
      enabled: true,
      event_schema_version: "0.1",
      collector_url:
        input.analytics?.collector_url ||
        DEFAULT_COLLECTOR_URL
    },

    rules: [],
    offers: []
  };

  /*
   * Fail closed until every activation gate passes.
   */
  if (
    !monetizationReady({
      publisher,
      domain,
      supplierSite
    })
  ) {
    return config;
  }

  const rawOffers =
    Array.isArray(supplierSite.offers)
      ? supplierSite.offers
      : [];

  config.offers =
    rawOffers.map(buildOffer);

  return config;
}
