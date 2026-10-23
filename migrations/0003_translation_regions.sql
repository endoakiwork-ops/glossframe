-- Region overlays are optional, and only stored when source/translation alignment is exact.
CREATE TABLE IF NOT EXISTS translation_regions (
  translation_id TEXT PRIMARY KEY REFERENCES translations(id) ON DELETE CASCADE,
  regions_json TEXT NOT NULL DEFAULT '[]'
);
