-- Workers AI reports the Neurons each call consumed; store them so usage is
-- measured rather than estimated from token counts. 0 means "not reported".
ALTER TABLE ai_usage ADD COLUMN neurons REAL NOT NULL DEFAULT 0;
