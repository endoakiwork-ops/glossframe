-- Add separate comprehension (known) and recall tracks, JST daily limit tracking,
-- word origin metadata, and cached cloze options without losing existing data.

ALTER TABLE words ADD COLUMN origin TEXT NOT NULL DEFAULT 'translation';
ALTER TABLE words ADD COLUMN known_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE words ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE words ADD COLUMN known_reviewed_day TEXT;
ALTER TABLE words ADD COLUMN recall_reviewed_day TEXT;
ALTER TABLE words ADD COLUMN cloze_options_json TEXT;

UPDATE words SET known_count = review_count WHERE known_count = 0 AND review_count > 0;

ALTER TABLE review_events ADD COLUMN mode TEXT NOT NULL DEFAULT 'card';
ALTER TABLE review_events ADD COLUMN assisted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE review_events ADD COLUMN gained INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS translation_regions (
  translation_id TEXT PRIMARY KEY REFERENCES translations(id) ON DELETE CASCADE,
  regions_json TEXT NOT NULL DEFAULT '[]'
);
