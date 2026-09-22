DROP INDEX ux_publisher_domains_hostname;

CREATE UNIQUE INDEX ux_publisher_domains_hostname
    ON publisher_domains (hostname)
    WHERE verification_status = 'verified';

PRAGMA optimize;
