-- ChinaFlow Publisher Reporting v0.1
-- Seed: FlightFlex test Trip.com publisher placements
--
-- TEST ENVIRONMENT ONLY.
--
-- Idempotent replay:
--   external_tracking_key is the Trip.com trip_sub1 attribution key.
--   Existing matching placement IDs are updated in place.
--   Conflicting publisher/placement uniqueness violations must fail loudly.

INSERT INTO publisher_placements (
    placement_id,
    publisher_id,
    placement,
    supplier,
    external_tracking_key,
    is_active
)
VALUES
    (
        'flightflex_test_auto_china_flights_generic',
        'flightflex',
        'flightflex_auto_china_flights_generic_test',
        'trip.com',
        'flightflex_auto_china_flights_generic_test',
        1
    ),
    (
        'flightflex_test_collector_manual',
        'flightflex',
        'flightflex_collector_manual_test',
        'trip.com',
        'flightflex_collector_manual_test',
        1
    ),
    (
        'flightflex_test_flights_yyz_bjs',
        'flightflex',
        'flightflex_flights_yyz_bjs_test',
        'trip.com',
        'flightflex_flights_yyz_bjs_test',
        1
    )
ON CONFLICT(placement_id) DO UPDATE SET
    publisher_id = excluded.publisher_id,
    placement = excluded.placement,
    supplier = excluded.supplier,
    external_tracking_key = excluded.external_tracking_key,
    is_active = excluded.is_active,
    updated_at = CURRENT_TIMESTAMP;
