import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from 'pg';
import { runMigrations } from './migrate.mjs';

const requestContext = new AsyncLocalStorage();
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set to connect NexLiga to Supabase PostgreSQL.');
}

if (process.env.FAIRDRAFT_LOCAL_DB === 'true') {
  let hostname;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    throw new Error('FAIRDRAFT_LOCAL_DB requires a valid local PostgreSQL DATABASE_URL.');
  }
  if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1'].includes(hostname)) {
    throw new Error('FAIRDRAFT_LOCAL_DB only allows a local PostgreSQL database.');
  }
}

const pool = new Pool({
  connectionString: databaseUrl,
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (error) => {
  console.error('Unexpected Supabase PostgreSQL pool error:', error);
});

function postgresPlaceholders(sql) {
  let index = 0;
  let output = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let position = 0; position < sql.length; position++) {
    const character = sql[position];

    if (character === "'" && !inDoubleQuote) {
      if (inSingleQuote && sql[position + 1] === "'") {
        output += "''";
        position++;
        continue;
      }
      inSingleQuote = !inSingleQuote;
    } else if (character === '"' && !inSingleQuote) {
      if (inDoubleQuote && sql[position + 1] === '"') {
        output += '""';
        position++;
        continue;
      }
      inDoubleQuote = !inDoubleQuote;
    } else if (character === '?' && !inSingleQuote && !inDoubleQuote) {
      output += `$${++index}`;
      continue;
    }

    output += character;
  }

  return output;
}

async function query(sql, values = []) {
  const context = requestContext.getStore();
  return (context?.client || pool).query(postgresPlaceholders(sql), values);
}

export const db = {
  prepare(sql) {
    return {
      async get(...values) {
        const result = await query(sql, values);
        return result.rows[0];
      },
      async all(...values) {
        const result = await query(sql, values);
        return result.rows;
      },
      async run(...values) {
        const result = await query(sql, values);
        return { changes: result.rowCount };
      },
    };
  },

  async exec(sql) {
    const command = sql.trim().toUpperCase();
    const context = requestContext.getStore();

    if (command === 'BEGIN' || command === 'BEGIN IMMEDIATE') {
      if (!context || context.client) {
        throw new Error('Database transactions must run inside a request or migration context.');
      }
      context.client = await pool.connect();
      try {
        await context.client.query('BEGIN');
      } catch (error) {
        context.client.release();
        context.client = null;
        throw error;
      }
      return;
    }

    if (command === 'COMMIT' || command === 'ROLLBACK') {
      if (!context?.client) throw new Error('No database transaction is active.');
      const client = context.client;
      try {
        await client.query(command);
      } finally {
        context.client = null;
        client.release();
      }
      return;
    }

    await query(sql);
  },

  async migrate() {
    await runMigrations(pool);
  },

  async close() {
    await pool.end();
  },
};

export function withDatabaseContext(callback) {
  return requestContext.run({ client: null }, callback);
}

export async function healthCheck() {
  await pool.query('SELECT 1');
}
