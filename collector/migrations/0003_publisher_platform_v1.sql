-- ChinaFlow Publisher Platform v1
-- Migration: 0003_publisher_platform_v1.sql
--
-- Additive schema only.
-- Does NOT alter production routing, Trip.com URLs, existing events,
-- reporting facts, publisher_placements, or attribution.

CREATE TABLE publishers (
    publisher_id TEXT NOT NULL PRIMARY KEY,
    slug TEXT NOT NULL,
    display_name TEXT NOT NULL,
    country_code TEXT,

    account_status TEXT NOT NULL DEFAULT 'draft'
        CHECK (
            account_status IN (
                'draft',
                'pending_review',
                'active',
                'suspended',
                'rejected',
                'closed'
            )
        ),

    terms_version TEXT,
    terms_accepted_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ux_publishers_slug
    ON publishers (slug);

CREATE INDEX ix_publishers_status_created
    ON publishers (account_status, created_at);


CREATE TABLE publisher_domains (
    domain_id TEXT NOT NULL PRIMARY KEY,
    publisher_id TEXT NOT NULL,
    hostname TEXT NOT NULL,

    is_primary INTEGER NOT NULL DEFAULT 0
        CHECK (is_primary IN (0, 1)),

    install_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            install_status IN (
                'pending',
                'detected',
                'not_detected'
            )
        ),

    verification_status TEXT NOT NULL DEFAULT 'unverified'
        CHECK (
            verification_status IN (
                'unverified',
                'verified',
                'failed'
            )
        ),

    review_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            review_status IN (
                'pending',
                'approved',
                'rejected'
            )
        ),

    monetization_status TEXT NOT NULL DEFAULT 'disabled'
        CHECK (
            monetization_status IN (
                'disabled',
                'enabled',
                'paused'
            )
        ),

    first_seen_at TEXT,
    last_seen_at TEXT,
    verified_at TEXT,
    reviewed_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (publisher_id)
        REFERENCES publishers (publisher_id)
        ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_publisher_domains_hostname
    ON publisher_domains (hostname);

CREATE INDEX ix_publisher_domains_publisher
    ON publisher_domains (publisher_id, created_at);

CREATE UNIQUE INDEX ux_publisher_domains_domain_publisher
    ON publisher_domains (domain_id, publisher_id);

CREATE UNIQUE INDEX ux_publisher_domains_one_primary
    ON publisher_domains (publisher_id)
    WHERE is_primary = 1;

CREATE INDEX ix_publisher_domains_activation
    ON publisher_domains (
        verification_status,
        review_status,
        monetization_status
    );


CREATE TABLE publisher_supplier_sites (
    supplier_site_id TEXT NOT NULL PRIMARY KEY,

    publisher_id TEXT NOT NULL,
    domain_id TEXT NOT NULL,
    supplier TEXT NOT NULL,

    aid TEXT,
    sid TEXT,
    sid_name TEXT,

    provisioning_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            provisioning_status IN (
                'pending',
                'active',
                'failed',
                'disabled'
            )
        ),

    provisioned_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (publisher_id)
        REFERENCES publishers (publisher_id)
        ON DELETE RESTRICT,

    FOREIGN KEY (domain_id, publisher_id)
        REFERENCES publisher_domains (domain_id, publisher_id)
        ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_publisher_supplier_sites_supplier_sid
    ON publisher_supplier_sites (supplier, sid);

CREATE UNIQUE INDEX ux_publisher_supplier_sites_domain_supplier
    ON publisher_supplier_sites (domain_id, supplier);

CREATE INDEX ix_publisher_supplier_sites_publisher_status
    ON publisher_supplier_sites (
        publisher_id,
        supplier,
        provisioning_status
    );

PRAGMA optimize;
