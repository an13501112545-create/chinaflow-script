import { generateToken, hashToken } from "./auth-token-v0.1.mjs";

function validId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,64}$/.test(value);
}

export async function createOutreachAttribution(database, pipelineProspectId, campaign) {
  if (!database || typeof database.prepare !== "function") throw new Error("D1 binding unavailable");
  if (!validId(pipelineProspectId) || !validId(campaign)) throw new Error("invalid_input");

  const token = generateToken();
  const tokenHash = await hashToken(token);
  const attributionId = `oa_${crypto.randomUUID()}`;
  await database.prepare(`INSERT INTO outreach_attributions
    (attribution_id,token_hash,pipeline_prospect_id,campaign,created_at,updated_at)
    VALUES (?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
    .bind(attributionId, tokenHash, pipelineProspectId, campaign).run();
  return { attributionId, token };
}

export async function recordOutreachClick(database, token) {
  if (!database || typeof database.prepare !== "function") throw new Error("D1 binding unavailable");
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = await hashToken(token);
  const result = await database.prepare(`UPDATE outreach_attributions
    SET first_click_at = COALESCE(first_click_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_click_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        click_count = click_count + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE token_hash = ?
    RETURNING attribution_id,pipeline_prospect_id,campaign,click_count,publisher_id`)
    .bind(tokenHash).all();
  return result.results[0] ?? null;
}

export async function bindOutreachPublisher(database, token, publisherId) {
  if (!database || typeof database.prepare !== "function")
throw new Error("D1 binding unavailable");
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token) || !validId(publisherId)) return null;
  const tokenHash = await hashToken(token);
  const result = await database.prepare(`UPDATE outreach_attributions
    SET publisher_id = ?, bound_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE token_hash = ? AND publisher_id IS NULL
      AND EXISTS (SELECT 1 FROM publishers WHERE publisher_id = ?)
    RETURNING attribution_id,publisher_id,bound_at`)
    .bind(publisherId, tokenHash, publisherId).all();
  return result.results[0] ?? null;
}
