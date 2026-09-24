-- ChinaFlow Publisher Earnings v1
-- Append-only earnings accrual from actual Net Commission Revenue only.
-- v0.1 is same-currency only and requires exact micro-unit share arithmetic.
-- No FX, rounding, payout scheduling, payment, or paid-state facts are created here.

CREATE TABLE publisher_earnings_entries (
    publisher_earnings_entry_id TEXT NOT NULL PRIMARY KEY,
    net_commission_entry_id TEXT NOT NULL,
    reconciliation_id TEXT NOT NULL,
    commission_fact_id TEXT NOT NULL,

    publisher_id TEXT NOT NULL,
    attributed_placement TEXT NOT NULL,
    commercial_terms_id TEXT NOT NULL,

    net_commission_revenue_currency TEXT NOT NULL
        CHECK (
            length(net_commission_revenue_currency) = 3
            AND net_commission_revenue_currency = upper(net_commission_revenue_currency)
            AND net_commission_revenue_currency GLOB '[A-Z][A-Z][A-Z]'
        ),
    net_commission_revenue_micros INTEGER NOT NULL
        CHECK (net_commission_revenue_micros <> 0),

    publisher_share_bps INTEGER NOT NULL
        CHECK (publisher_share_bps BETWEEN 0 AND 10000),
    earnings_currency TEXT NOT NULL
        CHECK (
            length(earnings_currency) = 3
            AND earnings_currency = upper(earnings_currency)
            AND earnings_currency GLOB '[A-Z][A-Z][A-Z]'
        ),
    publisher_earnings_micros INTEGER NOT NULL,

    settlement_cycle_month TEXT NOT NULL
        CHECK (
            length(settlement_cycle_month) = 7
            AND substr(settlement_cycle_month, 5, 1) = '-'
            AND substr(settlement_cycle_month, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'
            AND substr(settlement_cycle_month, 6, 2) BETWEEN '01' AND '12'
        ),

    effective_at TEXT NOT NULL
        CHECK (julianday(effective_at) IS NOT NULL),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (net_commission_entry_id)
        REFERENCES publisher_net_commission_revenue_entries (net_commission_entry_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (commercial_terms_id)
        REFERENCES publisher_commercial_terms (commercial_terms_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT,
    FOREIGN KEY (publisher_id)
        REFERENCES publishers (publisher_id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX ux_publisher_earnings_net_commission_entry
    ON publisher_earnings_entries (net_commission_entry_id);

CREATE INDEX ix_publisher_earnings_publisher_cycle
    ON publisher_earnings_entries (
        publisher_id,
        settlement_cycle_month,
        effective_at
    );

CREATE INDEX ix_publisher_earnings_commercial_terms
    ON publisher_earnings_entries (
        commercial_terms_id,
        effective_at
    );

CREATE TRIGGER tr_publisher_earnings_validate_basis
BEFORE INSERT ON publisher_earnings_entries
BEGIN
    SELECT RAISE(ABORT, 'invalid publisher earnings basis')
    WHERE NOT EXISTS (
        SELECT 1
        FROM publisher_net_commission_revenue_entries n
        JOIN publisher_commercial_terms t
          ON t.commercial_terms_id = NEW.commercial_terms_id
         AND t.publisher_id = NEW.publisher_id
        WHERE n.net_commission_entry_id = NEW.net_commission_entry_id
          AND n.reconciliation_id = NEW.reconciliation_id
          AND n.commission_fact_id = NEW.commission_fact_id
          AND n.publisher_id = NEW.publisher_id
          AND n.attributed_placement = NEW.attributed_placement
          AND n.currency = NEW.net_commission_revenue_currency
          AND n.net_commission_revenue_micros = NEW.net_commission_revenue_micros
          AND n.effective_at = NEW.effective_at
          AND t.publisher_share_bps = NEW.publisher_share_bps
          AND t.settlement_currency = NEW.earnings_currency
          AND t.settlement_currency = NEW.net_commission_revenue_currency
          AND julianday(t.effective_from) <= julianday(n.effective_at)
          AND NEW.settlement_cycle_month = strftime('%Y-%m', n.effective_at)
          AND ((n.net_commission_revenue_micros % 10000) * t.publisher_share_bps) % 10000 = 0
          AND NEW.publisher_earnings_micros =
              (n.net_commission_revenue_micros / 10000) * t.publisher_share_bps
              + ((n.net_commission_revenue_micros % 10000) * t.publisher_share_bps) / 10000
          AND NOT EXISTS (
              SELECT 1
              FROM publisher_commercial_terms newer
              WHERE newer.publisher_id = t.publisher_id
                AND julianday(newer.effective_from) <= julianday(n.effective_at)
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
    );
END;

CREATE TRIGGER tr_publisher_commercial_terms_no_retroactive_earnings
BEFORE INSERT ON publisher_commercial_terms
BEGIN
    SELECT RAISE(ABORT, 'commercial terms cannot retroactively change accrued earnings')
    WHERE EXISTS (
        SELECT 1
        FROM publisher_earnings_entries e
        WHERE e.publisher_id = NEW.publisher_id
          AND julianday(e.effective_at) >= julianday(NEW.effective_from)
    );
END;

CREATE TRIGGER tr_publisher_earnings_no_update
BEFORE UPDATE ON publisher_earnings_entries
BEGIN
    SELECT RAISE(ABORT, 'publisher earnings are append-only');
END;

CREATE TRIGGER tr_publisher_earnings_no_delete
BEFORE DELETE ON publisher_earnings_entries
BEGIN
    SELECT RAISE(ABORT, 'publisher earnings are append-only');
END;

PRAGMA optimize;
