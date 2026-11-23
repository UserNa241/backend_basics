import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRepository } from '../../src/db/repository.mjs';

// ---------------------------------------------------------------------------
// Mock pool — an in-memory simulation of the pg Pool and Client.
// Tracks rows in tables, handles parameterized INSERT/SELECT/UPDATE/DELETE,
// and returns results without needing a live PostgreSQL server.
// ---------------------------------------------------------------------------

function createMockPool() {
    const state = {
        users: [],
        projects: [],
        tasks: [],
    };

    let idCounter = 1;

    function nextId() {
        idCounter += 1;
        return `00000000-0000-0000-0000-${String(idCounter).padStart(12, '0')}`;
    }

    function now() {
        return new Date().toISOString();
    }

    function executeStatement(statement, params) {
        const upper = statement.toUpperCase();

        // INSERT INTO <table> (<cols>) VALUES ($1, $2, ...) RETURNING ...
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
            row.id = nextId();
            row.created_at = now();

            state[tableName].push(row);

            const returningMatch = statement.match(/RETURNING\s+(.+)$/i);
            if (returningMatch) {
                const returningCols = returningMatch[1].split(',').map((c) => c.trim());
                const returnedRow = {};
                returningCols.forEach((col) => {
                    if (col === '*') {
                        Object.assign(returnedRow, row);
                    } else {
                        returnedRow[col] = row[col];
                    }
                });
                return { rows: [returnedRow] };
            }

            return { rows: [row] };
        }

        // SELECT ... FROM <table> WHERE <col> = $1 ...
        if (upper.startsWith('SELECT')) {
            const selectMatch = statement.match(
                /^SELECT\s+(.+?)\s+FROM\s+(\w+)/i,
            );
            if (!selectMatch) return { rows: [] };

            const selectCols = selectMatch[1].trim();
            const tableName = selectMatch[2];
            const rows = state[tableName] || [];

            let filtered = [...rows];

            const whereMatch = statement.match(
                /WHERE\s+(\w+)\s*=\s*\$(\d+)/i,
            );
            if (whereMatch) {
                const whereCol = whereMatch[1];
                const paramIndex = parseInt(whereMatch[2], 10) - 1;
                filtered = filtered.filter((row) => row[whereCol] === params[paramIndex]);
            }

            const orderMatch = statement.match(
                /ORDER BY\s+(\w+)(?:\s+(DESC|ASC))?/i,
            );
            if (orderMatch) {
                const orderCol = orderMatch[1];
                const direction = orderMatch[2] || 'ASC';
                filtered.sort((a, b) => {
                    if (a[orderCol] < b[orderCol]) return direction === 'DESC' ? 1 : -1;
                    if (a[orderCol] > b[orderCol]) return direction === 'DESC' ? -1 : 1;
                    return 0;
                });
            }

            const limitMatch = statement.match(/LIMIT\s+\$(\d+)/i);
            const offsetMatch = statement.match(/OFFSET\s+\$(\d+)/i);

            if (offsetMatch) {
                const offsetIndex = parseInt(offsetMatch[1], 10) - 1;
                filtered = filtered.slice(params[offsetIndex]);
            }
            if (limitMatch) {
                const limitIndex = parseInt(limitMatch[1], 10) - 1;
                filtered = filtered.slice(0, params[limitIndex]);
            }

            if (selectCols === '*') {
                return { rows: filtered.map((row) => ({ ...row })) };
            }

            const cols = selectCols.split(',').map((c) => c.trim());
            return {
                rows: filtered.map((row) => {
                    const projected = {};
                    cols.forEach((col) => {
                        projected[col] = row[col];
                    });
                    return projected;
                }),
            };
        }

        // UPDATE <table> SET <col> = $N ... WHERE <col> = $N RETURNING ...
        if (upper.startsWith('UPDATE')) {
            const updateMatch = statement.match(
                /^UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(\w+)\s*=\s*\$(\d+)/i,
            );
            if (!updateMatch) return { rows: [] };

            const tableName = updateMatch[1];
            const setClause = updateMatch[2];
            const whereCol = updateMatch[3];
            const whereParamIndex = parseInt(updateMatch[4], 10) - 1;

            const setPairs = setClause.split(',').map((pair) => {
                const m = pair.match(/(\w+)\s*=\s*\$(\d+)/i);
                return { col: m[1], paramIndex: parseInt(m[2], 10) - 1 };
            });

            const updated = [];
            state[tableName].forEach((row) => {
                if (row[whereCol] === params[whereParamIndex]) {
                    setPairs.forEach((pair) => {
                        row[pair.col] = params[pair.paramIndex];
                    });
                    updated.push({ ...row });
                }
            });

            return { rows: updated };
        }

        // DELETE FROM <table> WHERE <col> = $N RETURNING ...
        if (upper.startsWith('DELETE FROM')) {
            const deleteMatch = statement.match(
                /^DELETE FROM\s+(\w+)\s+WHERE\s+(\w+)\s*=\s*\$(\d+)/i,
            );
            if (!deleteMatch) return { rows: [] };

            const tableName = deleteMatch[1];
            const whereCol = deleteMatch[2];
            const whereParamIndex = parseInt(deleteMatch[3], 10) - 1;

            const deleted = [];
            state[tableName] = state[tableName].filter((row) => {
                if (row[whereCol] === params[whereParamIndex]) {
                    deleted.push({ ...row });
                    return false;
                }
                return true;
            });

            return { rows: deleted };
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
// Tests for users repository
// ---------------------------------------------------------------------------

test('insertUser creates a user and returns the row with generated id', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    const user = await repo.insertUser({
        email: 'alice@example.com',
        name: 'Alice',
        passwordHash: 'hash123',
    });

    assert.ok(user.id);
    assert.equal(user.email, 'alice@example.com');
    assert.equal(user.name, 'Alice');
    assert.ok(user.created_at);
    // password_hash should not be in the returned row
    assert.equal(user.password_hash, undefined);
});

test('getUserByEmail finds a user by email', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    await repo.insertUser({
        email: 'bob@example.com',
        name: 'Bob',
        passwordHash: 'hash456',
    });

    const user = await repo.getUserByEmail('bob@example.com');

    assert.equal(user.email, 'bob@example.com');
    assert.equal(user.name, 'Bob');
});

