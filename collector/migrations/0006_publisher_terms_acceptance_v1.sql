-- Preserve the recorded accepting actor; historical acceptances remain unknown.
ALTER TABLE publishers ADD COLUMN terms_accepted_by_user_id TEXT
    REFERENCES publisher_users(user_id) ON DELETE RESTRICT ON UPDATE RESTRICT;
