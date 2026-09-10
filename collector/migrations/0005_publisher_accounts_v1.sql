-- ChinaFlow Publisher Accounts v1
-- Migration: 0005_publisher_accounts_v1.sql
--
-- Authentication/account foundation for Publisher Platform.
--
-- Security rules:
--   1. Never store plaintext magic-link or session tokens.
--   2. Store only cryptographic token hashes.
--   3. Email uniqueness is enforced on normalized email.
--   4. Membership explicitly defines publisher tenant ownership.
--   5. Additive schema only.

CREATE TABLE publisher_users (
    user_id TEXT NOT NULL PRIMARY KEY,

    email TEXT NOT NULL,
    email_normalized TEXT NOT NULL,

    display_name TEXT,

    user_status TEXT NOT NULL DEFAULT 'active'
        CHECK (
            user_status IN (
                'active',
                'disabled'
            )
        ),

    email_verified_at TEXT,
    last_login_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX ux_publisher_users_email_normalized
    ON publisher_users (email_normalized);

CREATE INDEX ix_publisher_users_status_created
    ON publisher_users (
        user_status,
        created_at
    );


CREATE TABLE publisher_memberships (
    membership_id TEXT NOT NULL PRIMARY KEY,

    publisher_id TEXT NOT NULL,
    user_id TEXT NOT NULL,

    role TEXT NOT NULL DEFAULT 'owner'
        CHECK (
            role IN (
                'owner',
                'admin',
                'member'
            )
        ),

    membership_status TEXT NOT NULL DEFAULT 'active'
        CHECK (
            membership_status IN (
                'active',
                'invited',
                'removed'
            )
        ),

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (publisher_id)
        REFERENCES publishers (publisher_id)
        ON DELETE RESTRICT,

    FOREIGN KEY (user_id)
        REFERENCES publisher_users (user_id)
        ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_publisher_memberships_publisher_user
    ON publisher_memberships (
        publisher_id,
        user_id
    );

CREATE INDEX ix_publisher_memberships_user_status
    ON publisher_memberships (
        user_id,
        membership_status
    );

CREATE INDEX ix_publisher_memberships_publisher_status
    ON publisher_memberships (
        publisher_id,
        membership_status
    );


CREATE TABLE publisher_magic_links (
    magic_link_id TEXT NOT NULL PRIMARY KEY,

    user_id TEXT NOT NULL,

    purpose TEXT NOT NULL
        CHECK (
            purpose IN (
                'login',
                'verify_email'
            )
        ),

    token_hash TEXT NOT NULL,

    expires_at TEXT NOT NULL,
    consumed_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES publisher_users (user_id)
        ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_publisher_magic_links_token_hash
    ON publisher_magic_links (token_hash);

CREATE INDEX ix_publisher_magic_links_user_created
    ON publisher_magic_links (
        user_id,
        created_at
    );

CREATE INDEX ix_publisher_magic_links_expiry
    ON publisher_magic_links (
        expires_at,
        consumed_at
    );


CREATE TABLE publisher_sessions (
    session_id TEXT NOT NULL PRIMARY KEY,

    user_id TEXT NOT NULL,

    token_hash TEXT NOT NULL,

    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    last_seen_at TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id)
        REFERENCES publisher_users (user_id)
        ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_publisher_sessions_token_hash
    ON publisher_sessions (token_hash);

CREATE INDEX ix_publisher_sessions_user_expiry
    ON publisher_sessions (
        user_id,
        expires_at
    );

PRAGMA optimize;
