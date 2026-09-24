-- ChinaFlow Publisher Reconciliation + Net Commission Revenue v1
-- Supplier-reported commission facts remain separate from internal Approved Commission
-- decisions and from actual received/retained Net Commission Revenue accounting facts.
-- No Publisher earnings, FX conversion, or payout obligation is calculated here.

CREATE UNIQUE INDEX ux_trip_commissions_fact_record_key
    ON trip_commissions (commission_fact_id, commission_record_key);

CREATE TABLE publisher_commission_reconciliations (
    reconciliation_id TEXT NOT NULL PRIMARY KEY,
    commission_fact_id TEXT NOT NULL,
    commission_record_key TEXT NOT NULL,

    publisher_id TEXT NOT NULL,
    attributed_placement TEXT NOT NULL,

    decision TEXT NOT NULL
        CHECK (decision IN ('approved','reversed')),

    supplier_commission_amount_micros_snapshot INTEGER,
    supplier_currency_snapshot TEXT
        CHECK (
            supplier_currency_snapshot IS NULL
            OR (
                length(supplier_currency_snapshot) = 3
                AND supplier_currency_snapshot = upper(supplier_currency_snapshot)
                AND supplier_currency_snapshot GLOB '[A-Z][A-Z][A-Z]'
            )
        ),

    approved_commission_micros INTEGER NOT NULL
        CHECK (approved_commission_micros <> 0),
    approved_currency TEXT NOT NULL
        CHECK (
            length(approved_currency) = 3
            AND approved_currency = upper(approved_currency)
            AND approved_currency GLOB '[A-Z][A-Z][A-Z]'
        ),

    evidence_reference TEXT NOT NULL
        CHECK (length(evidence_reference) BETWEEN 1 AND 512),
    effective_at TEXT NOT NULL
        CHECK (julianday(effective_at) IS NOT NULL),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (commission_fact_id, commission_record_key)
        REFERENCES trip_commissions (commission_fact_id, commission_record_key)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT,
    FOREIGN KEY (publisher_id)
        REFERENCES publishers (publisher_id)
        ON DELETE RESTRICT
        ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX ux_publisher_commission_reconciliation_evidence
    ON publisher_commission_reconciliations (
        commission_fact_id,
        evidence_reference
    );

CREATE INDEX ix_publisher_commission_reconciliation_current
    ON publisher_commission_reconciliations (
        commission_fact_id,
        effective_at DESC,
        created_at DESC,
        reconciliation_id DESC
    );

CREATE INDEX ix_publisher_commission_reconciliation_publisher
    ON publisher_commission_reconciliations (
        publisher_id,
        effective_at
    );

CREATE TRIGGER tr_publisher_commission_reconciliation_validate_fact
BEFORE INSERT ON publisher_commission_reconciliations
BEGIN
    SELECT RAISE(ABORT, 'invalid commission reconciliation fact snapshot')
    WHERE NOT EXISTS (
        SELECT 1
        FROM trip_commissions c
        WHERE c.commission_fact_id = NEW.commission_fact_id
          AND c.commission_record_key = NEW.commission_record_key
          AND c.attribution_status = 'matched'
          AND c.attributed_publisher_id = NEW.publisher_id
          AND c.attributed_placement = NEW.attributed_placement
          AND c.commission_amount_micros IS NEW.supplier_commission_amount_micros_snapshot
          AND c.currency IS NEW.supplier_currency_snapshot
    );
END;

CREATE TRIGGER tr_publisher_commission_reconciliation_no_update
BEFORE UPDATE ON publisher_commission_reconciliations
BEGIN
    SELECT RAISE(ABORT, 'publisher commission reconciliation is append-only');
END;

CREATE TRIGGER tr_publisher_commission_reconciliation_no_delete
BEFORE DELETE ON publisher_commission_reconciliations
BEGIN
    SELECT RAISE(ABORT, 'publisher commission reconciliation is append-only');
END;

CREATE UNIQUE INDEX ux_publisher_reconciliation_identity
    ON publisher_commission_reconciliations (
        reconciliation_id,
        publisher_id,
        commission_fact_id,
        attributed_placement
    );

CREATE TABLE publisher_net_commission_revenue_entries (
    net_commission_entry_id TEXT NOT NULL PRIMARY KEY,
    reconciliation_id TEXT NOT NULL,
    commission_fact_id TEXT NOT NULL,

    publisher_id TEXT NOT NULL,
    attributed_placement TEXT NOT NULL,

    evidence_type TEXT NOT NULL
        CHECK (evidence_type IN ('supplier_settlement','reconciliation_adjustment')),
    evidence_reference TEXT NOT NULL
        CHECK (length(evidence_reference) BETWEEN 1 AND 512),

    currency TEXT NOT NULL
        CHECK (
            length(currency) = 3
            AND currency = upper(currency)
            AND currency GLOB '[A-Z][A-Z][A-Z]'
        ),
    net_commission_revenue_micros INTEGER NOT NULL
        CHECK (net_commission_revenue_micros <> 0),

    effective_at TEXT NOT NULL
        CHECK (julianday(effective_at) IS NOT NULL),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (
        reconciliation_id,
        publisher_id,
        commission_fact_id,
        attributed_placement
    ) REFERENCES publisher_commission_reconciliations (
        reconciliation_id,
        publisher_id,
        commission_fact_id,
        attributed_placement
    ) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX ux_publisher_net_commission_revenue_evidence
    ON publisher_net_commission_revenue_entries (
        publisher_id,
        evidence_type,
        evidence_reference
    );

CREATE INDEX ix_publisher_net_commission_revenue_publisher_effective
    ON publisher_net_commission_revenue_entries (
        publisher_id,
        effective_at
    );

CREATE INDEX ix_publisher_net_commission_revenue_reconciliation
    ON publisher_net_commission_revenue_entries (
        reconciliation_id,
        effective_at
    );

CREATE TRIGGER tr_publisher_net_commission_revenue_validate_approval
BEFORE INSERT ON publisher_net_commission_revenue_entries
BEGIN
    SELECT RAISE(ABORT, 'net commission revenue requires latest approved reconciliation')
    WHERE NOT EXISTS (
        SELECT 1
        FROM publisher_commission_reconciliations r
        WHERE r.reconciliation_id = NEW.reconciliation_id
          AND r.publisher_id = NEW.publisher_id
          AND r.commission_fact_id = NEW.commission_fact_id
          AND r.attributed_placement = NEW.attributed_placement
          AND r.decision = 'approved'
          AND NOT EXISTS (
              SELECT 1
              FROM publisher_commission_reconciliations newer
              WHERE newer.commission_fact_id = r.commission_fact_id
                AND (
                    julianday(newer.effective_at) > julianday(r.effective_at)
                    OR (
                        julianday(newer.effective_at) = julianday(r.effective_at)
                        AND newer.created_at > r.created_at
                    )
                    OR (
                        julianday(newer.effective_at) = julianday(r.effective_at)
                        AND newer.created_at = r.created_at
                        AND newer.reconciliation_id > r.reconciliation_id
                    )
                )
          )
    );
END;

CREATE TRIGGER tr_publisher_net_commission_revenue_no_update
BEFORE UPDATE ON publisher_net_commission_revenue_entries
BEGIN
    SELECT RAISE(ABORT, 'publisher net commission revenue is append-only');
END;

CREATE TRIGGER tr_publisher_net_commission_revenue_no_delete
BEFORE DELETE ON publisher_net_commission_revenue_entries
BEGIN
    SELECT RAISE(ABORT, 'publisher net commission revenue is append-only');
END;

PRAGMA optimize;