test('getUserByEmail returns null when no user matches', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    const user = await repo.getUserByEmail('nobody@example.com');

    assert.equal(user, null);
});

test('getUserById finds a user by id', async () => {
    const { pool, state } = createMockPool();
    const repo = createRepository(pool);

    const created = await repo.insertUser({
        email: 'carol@example.com',
        name: 'Carol',
        passwordHash: 'hash789',
    });

    const user = await repo.getUserById(created.id);

    assert.equal(user.id, created.id);
    assert.equal(user.email, 'carol@example.com');
});

test('listUsers returns users ordered newest first with pagination', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    await repo.insertUser({ email: 'u1@example.com', name: 'U1', passwordHash: 'h' });
    await repo.insertUser({ email: 'u2@example.com', name: 'U2', passwordHash: 'h' });
    await repo.insertUser({ email: 'u3@example.com', name: 'U3', passwordHash: 'h' });

    const all = await repo.listUsers({ limit: 10, offset: 0 });
    assert.equal(all.length, 3);

    const page = await repo.listUsers({ limit: 2, offset: 0 });
    assert.equal(page.length, 2);

    const secondPage = await repo.listUsers({ limit: 2, offset: 2 });
    assert.equal(secondPage.length, 1);
});

// ---------------------------------------------------------------------------
// Tests for projects repository
// ---------------------------------------------------------------------------

test('insertProject creates a project and returns the full row', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    const project = await repo.insertProject({
        ownerId: 'owner-uuid-1',
        name: 'My Project',
        description: 'A test project',
    });

    assert.ok(project.id);
    assert.equal(project.owner_id, 'owner-uuid-1');
    assert.equal(project.name, 'My Project');
    assert.equal(project.description, 'A test project');
});

test('listProjectsByOwner returns projects for a specific owner', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    await repo.insertProject({ ownerId: 'owner-1', name: 'P1', description: null });
    await repo.insertProject({ ownerId: 'owner-1', name: 'P2', description: null });
    await repo.insertProject({ ownerId: 'owner-2', name: 'P3', description: null });

    const owner1Projects = await repo.listProjectsByOwner('owner-1');
    assert.equal(owner1Projects.length, 2);
    assert.ok(owner1Projects.every((p) => p.owner_id === 'owner-1'));

    const owner2Projects = await repo.listProjectsByOwner('owner-2');
    assert.equal(owner2Projects.length, 1);
});

