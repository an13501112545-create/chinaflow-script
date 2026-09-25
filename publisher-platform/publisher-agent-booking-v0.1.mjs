import { validateSession } from "./auth-session-validate-v0.1.mjs";
import { TERMS_VERSION } from "./onboarding-terms-v0.1.mjs";

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

function routingCredentials(env) {
  const aid = env?.AGENT_BOOKING_TRIP_AID;
  const sid = env?.AGENT_BOOKING_TRIP_SID;
  return safeSupplierCredential(aid) && safeSupplierCredential(sid)
    ? { aid, sid }
    : null;
}

async function resolveAgentBooking(database, session) {
  const result = await database.prepare(`
    SELECT
      p.publisher_id,
      pp.placement,
      pp.external_tracking_key
    FROM publisher_memberships m
    JOIN publishers p
      ON p.publisher_id = m.publisher_id
    JOIN publisher_users u
      ON u.user_id = m.user_id
    JOIN publisher_channel_capabilities c
      ON c.publisher_id = p.publisher_id
     AND c.channel = ?
    JOIN publisher_placements pp
      ON pp.publisher_id = p.publisher_id
     AND pp.supplier = ?
     AND pp.channel = ?
    WHERE m.user_id = ?
      AND m.membership_status = 'active'
      AND u.user_status = 'active'
      AND u.email_verified_at IS NOT NULL
      AND p.account_status IN ('draft', 'pending_review', 'active')
      AND p.terms_version = ?
      AND p.terms_accepted_at IS NOT NULL
      AND p.terms_accepted_by_user_id IS NOT NULL
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
    CHANNEL,
    SUPPLIER,
    CHANNEL,
    session.userId,
    TERMS_VERSION,
    session.sessionId,
    session.userId
  ).all();

  const rows = result?.results ?? [];
  if (rows.length === 0) return failure(404, "not_found");
  if (rows.length !== 1) return failure(409, "conflict");

  const row = rows[0];
  if (
    typeof row.publisher_id !== "string" ||
    !safePlacement(row.placement) ||
    row.external_tracking_key !== row.placement
  ) {
    return failure(409, "conflict");
  }

  return { row };
}

function buildDestination(row, product, credentials) {
  if (!validProduct(product) || !credentials) return null;
  const url = new URL(HOTEL_BASE_URL);
  url.searchParams.set("Allianceid", credentials.aid);
  url.searchParams.set("SID", credentials.sid);
  url.searchParams.set("trip_sub1", row.placement);
  return url.toString();
}

export async function getAgentBookingLaunch(database, token, product, env) {
  if (!validProduct(product)) return failure(400, "invalid_input");

  const credentials = routingCredentials(env);
  if (!credentials) return failure(503, "temporarily_unavailable");

  const session = await validateSession(database, token);
  if (!session) return failure(401, "unauthenticated");

  const authorization = await resolveAgentBooking(database, session);
  if (authorization.status) return authorization;

  const { row } = authorization;
  const destinationUrl = buildDestination(row, product, credentials);
  if (!destinationUrl) return failure(503, "temporarily_unavailable");

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
