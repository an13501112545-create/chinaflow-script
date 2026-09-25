import { validateSession } from "./auth-session-validate-v0.1.mjs";

const SUPPLIER = "trip.com";
const CHANNEL = "agent_booking";
const HOTEL_BASE_URL = "https://www.trip.com/hotels";
const failure = (status, error) => ({ status, body: { error } });

export function agentBookingEnabled(env) {
  return env?.AGENT_BOOKING_ENABLED === "true";
}

function validProduct(value) {
  return value === "hotel";
}

function safeSupplierCredential(value) {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\x00-\x1f\x7f]/u.test(value);
}

function safePlacement(value) {
  return typeof value === "string" &&
    /^[A-Za-z0-9_-]{2,64}$/.test(value);
}

async function resolveAgentBooking(database, session) {
  const result = await database.prepare(`
    SELECT
      p.publisher_id,
      s.aid,
      s.sid,
      pp.placement,
      pp.external_tracking_key
    FROM publisher_memberships m
    JOIN publishers p
      ON p.publisher_id = m.publisher_id
    JOIN publisher_domains d
      ON d.publisher_id = p.publisher_id
     AND d.is_primary = 1
    JOIN publisher_supplier_sites s
      ON s.publisher_id = p.publisher_id
     AND s.domain_id = d.domain_id
     AND s.supplier = ?
    JOIN publisher_channel_capabilities c
      ON c.publisher_id = p.publisher_id
     AND c.channel = ?
    JOIN publisher_placements pp
      ON pp.publisher_id = p.publisher_id
     AND pp.supplier = ?
     AND pp.channel = ?
    WHERE m.user_id = ?
      AND m.membership_status = 'active'
      AND p.account_status = 'active'
      AND d.install_status = 'detected'
      AND d.verification_status = 'verified'
      AND d.claim_status = 'claimed'
      AND d.review_status = 'approved'
      AND d.monetization_status = 'enabled'
      AND s.provisioning_status = 'active'
      AND s.provisioned_at IS NOT NULL
      AND c.capability_status = 'enabled'
      AND c.enabled_at IS NOT NULL
      AND pp.is_active = 1
      AND (pp.effective_from IS NULL OR julianday(pp.effective_from) <= julianday('now'))
      AND (pp.effective_to IS NULL OR julianday(pp.effective_to) > julianday('now'))
      AND EXISTS (
        SELECT 1
        FROM publisher_sessions sx
        JOIN publisher_users ux ON ux.user_id = sx.user_id
        WHERE sx.session_id = ?
          AND sx.user_id = ?
          AND sx.revoked_at IS NULL
          AND julianday(sx.expires_at) > julianday('now')
          AND ux.user_status = 'active'
      )
    ORDER BY p.publisher_id, pp.placement
    LIMIT 2
  `).bind(
    SUPPLIER,
    CHANNEL,
    SUPPLIER,
    CHANNEL,
    session.userId,
    session.sessionId,
    session.userId
  ).all();

  const rows = result?.results ?? [];
  if (rows.length === 0) return failure(404, "not_found");
  if (rows.length !== 1) return failure(409, "conflict");

  const row = rows[0];
  if (
    typeof row.publisher_id !== "string" ||
    !safeSupplierCredential(row.aid) ||
    !safeSupplierCredential(row.sid) ||
    !safePlacement(row.placement) ||
    row.external_tracking_key !== row.placement
  ) {
    return failure(409, "conflict");
  }

  return { row };
}

function buildDestination(row, product) {
  if (!validProduct(product)) return null;
  const url = new URL(HOTEL_BASE_URL);
  url.searchParams.set("Allianceid", row.aid);
  url.searchParams.set("SID", row.sid);
  url.searchParams.set("trip_sub1", row.placement);
  return url.toString();
}

export async function getAgentBookingLaunch(database, token, product) {
  if (!validProduct(product)) return failure(400, "invalid_input");

  const session = await validateSession(database, token);
  if (!session) return failure(401, "unauthenticated");

  const authorization = await resolveAgentBooking(database, session);
  if (authorization.status) return authorization;

  const { row } = authorization;
  const destinationUrl = buildDestination(row, product);
  if (!destinationUrl) return failure(400, "invalid_input");

  return {
    status: 200,
    body: {
      agent_booking: {
        publisher_id: row.publisher_id,
        channel: CHANNEL,
        supplier: SUPPLIER,
        product,
        placement: row.placement,
        destination_url: destinationUrl
      }
    }
  };
}
