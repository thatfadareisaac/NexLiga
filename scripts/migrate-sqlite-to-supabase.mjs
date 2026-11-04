import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runMigrations } from '../db/migrate.mjs';
import { ensureMediaBucket, publicMediaUrl, uploadMedia } from '../storage/supabase-storage.mjs';

const { Pool } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sqlitePath = resolve(process.env.SQLITE_PATH || join(root, 'data', 'fairdraft.sqlite'));
const apply = process.argv.includes('--apply');
const tables = [
  'users',
  'leagues',
  'teams',
  'players',
  'matches',
  'match_squads',
  'match_events',
  'league_events',
  'sponsor_leads',
];
const conflictColumns = {
  match_squads: ['match_id', 'team_id'],
};

function mediaFileFromUrl(value) {
  if (!value || !value.startsWith('/media/')) return null;
  const fileName = value.slice('/media/'.length);
  if (!/^[a-f0-9]{32}\.(?:png|jpg|webp)$/.test(fileName)) {
    throw new Error(`Unsupported legacy media path: ${value}`);
  }
  return fileName;
}

function contentType(fileName) {
  switch (extname(fileName)) {
    case '.png':
      return 'image/png';
    case '.jpg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      throw new Error(`Unsupported media file: ${fileName}`);
  }
}

function hashSource(records, mediaFiles) {
  const hash = createHash('sha256');
  for (const table of tables) {
    hash.update(table);
    hash.update(JSON.stringify(records[table]));
  }
  for (const fileName of mediaFiles) {
    hash.update(fileName);
    hash.update(readFileSync(join(root, 'data', 'uploads', fileName)));
  }
  return hash.digest('hex');
}

function buildUpsert(table, row) {
  const columns = Object.keys(row);
  const conflict = conflictColumns[table] || ['id'];
  const updates = columns.filter((column) => !conflict.includes(column));
  const values = columns.map((_, index) => `$${index + 1}`).join(',');
  const quotedColumns = columns.map((column) => `"${column}"`).join(',');
  const conflictTarget = conflict.map((column) => `"${column}"`).join(',');
  const updateClause = updates.map((column) => `"${column}"=EXCLUDED."${column}"`).join(',');

  return {
    sql: `INSERT INTO "${table}" (${quotedColumns}) VALUES (${values}) ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateClause}`,
    values: columns.map((column) => row[column]),
  };
}

function loadSource() {
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const integrity = sqlite.prepare('PRAGMA quick_check').get();
    if (integrity.quick_check !== 'ok') {
      throw new Error(`SQLite integrity check failed: ${integrity.quick_check}`);
    }
    const foreignKeyErrors = sqlite.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeyErrors.length) {
      throw new Error(`SQLite has ${foreignKeyErrors.length} foreign-key violations.`);
    }

    const records = Object.fromEntries(
      tables.map((table) => [
        table,
        sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
      ])
    );
    const mediaFiles = new Set();
    for (const [table, column] of [
      ['leagues', 'logo_url'],
      ['teams', 'logo_url'],
      ['players', 'photo_url'],
    ]) {
      for (const row of records[table]) {
        const fileName = mediaFileFromUrl(row[column]);
        if (fileName) mediaFiles.add(fileName);
      }
    }

    const uploadDirectory = join(root, 'data', 'uploads');
    for (const fileName of mediaFiles) {
      if (!readdirSync(uploadDirectory).includes(fileName)) {
        throw new Error(`Referenced local image is missing: ${fileName}`);
      }
    }

    return { records, mediaFiles: [...mediaFiles].sort() };
  } finally {
    sqlite.close();
  }
}

function replaceLegacyMediaUrls(records) {
  for (const [table, column] of [
    ['leagues', 'logo_url'],
    ['teams', 'logo_url'],
    ['players', 'photo_url'],
  ]) {
    for (const row of records[table]) {
      const fileName = mediaFileFromUrl(row[column]);
      if (fileName) row[column] = publicMediaUrl(fileName);
    }
  }
}

async function assertImportTarget(pool, sourceHash) {
  const { rows: previousImports } = await pool.query(
    'SELECT source_hash FROM migration_imports WHERE source_hash=$1',
    [sourceHash]
  );
  if (previousImports.length) return false;

  const targetCounts = await Promise.all(
    tables.map(async (table) => {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS count FROM "${table}"`);
      return rows[0].count;
    })
  );
  if (targetCounts.some((count) => count !== 0)) {
    throw new Error(
      'The Supabase database already contains app records. Use a fresh project or back up and review the target before importing.'
    );
  }
  return true;
}

async function importRecords(pool, records, sourceHash) {
  if (!(await assertImportTarget(pool, sourceHash))) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const table of tables) {
      for (const row of records[table]) {
        const { sql, values } = buildUpsert(table, row);
        await client.query(sql, values);
      }
    }
    await client.query('INSERT INTO migration_imports(source_hash) VALUES($1)', [sourceHash]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return true;
}

async function main() {
  if (
    apply &&
    (!process.env.DATABASE_URL ||
      !process.env.SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY)
  ) {
    throw new Error(
      'Set DATABASE_URL, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY before using --apply.'
    );
  }

  const { records, mediaFiles } = loadSource();
  const sourceHash = hashSource(records, mediaFiles);
  const summary = Object.fromEntries(tables.map((table) => [table, records[table].length]));
  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        sqlitePath,
        sourceHash,
        records: summary,
        localImagesToUpload: mediaFiles.length,
        sessionsToImport: 0,
        passwordResetTokensToImport: 0,
      },
      null,
      2
    )
  );

  if (!apply) {
    console.log('Dry run only. Review the counts, then rerun with --apply to import.');
    return;
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    await runMigrations(pool);
    if (!(await assertImportTarget(pool, sourceHash))) {
      console.log('This exact SQLite snapshot has already been imported; nothing changed.');
      return;
    }
    await ensureMediaBucket();
    replaceLegacyMediaUrls(records);

    for (const fileName of mediaFiles) {
      const bytes = readFileSync(join(root, 'data', 'uploads', fileName));
      await uploadMedia(fileName, bytes, contentType(fileName));
    }
    if (!(await importRecords(pool, records, sourceHash))) {
      console.log(
        'This exact SQLite snapshot was imported by another process; no records changed.'
      );
      return;
    }
    console.log('SQLite records and referenced images were imported successfully.');
    console.log('All users must sign in again; active sessions and reset tokens were not copied.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('SQLite-to-Supabase migration failed:', error);
  process.exitCode = 1;
});
