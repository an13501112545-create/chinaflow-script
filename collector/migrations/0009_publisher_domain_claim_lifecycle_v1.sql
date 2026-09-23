-- ChinaFlow Publisher Domain Claim Lifecycle v1
-- Additive phase only: preserve the E15 verified-hostname unique index.
-- Current ownership is separated from historical verification evidence.

ALTER TABLE publisher_domains
    ADD COLUMN claim_status TEXT NOT NULL DEFAULT 'unclaimed'
        CHECK (
            claim_status IN ('unclaimed','claimed','released','revoked')
            AND (
                claim_status = 'unclaimed'
                OR verification_status = 'verified'
            )
        );

ALTER TABLE publisher_domains
    ADD COLUMN claim_acquired_at TEXT
        CHECK (
            (claim_status = 'unclaimed' AND claim_acquired_at IS NULL)
            OR (
                claim_status IN ('claimed','released','revoked')
                AND claim_acquired_at IS NOT NULL
            )
        );

ALTER TABLE publisher_domains
    ADD COLUMN claim_ended_at TEXT
        CHECK (
            (claim_status IN ('unclaimed','claimed') AND claim_ended_at IS NULL)
            OR (
                claim_status IN ('released','revoked')
                AND claim_ended_at IS NOT NULL
            )
        );

ALTER TABLE publisher_domains
    ADD COLUMN claim_end_reason TEXT
        CHECK (
            (claim_status IN ('unclaimed','claimed') AND claim_end_reason IS NULL)
            OR (claim_status = 'released' AND claim_end_reason = 'owner_release')
            OR (claim_status = 'revoked' AND claim_end_reason = 'admin_revoke')
        );

UPDATE publisher_domains
SET claim_status = 'claimed',
    claim_acquired_at = COALESCE(
        verified_at,last_seen_at,first_seen_at,updated_at,created_at
    )
WHERE verification_status = 'verified';

CREATE UNIQUE INDEX ux_publisher_domains_claimed_hostname
    ON publisher_domains (hostname)
    WHERE claim_status = 'claimed';

PRAGMA optimize;
