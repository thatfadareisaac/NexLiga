import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const migrationNamePattern = /^\d{3}_[a-z0-9_]+\.sql$/;
const lockClass = 1_314_841_938;
const lockObject = 1;

function migrationChecksums(sql) {
  const normalizedSql = sql.replace(/\r\n/g, '\n');
  return {
    checksum: createHash('sha256').update(normalizedSql).digest('hex'),
    windowsChecksum: createHash('sha256')
      .update(normalizedSql.replace(/\n/g, '\r\n'))
      .digest('hex'),
  };
}

export async function runMigrations(pool) {
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  if (migrationNames.some((name) => !migrationNamePattern.test(name))) {
    throw new Error('Database migration filenames must use NNN_lowercase_name.sql format.');
  }

  const client = await pool.connect();
  let lockAcquired = false;
  try {
    await client.query('SELECT pg_advisory_lock($1, $2)', [lockClass, lockObject]);
    lockAcquired = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query('ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY');

    for (const name of migrationNames) {
      const sql = await readFile(join(migrationsDirectory, name), 'utf8');
      const { checksum, windowsChecksum } = migrationChecksums(sql);
      const existing = await client.query(
        'SELECT checksum FROM schema_migrations WHERE version=$1',
        [name]
      );
      if (existing.rowCount) {
        if (existing.rows[0].checksum !== checksum) {
          if (existing.rows[0].checksum !== windowsChecksum) {
            throw new Error(
              `Applied database migration ${name} was changed. Add a new migration instead.`
            );
          }
          await client.query('UPDATE schema_migrations SET checksum=$1 WHERE version=$2', [
            checksum,
            name,
          ]);
        }
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version, checksum) VALUES($1, $2)', [
          name,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    try {
      if (lockAcquired) {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [lockClass, lockObject]);
      }
    } finally {
      client.release();
    }
  }
}
