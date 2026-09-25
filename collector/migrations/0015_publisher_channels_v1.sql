-- ChinaFlow Publisher Channels v1
-- Migration: 0015_publisher_channels_v1.sql
--
-- Unifies website links, agent booking, widgets, and future API traffic
-- under the existing publisher placement / attribution model.

ALTER TABLE publisher_placements
ADD COLUMN channel TEXT NOT NULL DEFAULT 'content'
    CHECK (channel IN ('content', 'agent_booking', 'widget', 'api'));

CREATE INDEX ix_publisher_placements_publisher_channel_active
    ON publisher_placements (publisher_id, channel, is_active);

CREATE TABLE publisher_channel_capabilities (
    capability_id TEXT NOT NULL PRIMARY KEY,
    publisher_id TEXT NOT NULL,
    channel TEXT NOT NULL
        CHECK (channel IN ('content', 'agent_booking', 'widget', 'api')),
    capability_status TEXT NOT NULL DEFAULT 'disabled'
        CHECK (capability_status IN ('enabled', 'disabled')),
    enabled_at TEXT,
    disabled_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (publisher_id)
        REFERENCES publishers (publisher_id)
        ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_publisher_channel_capabilities_publisher_channel
    ON publisher_channel_capabilities (publisher_id, channel);

CREATE INDEX ix_publisher_channel_capabilities_status
    ON publisher_channel_capabilities (channel, capability_status, publisher_id);

PRAGMA optimize;
