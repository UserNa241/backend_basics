import assert from 'node:assert/strict';
import { test } from 'node:test';

import { seedDatabase } from '../../src/db/seed.mjs';
import {
    SEED_USERS,
    SEED_PROJECTS,
    SEED_TASKS,
    SEED_USER_IDS,
    SEED_PROJECT_IDS,
} from '../../src/db/seed-data.mjs';

// ---------------------------------------------------------------------------
// Mock pool — an in-memory simulation of the pg Pool and Client.
// Supports DELETE FROM (clear all), INSERT ... ON CONFLICT DO NOTHING.
// ---------------------------------------------------------------------------

function createMockPool() {
    const state = {
        users: [],
        projects: [],
        tasks: [],
    };

    function executeStatement(statement, params) {
        const upper = statement.toUpperCase();

        // DELETE FROM <table> — clear all rows
        if (upper.startsWith('DELETE FROM')) {
            const match = statement.match(/^DELETE FROM\s+(\w+)/i);
            if (!match) return { rows: [] };
            const tableName = match[1];
            const deleted = state[tableName];
            state[tableName] = [];
            return { rows: deleted };
        }

        // INSERT INTO <table> (<cols>) VALUES ($1, $2, ...) ON CONFLICT ... DO NOTHING
        if (upper.startsWith('INSERT INTO')) {
            const insertMatch = statement.match(
                /^INSERT INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
            );
            if (!insertMatch) return { rows: [] };

            const tableName = insertMatch[1];
            const cols = insertMatch[2].split(',').map((c) => c.trim());
            const placeholders = insertMatch[3].split(',').map((c) => c.trim());

            const row = {};
            cols.forEach((col, index) => {
                row[col] = params[placeholders.indexOf(`$${index + 1}`)];
            });

            // ON CONFLICT DO NOTHING — skip if a row with the same id exists
            const hasId = cols.includes('id');
            const conflictMatch = statement.match(/ON CONFLICT\s*\((\w+)\)\s*DO NOTHING/i);

            if (conflictMatch && hasId) {
                const conflictCol = conflictMatch[1];
                const existing = state[tableName].find(
                    (r) => r[conflictCol] === row[conflictCol],
                );
                if (existing) {
                    return { rows: [] };
                }
            }

            state[tableName].push(row);
            return { rows: [row] };
        }

        return { rows: [] };
    }

    function splitStatements(sql) {
        return sql
            .split(';')
            .map((s) => s.trim())
            .filter((s) => s.length > 0 && !s.startsWith('--'));
    }

    const client = {
        async query(sql, params = []) {
            const statements = splitStatements(sql);
            let rows = [];
            for (const statement of statements) {
                const result = executeStatement(statement, params);
                rows = result.rows;
            }
            return { rows, rowCount: rows.length };
        },

        release() {},
    };

    const pool = {
        async query(sql, params = []) {
            return client.query(sql, params);
        },

        async connect() {
            return client;
        },
        async end() {},
    };

    return { pool, state };
}

// ---------------------------------------------------------------------------
// Tests for seed data definition
// ---------------------------------------------------------------------------

test('SEED_USERS has 3 users with valid fields', () => {
    assert.equal(SEED_USERS.length, 3);
    for (const user of SEED_USERS) {
        assert.ok(user.id, 'user has id');
        assert.ok(user.email, 'user has email');
        assert.ok(user.name, 'user has name');
        assert.ok(user.passwordHash, 'user has passwordHash');
    }
});

test('SEED_PROJECTS has 3 projects with valid fields', () => {
    assert.equal(SEED_PROJECTS.length, 3);
    for (const project of SEED_PROJECTS) {
        assert.ok(project.id, 'project has id');
        assert.ok(project.owner_id, 'project has owner_id');
        assert.ok(project.name, 'project has name');
    }
});

test('SEED_TASKS has 5 tasks with valid fields', () => {
    assert.equal(SEED_TASKS.length, 5);
    for (const task of SEED_TASKS) {
        assert.ok(task.id, 'task has id');
        assert.ok(task.project_id, 'task has project_id');
        assert.ok(task.title, 'task has title');
        assert.ok(['todo', 'in_progress', 'done'].includes(task.status),
            `task status is valid: ${task.status}`);
    }
});

test('SEED_USER_IDS are all unique', () => {
    const ids = Object.values(SEED_USER_IDS);
    assert.equal(new Set(ids).size, ids.length);
});

