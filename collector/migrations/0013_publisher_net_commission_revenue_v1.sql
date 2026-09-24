-- ChinaFlow Publisher Net Commission Revenue Ledger v1
-- Append-only accounting facts for commission revenue actually received and retained.
-- This migration does NOT infer facts from supplier commission reports, calculate
-- Publisher earnings, perform FX conversion, or create payout obligations.

CREATE UNIQUE INDEX ux_publisher_commercial_terms_id_publisher
    ON publisher_commercial_terms (commercial_terms_id, publisher_id);

CREATE TABLE publisher_net_commission_revenue (
    net_commission_entry_id TEXT NOT NULL PRIMARY KEY,
    publisher_id TEXT NOT NULL,
    commercial_terms_id TEXT NOT NULL,

    source TEXT NOT NULL
        CHECK (length(source) BETWEEN 1 AND 64),
    source_type TEXT NOT NULL
        CHECK (source_type IN ('supplier_settlement','reconciliation_adjustment')),
    source_reference TEXT NOT NULL
        CHECK (length(source_reference) BETWEEN 1 AND 512),

    settlement_period TEXT NOT NULL
        CHECK (
            length(settlement_period) = 7
            AND settlement_period GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
            AND substr(settlement_period, 6, 2) BETWEEN '01' AND '12'
        ),

    settlement_currency TEXT NOT NULL
        CHECK (
            length(settlement_currency) = 3
            AND settlement_currency = upper(settlement_currency)
            AND settlement_currency GLOB '[A-Z][A-Z][A-Z]'
        ),

    net_commission_revenue_micros INTEGER NOT NULL
        CHECK (net_commission_revenue_micros <> 0),

    recognized_at TEXT NOT NULL
        CHECK (julianday(recognized_at) IS NOT NULL),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (publisher_id)
        REFERENCES publishers (publisher_id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT,

    FOREIGN KEY (commercial_terms_id, publisher_id)
        REFERENCES publisher_commercial_terms (commercial_terms_id, publisher_id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX ux_publisher_net_commission_source_ref
    ON publisher_net_commission_revenue (
        publisher_id,
        source,
        source_type,
        source_reference
    );

CREATE INDEX ix_publisher_net_commission_period
    ON publisher_net_commission_revenue (
        publisher_id,
        settlement_period,
        recognized_at
    );

CREATE TRIGGER tr_publisher_net_commission_validate_terms
BEFORE INSERT ON publisher_net_commission_revenue
BEGIN
    SELECT CASE
        WHEN NEW.settlement_period <> strftime('%Y-%m', NEW.recognized_at)
        THEN RAISE(ABORT, 'net commission settlement period mismatch')
    END;

    SELECT CASE
        WHEN NOT EXISTS (
            SELECT 1
            FROM publisher_commercial_terms t
            WHERE t.commercial_terms_id = NEW.commercial_terms_id
              AND t.publisher_id = NEW.publisher_id
              AND t.settlement_currency = NEW.settlement_currency
              AND julianday(t.effective_from) <= julianday(NEW.recognized_at)
              AND NOT EXISTS (
                  SELECT 1
                  FROM publisher_commercial_terms newer
                  WHERE newer.publisher_id = t.publisher_id
                    AND julianday(newer.effective_from) <= julianday(NEW.recognized_at)
                    AND (
                        julianday(newer.effective_from) > julianday(t.effective_from)
                        OR (
                            julianday(newer.effective_from) = julianday(t.effective_from)
                            AND newer.created_at > t.created_at
                        )
                        OR (
                            julianday(newer.effective_from) = julianday(t.effective_from)
                            AND newer.created_at = t.created_at
                            AND newer.commercial_terms_id > t.commercial_terms_id
                        )
                    )
              )
        )
        THEN RAISE(ABORT, 'invalid net commission commercial terms snapshot')
    END;
END;

CREATE TRIGGER tr_publisher_net_commission_no_update
BEFORE UPDATE ON publisher_net_commission_revenue
BEGIN
    SELECT RAISE(ABORT, 'publisher net commission revenue is append-only');
END;

CREATE TRIGGER tr_publisher_net_commission_no_delete
BEFORE DELETE ON publisher_net_commission_revenue
BEGIN
    SELECT RAISE(ABORT, 'publisher net commission revenue is append-only');
END;

PRAGMA optimize;
