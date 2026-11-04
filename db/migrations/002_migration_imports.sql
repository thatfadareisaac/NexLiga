CREATE TABLE IF NOT EXISTS migration_imports (
  source_hash TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL DEFAULT (NOW()::text)
);

ALTER TABLE migration_imports ENABLE ROW LEVEL SECURITY;
