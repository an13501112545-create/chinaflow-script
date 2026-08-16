-- ChinaFlow Publisher Reporting v0.1
-- Migration: 0002_publisher_reporting_v0_1.sql
--
-- Scope:
--   1. Keep existing events table unchanged.
--   2. Add publisher attribution ownership.
--   3. Add Trip booking current-state facts.
--   4. Add Trip commission current-state facts.
--   5. Add report ingestion audit ledger.
--
-- IMPORTANT:
--   This migration creates schema only.
--   It does not seed production publisher mappings.
--   It does not modify existing event data.


-- ============================================================
-- 1. Publisher placement ownership
-- ============================================================

CREATE TABLE publisher_placements (
    placement_id TEXT NOT NULL PRIMARY KEY,

    publisher_id TEXT NOT NULL,
    placement TEXT NOT NULL,

    supplier TEXT NOT NULL,
    external_tracking_key TEXT NOT NULL,

    is_active INTEGER NOT NULL DEFAULT 1
        CHECK (is_active IN (0, 1)),

    effective_from TEXT,
    effective_to TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ux_publisher_placements_publisher_placement
    ON publisher_placements (
        publisher_id,
        placement
    );

CREATE UNIQUE INDEX ux_publisher_placements_supplier_tracking
    ON publisher_placements (
        supplier,
        external_tracking_key
    );

CREATE INDEX ix_publisher_placements_publisher_active
    ON publisher_placements (
        publisher_id,
        is_active
    );


-- ============================================================
-- 2. Report ingestion audit ledger
-- ============================================================

CREATE TABLE report_ingestion_runs (
    ingestion_run_id TEXT NOT NULL PRIMARY KEY,

    source TEXT NOT NULL,
    report_type TEXT NOT NULL,

    report_period_from TEXT,
    report_period_to TEXT,

    source_filename TEXT,
    source_file_sha256 TEXT NOT NULL,

    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,

    rows_seen INTEGER NOT NULL DEFAULT 0,
    rows_inserted INTEGER NOT NULL DEFAULT 0,
    rows_updated INTEGER NOT NULL DEFAULT 0,
    rows_unchanged INTEGER NOT NULL DEFAULT 0,
    rows_rejected INTEGER NOT NULL DEFAULT 0,

    status TEXT NOT NULL,
    error_summary TEXT
);

CREATE UNIQUE INDEX ux_report_ingestion_runs_source_file
    ON report_ingestion_runs (
        source,
        report_type,
        source_file_sha256
    );

CREATE INDEX ix_report_ingestion_runs_status_started
    ON report_ingestion_runs (
        status,
        started_at
    );


-- ============================================================
-- 3. Trip booking current-state facts
-- ============================================================

CREATE TABLE trip_bookings (
    booking_fact_id TEXT NOT NULL PRIMARY KEY,

    source_record_key TEXT NOT NULL,

    source TEXT NOT NULL,
    source_order_id TEXT NOT NULL,

    aid TEXT,
    sid TEXT,
    sid_name TEXT,

    source_row_hash TEXT NOT NULL,

    trip_sub1 TEXT,
    trip_sub3 TEXT,

    attributed_publisher_id TEXT,
    attributed_placement TEXT,
    attribution_status TEXT NOT NULL,

    raw_product_line TEXT,
    normalized_product TEXT,

    raw_order_status TEXT,
    normalized_order_status TEXT,

    booking_amount_raw TEXT,
    booking_amount_micros INTEGER,
    currency TEXT,

    order_date TEXT,
    product_start_date TEXT,
    product_end_date TEXT,
    booking_window TEXT,

    departure_city TEXT,
    departure_country TEXT,
    arrival_city TEXT,
    arrival_country TEXT,

    order_platform TEXT,
    booker_region TEXT,

    ouid TEXT,

    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,

    first_ingestion_run_id TEXT NOT NULL,
    last_ingestion_run_id TEXT NOT NULL,

    source_ingested_at TEXT NOT NULL,
    raw_payload_json TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_trip_bookings_source_record_key
    ON trip_bookings (
        source_record_key
    );

CREATE INDEX ix_trip_bookings_publisher_order_date
    ON trip_bookings (
        attributed_publisher_id,
        order_date
    );

CREATE INDEX ix_trip_bookings_trip_sub1_order_date
    ON trip_bookings (
        trip_sub1,
        order_date
    );

CREATE INDEX ix_trip_bookings_source_order_id
    ON trip_bookings (
        source_order_id
    );

CREATE INDEX ix_trip_bookings_status_order_date
    ON trip_bookings (
        raw_order_status,
        order_date
    );

CREATE INDEX ix_trip_bookings_last_ingestion_run
    ON trip_bookings (
        last_ingestion_run_id
    );

CREATE INDEX ix_trip_bookings_source_ingested_at
    ON trip_bookings (
        source_ingested_at
    );


-- ============================================================
-- 4. Trip commission current-state facts
-- ============================================================

CREATE TABLE trip_commissions (
    commission_fact_id TEXT NOT NULL PRIMARY KEY,

    commission_record_key TEXT NOT NULL,

    source TEXT NOT NULL,
    source_order_id TEXT NOT NULL,

    aid TEXT,
    sid TEXT,
    sid_name TEXT,

    source_row_hash TEXT NOT NULL,

    trip_sub1 TEXT,
    trip_sub3 TEXT,

    attributed_publisher_id TEXT,
    attributed_placement TEXT,
    attribution_status TEXT NOT NULL,

    raw_product_line TEXT,
    normalized_product TEXT,
    sub_order_type TEXT,

    raw_order_status TEXT,
    normalized_order_status TEXT,

    raw_commission_status TEXT,
    normalized_commission_status TEXT,

    booking_amount_raw TEXT,
    booking_amount_micros INTEGER,

    commission_amount_raw TEXT,
    commission_amount_micros INTEGER,

    currency TEXT,

    commission_month TEXT NOT NULL,
    order_date TEXT,
    check_out_or_issue_date TEXT,

    ratio_raw TEXT,
    plan_type TEXT,

    region TEXT,

    ouid TEXT,

    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,

    first_ingestion_run_id TEXT NOT NULL,
    last_ingestion_run_id TEXT NOT NULL,

    source_ingested_at TEXT NOT NULL,
    raw_payload_json TEXT NOT NULL
);

CREATE UNIQUE INDEX ux_trip_commissions_record_key
    ON trip_commissions (
        commission_record_key
    );

CREATE INDEX ix_trip_commissions_publisher_month
    ON trip_commissions (
        attributed_publisher_id,
        commission_month
    );

CREATE INDEX ix_trip_commissions_source_order_id
    ON trip_commissions (
        source_order_id
    );

CREATE INDEX ix_trip_commissions_trip_sub1_month
    ON trip_commissions (
        trip_sub1,
        commission_month
    );

CREATE INDEX ix_trip_commissions_status_month
    ON trip_commissions (
        raw_commission_status,
        commission_month
    );

CREATE INDEX ix_trip_commissions_last_ingestion_run
    ON trip_commissions (
        last_ingestion_run_id
    );

CREATE INDEX ix_trip_commissions_source_ingested_at
    ON trip_commissions (
        source_ingested_at
    );


PRAGMA optimize;
