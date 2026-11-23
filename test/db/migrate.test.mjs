import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    migrateUp,
    migrateDown,
    parseMigrationFile,
    migrationsTable,
} from '../../src/db/migrate.mjs';

// ---------------------------------------------------------------------------
// Mock pool — an in-memory simulation of the pg Pool and Client.
// Tracks tables, applied migration versions, and transaction state.
// ---------------------------------------------------------------------------

function createMockPool() {
    const state = {
        tables: new Set(),
        migrations: new Map(),
        inTransaction: false,
        snapshot: null,
    };

    function splitStatements(sql) {
        return sql
            .split(';')
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && !s.startsWith('--'));
    }

    function snapshotState(state) {
        return {
            tables: new Set(state.tables),
            migrations: new Map(state.migrations),
        };
    }

    function restoreState(state, snapshot) {
        state.tables = snapshot.tables;
        state.migrations = snapshot.migrations;
    }

    function executeStatement(statement, params) {
        const upper = statement.toUpperCase();

        if (upper === 'BEGIN') {
            state.snapshot = snapshotState(state);
            state.inTransaction = true;
            return;
        }

        if (upper === 'COMMIT') {
            state.snapshot = null;
            state.inTransaction = false;
            return;
        }

        if (upper === 'ROLLBACK') {
            if (state.snapshot) {
                restoreState(state, state.snapshot);
                state.snapshot = null;
            }
            state.inTransaction = false;
            return;
        }

        // CREATE TABLE IF NOT EXISTS <name> ...
        const createTableMatch = statement.match(
            /^CREATE TABLE IF NOT EXISTS\s+(\w+)/i,
        );
        if (createTableMatch) {
            state.tables.add(createTableMatch[1]);
            return;
        }

        // CREATE INDEX IF NOT EXISTS ... (no-op for the mock)
        if (/^CREATE INDEX IF NOT EXISTS/i.test(statement)) {
            return;
        }

        // DROP TABLE IF EXISTS <name>
        const dropTableMatch = statement.match(
            /^DROP TABLE IF EXISTS\s+(\w+)/i,
        );
        if (dropTableMatch) {
            state.tables.delete(dropTableMatch[1]);
            return;
        }

        // INSERT INTO schema_migrations (version) VALUES ($1)
        const insertMatch = statement.match(
            /^INSERT INTO\s+schema_migrations\s+\(version\)\s+VALUES\s+\(\$1\)/i,
        );
        if (insertMatch) {
            const version = params[0];
            state.migrations.set(version, new Date().toISOString());
            return;
        }

        // DELETE FROM schema_migrations WHERE version = $1
        const deleteMatch = statement.match(
            /^DELETE FROM\s+schema_migrations\s+WHERE\s+version\s*=\s*\$1/i,
        );
        if (deleteMatch) {
            const version = params[0];
            state.migrations.delete(version);
            return;
        }
    }

    function handleSelect(sql, params) {
        const upper = sql.toUpperCase();

        // SELECT version FROM schema_migrations ORDER BY version DESC LIMIT $1
        if (upper.includes('ORDER BY') && upper.includes('LIMIT')) {
            const limit = params[0];
            const sorted = Array.from(state.migrations.keys()).sort().reverse();
            const limited = sorted.slice(0, limit);
            return limited.map((version) => ({ version }));
        }

        // SELECT version FROM schema_migrations
        if (upper.includes(`FROM ${migrationsTable.toUpperCase()}`)) {
            return Array.from(state.migrations.keys()).map((version) => ({
                version,
            }));
        }

        return [];
    }

    const client = {
        async query(sql, params = []) {
            const trimmed = sql.trim();

            if (/^SELECT\s/i.test(trimmed)) {
                const rows = handleSelect(trimmed, params);
                return { rows, rowCount: rows.length };
            }

            const statements = splitStatements(sql);
            for (const statement of statements) {
                executeStatement(statement, params);
            }
            return { rows: [], rowCount: 0 };
        },

        release() {
            // no-op — the mock client is always "available"
        },
    };

    const pool = {
        async connect() {
            return client;
        },
        async end() {
            // no-op
        },
    };

    return { pool, state };
}

// ---------------------------------------------------------------------------
// Tests for parseMigrationFile
// ---------------------------------------------------------------------------

test('parseMigrationFile extracts both up and down sections', () => {
    const sql = `-- up
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY
);

-- down
DROP TABLE IF EXISTS users;`;

    const parsed = parseMigrationFile(sql);

    assert.ok(parsed.up.includes('CREATE TABLE IF NOT EXISTS users'));
    assert.ok(parsed.up.includes('id UUID PRIMARY KEY'));
    assert.ok(parsed.down.includes('DROP TABLE IF EXISTS users'));
    assert.ok(!parsed.up.includes('DROP TABLE'));
    assert.ok(!parsed.down.includes('CREATE TABLE'));
});

