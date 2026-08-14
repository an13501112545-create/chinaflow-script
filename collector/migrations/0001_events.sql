CREATE TABLE IF NOT EXISTS events (
  event_id TEXT NOT NULL PRIMARY KEY,
  event_schema_version TEXT NOT NULL,
  event_type TEXT NOT NULL,

  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

  publisher_id TEXT NOT NULL,
  session_id TEXT NOT NULL,

  page_url TEXT NOT NULL,
  page_path TEXT,
  page_title TEXT,
  referrer TEXT,

  routing_mode TEXT NOT NULL,

  china_intent INTEGER,
  china_intent_score INTEGER,

  product_intent TEXT,
  product_score INTEGER,

  routing_reason TEXT,

  rule_id TEXT,
  offer_id TEXT,

  placement TEXT NOT NULL,
  trip_sub1 TEXT,

  supplier TEXT,

  destination_url TEXT NOT NULL,

  engine_version TEXT NOT NULL,
  config_version TEXT NOT NULL,

  viewport_width INTEGER,
  viewport_height INTEGER,

  external_attribution_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_publisher_occurred_at
ON events (publisher_id, occurred_at);

CREATE INDEX IF NOT EXISTS idx_events_placement_occurred_at
ON events (placement, occurred_at);

CREATE INDEX IF NOT EXISTS idx_events_session_id
ON events (session_id);
