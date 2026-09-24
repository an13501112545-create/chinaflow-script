-- ChinaFlow Publisher Commercial Terms v1
-- Append-only commercial term versions. No earnings or payout facts are created here.
-- Standard v1 terms: Publisher 70%, USD monthly settlement, US$100 regular threshold,
-- payable within 30 days after the applicable monthly settlement cycle.

CREATE TABLE publisher_commercial_terms (
    commercial_terms_id TEXT NOT NULL PRIMARY KEY,
    publisher_id TEXT NOT NULL,

    terms_source TEXT NOT NULL
        CHECK (terms_source IN ('standard_terms','account_specific')),
    terms_reference TEXT NOT NULL
        CHECK (length(terms_reference) BETWEEN 1 AND 512),

    publisher_share_bps INTEGER NOT NULL
        CHECK (publisher_share_bps BETWEEN 0 AND 10000),

    settlement_currency TEXT NOT NULL
        CHECK (
            length(settlement_currency) = 3
            AND settlement_currency = upper(settlement_currency)
            AND settlement_currency GLOB '[A-Z][A-Z][A-Z]'
        ),

    minimum_payout_micros INTEGER NOT NULL
        CHECK (minimum_payout_micros >= 0),

    settlement_cycle TEXT NOT NULL
        CHECK (settlement_cycle = 'monthly'),

    payout_days_after_cycle_end INTEGER NOT NULL
        CHECK (payout_days_after_cycle_end BETWEEN 0 AND 365),

    effective_from TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (publisher_id)
        REFERENCES publishers (publisher_id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX ux_publisher_commercial_terms_publisher_effective
    ON publisher_commercial_terms (publisher_id, effective_from);

CREATE INDEX ix_publisher_commercial_terms_publisher_current
    ON publisher_commercial_terms (publisher_id, effective_from DESC, created_at DESC);

-- Backfill publishers that already accepted the immutable v1 Publisher Terms.
INSERT INTO publisher_commercial_terms (
    commercial_terms_id,
    publisher_id,
    terms_source,
    terms_reference,
    publisher_share_bps,
    settlement_currency,
    minimum_payout_micros,
    settlement_cycle,
    payout_days_after_cycle_end,
    effective_from
)
SELECT
    'pct_v1_' || p.publisher_id,
    p.publisher_id,
    'standard_terms',
    'chinaflow-publisher-terms-v1',
    7000,
    'USD',
    100000000,
    'monthly',
    30,
    p.terms_accepted_at
FROM publishers p
WHERE p.terms_version = 'chinaflow-publisher-terms-v1'
  AND p.terms_accepted_at IS NOT NULL
  AND p.terms_accepted_by_user_id IS NOT NULL;

-- Future first-time v1 acceptances create the same standard commercial term version
-- atomically inside the publisher acceptance UPDATE statement.
CREATE TRIGGER tr_publishers_standard_commercial_terms_v1
AFTER UPDATE OF terms_version, terms_accepted_at, terms_accepted_by_user_id ON publishers
WHEN OLD.terms_version IS NULL
 AND OLD.terms_accepted_at IS NULL
 AND OLD.terms_accepted_by_user_id IS NULL
 AND NEW.terms_version = 'chinaflow-publisher-terms-v1'
 AND NEW.terms_accepted_at IS NOT NULL
 AND NEW.terms_accepted_by_user_id IS NOT NULL
BEGIN
    INSERT INTO publisher_commercial_terms (
        commercial_terms_id,
        publisher_id,
        terms_source,
        terms_reference,
        publisher_share_bps,
        settlement_currency,
        minimum_payout_micros,
        settlement_cycle,
        payout_days_after_cycle_end,
        effective_from
    ) VALUES (
        'pct_v1_' || NEW.publisher_id,
        NEW.publisher_id,
        'standard_terms',
        'chinaflow-publisher-terms-v1',
        7000,
        'USD',
        100000000,
        'monthly',
        30,
        NEW.terms_accepted_at
    );
END;

CREATE TRIGGER tr_publisher_commercial_terms_no_update
BEFORE UPDATE ON publisher_commercial_terms
BEGIN
    SELECT RAISE(ABORT, 'publisher commercial terms are append-only');
END;

CREATE TRIGGER tr_publisher_commercial_terms_no_delete
BEFORE DELETE ON publisher_commercial_terms
BEGIN
    SELECT RAISE(ABORT, 'publisher commercial terms are append-only');
END;

PRAGMA optimize;