test('SEED_PROJECT_IDS are all unique', () => {
    const ids = Object.values(SEED_PROJECT_IDS);
    assert.equal(new Set(ids).size, ids.length);
});

// ---------------------------------------------------------------------------
// Tests for seedDatabase
// ---------------------------------------------------------------------------

test('seedDatabase inserts all users', async () => {
    const { pool, state } = createMockPool();
    await seedDatabase(pool);

    assert.equal(state.users.length, 3);
    assert.ok(state.users.some((u) => u.email === 'alice@example.com'));
    assert.ok(state.users.some((u) => u.email === 'bob@example.com'));
    assert.ok(state.users.some((u) => u.email === 'carol@example.com'));
});

test('seedDatabase inserts all projects', async () => {
    const { pool, state } = createMockPool();
    await seedDatabase(pool);

    assert.equal(state.projects.length, 3);
    assert.ok(state.projects.some((p) => p.name === 'Reading List'));
    assert.ok(state.projects.some((p) => p.name === 'Research Notes'));
    assert.ok(state.projects.some((p) => p.name === 'Side Project'));
});

test('seedDatabase inserts all tasks', async () => {
    const { pool, state } = createMockPool();
    await seedDatabase(pool);

    assert.equal(state.tasks.length, 5);
    assert.ok(state.tasks.some((t) => t.title === 'Read chapter 1'));
    assert.ok(state.tasks.some((t) => t.title === 'Find sources'));
});

test('seedDatabase returns correct summary counts', async () => {
    const { pool } = createMockPool();
    const result = await seedDatabase(pool);

    assert.deepEqual(result, {
        users: 3,
        projects: 3,
        tasks: 5,
    });
});

test('seedDatabase clears existing data before inserting', async () => {
    const { pool, state } = createMockPool();

    // Pre-populate with stale data
    state.users.push({ id: 'stale-id', email: 'stale@example.com', name: 'Stale' });
    state.projects.push({ id: 'stale-proj', owner_id: 'stale-id', name: 'Stale' });
    state.tasks.push({ id: 'stale-task', project_id: 'stale-proj', title: 'Stale', status: 'todo' });

    await seedDatabase(pool);

    assert.equal(state.users.length, 3);
    assert.equal(state.projects.length, 3);
    assert.equal(state.tasks.length, 5);
    assert.ok(!state.users.some((u) => u.email === 'stale@example.com'));
});

test('seedDatabase is safe to re-run without duplicates', async () => {
    const { pool, state } = createMockPool();

    await seedDatabase(pool);
    assert.equal(state.users.length, 3);

    // Run again — ON CONFLICT DO NOTHING prevents duplicates
    await seedDatabase(pool);
    assert.equal(state.users.length, 3);
    assert.equal(state.projects.length, 3);
    assert.equal(state.tasks.length, 5);
});

test('seedDatabase creates correct user-project relationships', async () => {
    const { pool, state } = createMockPool();
    await seedDatabase(pool);

    const aliceProjects = state.projects.filter(
        (p) => p.owner_id === SEED_USER_IDS.alice,
    );
    assert.equal(aliceProjects.length, 2);

    const bobProjects = state.projects.filter(
        (p) => p.owner_id === SEED_USER_IDS.bob,
    );
    assert.equal(bobProjects.length, 1);
});

test('seedDatabase creates correct project-task relationships', async () => {
    const { pool, state } = createMockPool();
    await seedDatabase(pool);

    const readingListTasks = state.tasks.filter(
        (t) => t.project_id === SEED_PROJECT_IDS.readingList,
    );
    assert.equal(readingListTasks.length, 3);

    const researchNotesTasks = state.tasks.filter(
        (t) => t.project_id === SEED_PROJECT_IDS.researchNotes,
    );
    assert.equal(researchNotesTasks.length, 1);

    const sideProjectTasks = state.tasks.filter(
        (t) => t.project_id === SEED_PROJECT_IDS.sideProject,
    );
    assert.equal(sideProjectTasks.length, 1);
});

test('seedDatabase tasks cover all three statuses', async () => {
    const { pool, state } = createMockPool();
    await seedDatabase(pool);

    const statuses = new Set(state.tasks.map((t) => t.status));
    assert.ok(statuses.has('todo'));
    assert.ok(statuses.has('in_progress'));
    assert.ok(statuses.has('done'));
});
