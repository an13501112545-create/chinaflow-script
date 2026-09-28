-- ChinaFlow Outreach Attribution v1
-- Migration: 0016_outreach_attribution_v1.sql
-- Anonymous cold-outreach attribution only. No email/name/PII is stored here.

CREATE TABLE outreach_attributions (
    attribution_id TEXT NOT NULL PRIMARY KEY,
    token_hash TEXT NOT NULL,
    pipeline_prospect_id TEXT NOT NULL,
    campaign TEXT NOT NULL,
    first_click_at TEXT,
    last_click_at TEXT,
    click_count INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0),
    publisher_id TEXT,
    bound_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
        (publisher_id IS NULL AND bound_at IS NULL)
        OR (publisher_id IS NOT NULL AND bound_at IS NOT NULL)
    ),
    FOREIGN KEY (publisher_id)
        REFERENCES publishers (publisher_id)
        ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_outreach_attributions_token_hash
    ON outreach_attributions (token_hash);

CREATE UNIQUE INDEX ux_outreach_attributions_prospect_campaign
    ON outreach_attributions (pipeline_prospect_id, campaign);

CREATE UNIQUE INDEX ux_outreach_attributions_publisher
    ON outreach_attributions (publisher_id)
    WHERE publisher_id IS NOT NULL;

CREATE INDEX ix_outreach_attributions_campaign_click
    ON outreach_attributions (campaign, last_click_at);

PRAGMA optimize;
