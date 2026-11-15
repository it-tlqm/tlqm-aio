-- Existing sessions keep their original maximum; only a new login obtains a longer lifetime.
ALTER TABLE sessions ADD COLUMN absolute_expires_at timestamptz;
UPDATE sessions SET absolute_expires_at=expires_at;
ALTER TABLE sessions ALTER COLUMN absolute_expires_at SET NOT NULL;
ALTER TABLE sessions ADD CONSTRAINT session_idle_within_absolute CHECK (expires_at<=absolute_expires_at);