test('parseMigrationFile throws when the up section is missing', () => {
    const sql = `-- down
DROP TABLE IF EXISTS users;`;

    assert.throws(() => parseMigrationFile(sql), {
        message: 'Migration file is missing the "-- up" section',
    });
});

test('parseMigrationFile returns empty down when down section is missing', () => {
    const sql = `-- up
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY
);`;

    const parsed = parseMigrationFile(sql);

    assert.ok(parsed.up.includes('CREATE TABLE'));
    assert.equal(parsed.down, '');
});

// ---------------------------------------------------------------------------
// Tests for migrateUp
// ---------------------------------------------------------------------------

test('migrateUp creates the schema_migrations tracking table', async () => {
    const { pool, state } = createMockPool();

    await migrateUp(pool);

    assert.ok(state.tables.has('schema_migrations'));
});

test('migrateUp applies all pending migrations in filename order', async () => {
    const { pool, state } = createMockPool();

    const result = await migrateUp(pool);

    assert.deepEqual(result.applied, [
        '001_create_users.sql',
        '002_create_projects.sql',
        '003_create_tasks.sql',
    ]);
    assert.equal(result.skipped, 0);
});

test('migrateUp creates all business tables', async () => {
    const { pool, state } = createMockPool();

    await migrateUp(pool);

    assert.ok(state.tables.has('users'));
    assert.ok(state.tables.has('projects'));
    assert.ok(state.tables.has('tasks'));
    assert.ok(state.tables.has('schema_migrations'));
});

test('migrateUp records applied versions in schema_migrations', async () => {
    const { pool, state } = createMockPool();

    await migrateUp(pool);

    assert.equal(state.migrations.size, 3);
    assert.ok(state.migrations.has('001_create_users.sql'));
    assert.ok(state.migrations.has('002_create_projects.sql'));
    assert.ok(state.migrations.has('003_create_tasks.sql'));
});

test('migrateUp skips already-applied migrations', async () => {
    const { pool, state } = createMockPool();

    // Pre-record all three migrations as already applied
    state.migrations.set('001_create_users.sql', '2024-01-01');
    state.migrations.set('002_create_projects.sql', '2024-01-01');
    state.migrations.set('003_create_tasks.sql', '2024-01-01');

    const result = await migrateUp(pool);

    assert.deepEqual(result.applied, []);
    assert.equal(result.skipped, 3);
});

test('migrateUp only applies new migrations when some are already applied', async () => {
    const { pool, state } = createMockPool();

    // Pre-record the first migration as already applied
    state.migrations.set('001_create_users.sql', '2024-01-01');

    const result = await migrateUp(pool);

    assert.deepEqual(result.applied, [
        '002_create_projects.sql',
        '003_create_tasks.sql',
    ]);
    assert.equal(result.skipped, 1);
});

// ---------------------------------------------------------------------------
// Tests for migrateDown
// ---------------------------------------------------------------------------

test('migrateDown rolls back the most recent migration first', async () => {
    const { pool, state } = createMockPool();

    // Apply all migrations first
    await migrateUp(pool);

    const result = await migrateDown(pool);

    assert.deepEqual(result.rolledBack, ['003_create_tasks.sql']);
});

test('migrateDown removes the rolled-back version from schema_migrations', async () => {
    const { pool, state } = createMockPool();

    await migrateUp(pool);
    await migrateDown(pool);

    assert.ok(!state.migrations.has('003_create_tasks.sql'));
    assert.ok(state.migrations.has('001_create_users.sql'));
    assert.ok(state.migrations.has('002_create_projects.sql'));
});

test('migrateDown drops the rolled-back table', async () => {
    const { pool, state } = createMockPool();

    await migrateUp(pool);
    await migrateDown(pool);

    assert.ok(!state.tables.has('tasks'));
    assert.ok(state.tables.has('projects'));
    assert.ok(state.tables.has('users'));
});

test('migrateDown rolls back the correct number of migrations', async () => {
    const { pool, state } = createMockPool();

    await migrateUp(pool);

    const result = await migrateDown(pool, 2);

    assert.deepEqual(result.rolledBack, [
        '003_create_tasks.sql',
        '002_create_projects.sql',
    ]);
});

test('migrateDown returns empty result when nothing is applied', async () => {
    const { pool } = createMockPool();

    const result = await migrateDown(pool);

    assert.deepEqual(result.rolledBack, []);
});

test('migrateDown rolls back in reverse order maintaining dependency chain', async () => {
    const { pool, state } = createMockPool();

    await migrateUp(pool);

    // Roll back all three — order must be 003, 002, 001
    await migrateDown(pool, 1);
    await migrateDown(pool, 1);
    await migrateDown(pool, 1);

    assert.equal(state.migrations.size, 0);
    assert.ok(!state.tables.has('tasks'));
    assert.ok(!state.tables.has('projects'));
    assert.ok(!state.tables.has('users'));
    // The tracking table itself remains
    assert.ok(state.tables.has('schema_migrations'));
});
