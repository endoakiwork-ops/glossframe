CREATE TABLE IF NOT EXISTS used_recovery_tokens (
  token_hash TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);
