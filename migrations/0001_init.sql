PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent TEXT,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_lang TEXT NOT NULL DEFAULT 'en',
  target_lang TEXT NOT NULL DEFAULT 'ja',
  save_images INTEGER NOT NULL DEFAULT 1,
  review_interval_days INTEGER NOT NULL DEFAULT 7,
  review_target_count INTEGER NOT NULL DEFAULT 3,
  review_batch_size INTEGER NOT NULL DEFAULT 20,
  review_show_image INTEGER NOT NULL DEFAULT 1,
  review_order TEXT NOT NULL DEFAULT 'due',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO settings
  (id, source_lang, target_lang, save_images, review_interval_days, review_target_count,
   review_batch_size, review_show_image, review_order, created_at, updated_at)
VALUES
  (1, 'en', 'ja', 1, 7, 3, 20, 1, 'due', CAST(strftime('%s','now') AS INTEGER) * 1000,
   CAST(strftime('%s','now') AS INTEGER) * 1000);

CREATE TABLE IF NOT EXISTS translations (
  id TEXT PRIMARY KEY,
  source_text TEXT NOT NULL,
  translated_text TEXT NOT NULL,
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  segments_json TEXT NOT NULL DEFAULT '[]',
  grammar_notes_json TEXT NOT NULL DEFAULT '[]',
  key_phrases_json TEXT NOT NULL DEFAULT '[]',
  image_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_translations_created ON translations(created_at DESC);

CREATE TABLE IF NOT EXISTS words (
  id TEXT PRIMARY KEY,
  term TEXT NOT NULL,
  normalized_term TEXT NOT NULL,
  base_form TEXT,
  part_of_speech TEXT,
  meaning TEXT NOT NULL,
  source_lang TEXT NOT NULL,
  target_lang TEXT NOT NULL,
  review_count INTEGER NOT NULL DEFAULT 0,
  mastered INTEGER NOT NULL DEFAULT 0,
  next_review_at INTEGER,
  last_reviewed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_words_unique
  ON words(normalized_term, source_lang, target_lang);
CREATE INDEX IF NOT EXISTS idx_words_due ON words(mastered, next_review_at);

CREATE TABLE IF NOT EXISTS word_examples (
  id TEXT PRIMARY KEY,
  word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  translation_id TEXT,
  source_text TEXT NOT NULL,
  translated_text TEXT NOT NULL DEFAULT '',
  context_meaning TEXT,
  grammar_note TEXT,
  image_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_examples_word ON word_examples(word_id, created_at DESC);

CREATE TABLE IF NOT EXISTS review_events (
  id TEXT PRIMARY KEY,
  word_id TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
  rating TEXT NOT NULL CHECK (rating IN ('known', 'unknown')),
  review_count_after INTEGER NOT NULL,
  reviewed_at INTEGER NOT NULL,
  next_review_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_review_events_word ON review_events(word_id, reviewed_at DESC);

CREATE TABLE IF NOT EXISTS images (
  key TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_images_sha ON images(sha256);

CREATE TABLE IF NOT EXISTS ai_cache (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_cache_expires ON ai_cache(expires_at);

CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage(created_at);

CREATE TABLE IF NOT EXISTS auth_attempts (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  success INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts ON auth_attempts(ip_hash, created_at);
