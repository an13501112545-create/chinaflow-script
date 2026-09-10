-- ChinaFlow Publisher Supplier Offers v1
-- Migration: 0004_publisher_supplier_offers_v1.sql
--
-- Stores exact supplier-provided affiliate URLs used by the
-- dynamic publisher config builder.
--
-- publisher_placements remains the authoritative attribution map.

CREATE UNIQUE INDEX ux_publisher_supplier_sites_site_tenant
    ON publisher_supplier_sites (
        supplier_site_id,
        publisher_id,
        domain_id
    );

CREATE UNIQUE INDEX ux_publisher_placements_id_publisher
    ON publisher_placements (
        placement_id,
        publisher_id
    );

CREATE TABLE publisher_supplier_offers (
    supplier_offer_id TEXT NOT NULL PRIMARY KEY,

    supplier_site_id TEXT NOT NULL,
    publisher_id TEXT NOT NULL,
    domain_id TEXT NOT NULL,

    offer_key TEXT NOT NULL,
    product TEXT NOT NULL
        CHECK (product IN ('hotel', 'flight')),

    placement_id TEXT NOT NULL,

    affiliate_url TEXT NOT NULL,

    is_active INTEGER NOT NULL DEFAULT 1
        CHECK (is_active IN (0, 1)),

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (
        supplier_site_id,
        publisher_id,
        domain_id
    )
        REFERENCES publisher_supplier_sites (
            supplier_site_id,
            publisher_id,
            domain_id
        )
        ON DELETE RESTRICT,

    FOREIGN KEY (
        placement_id,
        publisher_id
    )
        REFERENCES publisher_placements (
            placement_id,
            publisher_id
        )
        ON DELETE RESTRICT,

    FOREIGN KEY (
        domain_id,
        publisher_id
    )
        REFERENCES publisher_domains (
            domain_id,
            publisher_id
        )
        ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_publisher_supplier_offers_site_key
    ON publisher_supplier_offers (
        supplier_site_id,
        offer_key
    );

CREATE INDEX ix_publisher_supplier_offers_site_active
    ON publisher_supplier_offers (
        supplier_site_id,
        is_active
    );

CREATE INDEX ix_publisher_supplier_offers_publisher_product
    ON publisher_supplier_offers (
        publisher_id,
        product,
        is_active
    );

PRAGMA optimize;
