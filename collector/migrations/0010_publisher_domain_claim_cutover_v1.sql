-- ChinaFlow Publisher Domain Claim Cutover v1
-- Retire the E15 verified-hostname uniqueness guard only after claim-aware code.
--
-- Safety rule:
-- 0009 may be applied before claim-aware Workers are deployed. During that
-- rollout window, an older Worker can still create verification_status='verified'
-- with the new claim_status defaulting to 'unclaimed'. Preserve those legitimate
-- verified owners by compensating them into active claims before dropping the
-- legacy verified-hostname index.

UPDATE publisher_domains
SET claim_status = 'claimed',
    claim_acquired_at = COALESCE(
        claim_acquired_at,
        verified_at,
        last_seen_at,
        first_seen_at,
        updated_at,
        created_at
    ),
    claim_ended_at = NULL,
    claim_end_reason = NULL
WHERE verification_status = 'verified'
  AND claim_status = 'unclaimed';

DROP INDEX ux_publisher_domains_hostname;

PRAGMA optimize;
