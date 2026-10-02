-- ChinaFlow Outreach Conversion Funnel v1
-- Adds anonymous conversion-stage timestamps/counters to existing outreach attribution.
ALTER TABLE outreach_attributions ADD COLUMN login_first_at TEXT;
ALTER TABLE outreach_attributions ADD COLUMN login_last_at TEXT;
ALTER TABLE outreach_attributions ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0 CHECK (login_count >= 0);
ALTER TABLE outreach_attributions ADD COLUMN magic_link_requested_first_at TEXT;
ALTER TABLE outreach_attributions ADD COLUMN magic_link_requested_last_at TEXT;
ALTER TABLE outreach_attributions ADD COLUMN magic_link_requested_count INTEGER NOT NULL DEFAULT 0 CHECK (magic_link_requested_count >= 0);
ALTER TABLE outreach_attributions ADD COLUMN magic_link_consumed_first_at TEXT;
ALTER TABLE outreach_attributions ADD COLUMN magic_link_consumed_last_at TEXT;
ALTER TABLE outreach_attributions ADD COLUMN magic_link_consumed_count INTEGER NOT NULL DEFAULT 0 CHECK (magic_link_consumed_count >= 0);
CREATE INDEX IF NOT EXISTS ix_outreach_attributions_campaign_login ON outreach_attributions (campaign, login_last_at);
CREATE INDEX IF NOT EXISTS ix_outreach_attributions_campaign_magic_request ON outreach_attributions (campaign, magic_link_requested_last_at);
PRAGMA optimize;
