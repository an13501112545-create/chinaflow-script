ALTER TABLE publishers
    ADD COLUMN install_public_key TEXT;

CREATE UNIQUE INDEX ux_publishers_install_public_key
    ON publishers (install_public_key COLLATE BINARY);
