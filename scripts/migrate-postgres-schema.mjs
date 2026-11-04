import 'dotenv/config';
import pg from 'pg';
import { runMigrations } from '../db/migrate.mjs';

if (!process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL before applying the PostgreSQL schema.');
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  await runMigrations(pool);
  console.log('PostgreSQL schema migrations applied successfully.');
} finally {
  await pool.end();
}
