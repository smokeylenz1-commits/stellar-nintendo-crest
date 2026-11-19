const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');
const LOCK_KEY = 250250250;

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    return [];
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedVersions(client) {
  const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
  return rows.map((row) => row.version);
}

async function withLock(client, fn) {
  await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
  try {
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
  }
}

async function up(client) {
  await ensureMigrationsTable(client);
  const applied = new Set(await getAppliedVersions(client));
  const files = listMigrationFiles();
  const pending = files.filter((file) => !applied.has(file));

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`[migrate] applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  if (pending.length === 0) {
    console.log('[migrate] no pending migrations');
  }
  return pending;
}

async function down(client) {
  await ensureMigrationsTable(client);
  const applied = await getAppliedVersions(client);
  const last = applied[applied.length - 1];
  if (!last) {
    console.log('[migrate] nothing to roll back');
    return null;
  }

  const downFile = path.join(MIGRATIONS_DIR, last.replace(/\.sql$/, '.down.sql'));
  if (!fs.existsSync(downFile)) {
    throw new Error(`[migrate] missing rollback file for ${last}`);
  }

  const sql = fs.readFileSync(downFile, 'utf8');
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('DELETE FROM schema_migrations WHERE version = $1', [last]);
    await client.query('COMMIT');
    console.log(`[migrate] rolled back ${last}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  return last;
}

async function run({ pool, direction = 'up' } = {}) {
  const client = await pool.connect();
  try {
    return await withLock(client, () => (direction === 'down' ? down(client) : up(client)));
  } finally {
    client.release();
  }
}

module.exports = { run, up, down, listMigrationFiles, LOCK_KEY };
