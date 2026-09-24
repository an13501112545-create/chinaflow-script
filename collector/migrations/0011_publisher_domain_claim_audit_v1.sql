-- ChinaFlow Publisher Domain Claim Audit v1
-- Append-only security ledger for destructive hostname ownership transitions.

CREATE TABLE publisher_domain_claim_audit (
    audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id TEXT NOT NULL,
    publisher_id TEXT NOT NULL,
    hostname TEXT NOT NULL,
    actor_class TEXT NOT NULL
        CHECK (actor_class IN ('publisher_owner_session','claim_admin_api')),
    event_type TEXT NOT NULL
        CHECK (event_type IN ('owner_release','admin_revoke')),
    previous_claim_status TEXT NOT NULL
        CHECK (previous_claim_status = 'claimed'),
    new_claim_status TEXT NOT NULL
        CHECK (new_claim_status IN ('released','revoked')),
    verification_status TEXT NOT NULL
        CHECK (verification_status = 'verified'),
    monetization_status_before TEXT NOT NULL,
    monetization_status_after TEXT NOT NULL,
    claim_acquired_at TEXT NOT NULL,
    claim_ended_at TEXT NOT NULL,
    occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
        (event_type = 'owner_release' AND new_claim_status = 'released' AND actor_class = 'publisher_owner_session')
        OR
        (event_type = 'admin_revoke' AND new_claim_status = 'revoked' AND actor_class = 'claim_admin_api')
    )
);

CREATE INDEX ix_publisher_domain_claim_audit_publisher_time
    ON publisher_domain_claim_audit (publisher_id, occurred_at);

CREATE INDEX ix_publisher_domain_claim_audit_hostname_time
    ON publisher_domain_claim_audit (hostname, occurred_at);

CREATE TRIGGER tr_publisher_domain_claim_audit_append
AFTER UPDATE OF claim_status ON publisher_domains
WHEN OLD.claim_status = 'claimed'
 AND NEW.claim_status IN ('released','revoked')
BEGIN
    INSERT INTO publisher_domain_claim_audit (
        domain_id,
        publisher_id,
        hostname,
        actor_class,
        event_type,
        previous_claim_status,
        new_claim_status,
        verification_status,
        monetization_status_before,
        monetization_status_after,
        claim_acquired_at,
        claim_ended_at
    ) VALUES (
        NEW.domain_id,
        NEW.publisher_id,
        NEW.hostname,
        CASE NEW.claim_end_reason
            WHEN 'owner_release' THEN 'publisher_owner_session'
            WHEN 'admin_revoke' THEN 'claim_admin_api'
        END,
        NEW.claim_end_reason,
        OLD.claim_status,
        NEW.claim_status,
        NEW.verification_status,
        OLD.monetization_status,
        NEW.monetization_status,
        NEW.claim_acquired_at,
        NEW.claim_ended_at
    );
END;

CREATE TRIGGER tr_publisher_domain_claim_audit_no_update
BEFORE UPDATE ON publisher_domain_claim_audit
BEGIN
    SELECT RAISE(ABORT, 'publisher domain claim audit is append-only');
END;

CREATE TRIGGER tr_publisher_domain_claim_audit_no_delete
BEFORE DELETE ON publisher_domain_claim_audit
BEGIN
    SELECT RAISE(ABORT, 'publisher domain claim audit is append-only');
END;

PRAGMA optimize;