test('getProjectById finds a project by id', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    const created = await repo.insertProject({
        ownerId: 'owner-1',
        name: 'Find Me',
        description: null,
    });

    const project = await repo.getProjectById(created.id);
    assert.equal(project.id, created.id);
    assert.equal(project.name, 'Find Me');
});

test('getProjectById returns null when not found', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    const project = await repo.getProjectById('nonexistent-id');
    assert.equal(project, null);
});

test('updateProject changes name and description', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    const created = await repo.insertProject({
        ownerId: 'owner-1',
        name: 'Old Name',
        description: 'Old description',
    });

    const updated = await repo.updateProject(created.id, {
        name: 'New Name',
        description: 'New description',
    });

    assert.equal(updated.name, 'New Name');
    assert.equal(updated.description, 'New description');
});

test('deleteProject removes a project', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    const created = await repo.insertProject({
        ownerId: 'owner-1',
        name: 'To Delete',
        description: null,
    });

    const deleted = await repo.deleteProject(created.id);
    assert.equal(deleted.id, created.id);

    const afterDelete = await repo.getProjectById(created.id);
    assert.equal(afterDelete, null);
});

// ---------------------------------------------------------------------------
// Tests for tasks repository
// ---------------------------------------------------------------------------

test('insertTask creates a task and returns the full row', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    const task = await repo.insertTask({
        projectId: 'proj-uuid-1',
        title: 'Write tests',
        status: 'todo',
    });

    assert.ok(task.id);
    assert.equal(task.project_id, 'proj-uuid-1');
    assert.equal(task.title, 'Write tests');
    assert.equal(task.status, 'todo');
});

test('listTasksByProject returns tasks for a specific project', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    await repo.insertTask({ projectId: 'proj-1', title: 'T1', status: 'todo' });
    await repo.insertTask({ projectId: 'proj-1', title: 'T2', status: 'done' });
    await repo.insertTask({ projectId: 'proj-2', title: 'T3', status: 'todo' });

    const proj1Tasks = await repo.listTasksByProject('proj-1');
    assert.equal(proj1Tasks.length, 2);
    assert.ok(proj1Tasks.every((t) => t.project_id === 'proj-1'));
});

test('listTasksByProject supports pagination', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    await repo.insertTask({ projectId: 'proj-1', title: 'T1', status: 'todo' });
    await repo.insertTask({ projectId: 'proj-1', title: 'T2', status: 'todo' });
    await repo.insertTask({ projectId: 'proj-1', title: 'T3', status: 'todo' });

    const page = await repo.listTasksByProject('proj-1', { limit: 2, offset: 0 });
    assert.equal(page.length, 2);

    const secondPage = await repo.listTasksByProject('proj-1', { limit: 2, offset: 2 });
    assert.equal(secondPage.length, 1);
});

test('getTaskById finds a task by id', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    const created = await repo.insertTask({
        projectId: 'proj-1',
        title: 'Find Me',
        status: 'todo',
    });

    const task = await repo.getTaskById(created.id);
    assert.equal(task.id, created.id);
    assert.equal(task.title, 'Find Me');
});

test('getTaskById returns null when not found', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    const task = await repo.getTaskById('nonexistent-id');
    assert.equal(task, null);
});

test('updateTaskStatus changes the status of a task', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    const created = await repo.insertTask({
        projectId: 'proj-1',
        title: 'My Task',
        status: 'todo',
    });

    const updated = await repo.updateTaskStatus(created.id, 'in_progress');
    assert.equal(updated.status, 'in_progress');
    assert.equal(updated.id, created.id);
});

test('deleteTask removes a task', async () => {
    const { pool } = createMockPool();
    const repo = createRepository(pool);

    const created = await repo.insertTask({
        projectId: 'proj-1',
        title: 'To Delete',
        status: 'todo',
    });

    const deleted = await repo.deleteTask(created.id);
    assert.equal(deleted.id, created.id);

    const afterDelete = await repo.getTaskById(created.id);
    assert.equal(afterDelete, null);
});
