// test/app-service.test.mjs
//
// S6 Build 1 — Tests for the Application Service.
//
// This test file uses a mock repository (the seam from S6 Lesson 8).
// The mock returns predictable raw driver records — exactly the same
// shape the real database would return, with snake_case columns.
// The service should translate those into clean DTOs with camelCase
// naming and no internal fields.
//
// What we're testing:
//   - Each operation calls the correct repository function
//   - The raw record is mapped to the correct DTO shape
//   - Null (not found) and array (list) cases are handled correctly

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAppService } from '../src/app-service.mjs';

// ---------------------------------------------------------------------------
// Mock repository — returns raw driver records with database-style naming.
// This simulates what the real repository returns, without needing a
// live PostgreSQL server. The service code is identical whether it
// receives this mock or the real repository.
// ---------------------------------------------------------------------------

function createMockRepo() {
    // Track which functions were called and with what arguments,
    // so tests can verify the service calls the right thing.
    const calls = [];

    // Raw driver records — these look exactly like what the database
    // would return: snake_case columns, database naming.
    const rawUser = {
        id: 'user-1',
        email: 'alice@example.com',
        name: 'Alice',
        created_at: '2024-01-15T10:00:00.000Z',
    };

    const rawUser2 = {
        id: 'user-2',
        email: 'bob@example.com',
        name: 'Bob',
        created_at: '2024-01-16T10:00:00.000Z',
    };

    const rawProject = {
        id: 'proj-1',
        owner_id: 'user-1',
        name: 'Reading List',
        description: 'A list of books to read',
        created_at: '2024-01-15T10:05:00.000Z',
    };

    const rawTask = {
        id: 'task-1',
        project_id: 'proj-1',
        title: 'Read chapter 3',
        status: 'todo',
        created_at: '2024-01-15T10:10:00.000Z',
    };

    return {
        calls,

        async insertUser(input) {
            calls.push({ fn: 'insertUser', args: input });
            return { ...rawUser };
        },

        async getUserByEmail(email) {
            calls.push({ fn: 'getUserByEmail', args: email });
            return email === 'alice@example.com' ? { ...rawUser } : null;
        },

        async listUsers() {
            calls.push({ fn: 'listUsers', args: {} });
            return [{ ...rawUser }, { ...rawUser2 }];
        },

        async insertProject(input) {
            calls.push({ fn: 'insertProject', args: input });
            return { ...rawProject };
        },

        async listProjectsByOwner(ownerId) {
            calls.push({ fn: 'listProjectsByOwner', args: ownerId });
            return [{ ...rawProject }];
        },

        async getProjectById(id) {
            calls.push({ fn: 'getProjectById', args: id });
            return id === 'proj-1' ? { ...rawProject } : null;
        },

        async insertTask(input) {
            calls.push({ fn: 'insertTask', args: input });
            return { ...rawTask };
        },

        async listTasksByProject(projectId) {
            calls.push({ fn: 'listTasksByProject', args: projectId });
            return [{ ...rawTask }];
        },

        async updateTaskStatus(id, status) {
            calls.push({ fn: 'updateTaskStatus', args: { id, status } });
            return id === 'task-1' ? { ...rawTask, status } : null;
        },
    };
}

// ---------------------------------------------------------------------------
// User operations
// ---------------------------------------------------------------------------

test('createUser calls insertUser and returns a DTO', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const input = {
        email: 'alice@example.com',
        name: 'Alice',
        passwordHash: 'secret-hash',
    };
    const result = await service.createUser(input);

    // The service should have called insertUser with the input
    assert.equal(repo.calls.length, 1);
    assert.equal(repo.calls[0].fn, 'insertUser');
    assert.deepEqual(repo.calls[0].args, input);

    // The result should be a clean DTO with camelCase naming
    assert.equal(result.id, 'user-1');
    assert.equal(result.email, 'alice@example.com');
    assert.equal(result.name, 'Alice');
    assert.equal(result.createdAt, '2024-01-15T10:00:00.000Z');

    // The DTO should NOT have database-style columns
    assert.equal(result.created_at, undefined);
    assert.equal(result.password_hash, undefined);
});

test('getUserByEmail returns a DTO when the user exists', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const result = await service.getUserByEmail('alice@example.com');

    assert.equal(repo.calls[0].fn, 'getUserByEmail');
    assert.equal(repo.calls[0].args, 'alice@example.com');
    assert.equal(result.id, 'user-1');
    assert.equal(result.email, 'alice@example.com');
    assert.equal(result.createdAt, '2024-01-15T10:00:00.000Z');
});

test('getUserByEmail returns null when the user does not exist', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const result = await service.getUserByEmail('nobody@example.com');

    assert.equal(repo.calls[0].fn, 'getUserByEmail');
    assert.equal(result, null);
});

test('listUsers returns an array of DTOs', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const result = await service.listUsers({ limit: 10, offset: 0 });

    assert.equal(repo.calls[0].fn, 'listUsers');
    assert.equal(result.length, 2);

    // Each element should be a DTO with camelCase naming
    assert.equal(result[0].id, 'user-1');
    assert.equal(result[0].email, 'alice@example.com');
    assert.equal(result[0].createdAt, '2024-01-15T10:00:00.000Z');
    assert.equal(result[1].id, 'user-2');
    assert.equal(result[1].created_at, undefined);
});

// ---------------------------------------------------------------------------
// Project operations
// ---------------------------------------------------------------------------

test('createProject calls insertProject and returns a DTO', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const input = {
        ownerId: 'user-1',
        name: 'Reading List',
        description: 'A list of books to read',
    };
    const result = await service.createProject(input);

    assert.equal(repo.calls[0].fn, 'insertProject');
    assert.deepEqual(repo.calls[0].args, input);

    // DTO should convert owner_id → ownerId and created_at → createdAt
    assert.equal(result.id, 'proj-1');
    assert.equal(result.ownerId, 'user-1');
    assert.equal(result.name, 'Reading List');
    assert.equal(result.description, 'A list of books to read');
    assert.equal(result.createdAt, '2024-01-15T10:05:00.000Z');

    // No database-style columns in the DTO
    assert.equal(result.owner_id, undefined);
    assert.equal(result.created_at, undefined);
});

test('listProjectsByOwner returns an array of DTOs', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const result = await service.listProjectsByOwner('user-1');

    assert.equal(repo.calls[0].fn, 'listProjectsByOwner');
    assert.equal(repo.calls[0].args, 'user-1');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'proj-1');
    assert.equal(result[0].ownerId, 'user-1');
    assert.equal(result[0].createdAt, '2024-01-15T10:05:00.000Z');
});

test('getProject returns a DTO when the project exists', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const result = await service.getProject('proj-1');

    assert.equal(repo.calls[0].fn, 'getProjectById');
    assert.equal(result.id, 'proj-1');
    assert.equal(result.ownerId, 'user-1');
    assert.equal(result.createdAt, '2024-01-15T10:05:00.000Z');
});

test('getProject returns null when the project does not exist', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const result = await service.getProject('no-such-project');

    assert.equal(repo.calls[0].fn, 'getProjectById');
    assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// Task operations
// ---------------------------------------------------------------------------

test('createTask calls insertTask and returns a DTO', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const input = {
        projectId: 'proj-1',
        title: 'Read chapter 3',
        status: 'todo',
    };
    const result = await service.createTask(input);

    assert.equal(repo.calls[0].fn, 'insertTask');
    assert.deepEqual(repo.calls[0].args, input);

    // DTO should convert project_id → projectId and created_at → createdAt
    assert.equal(result.id, 'task-1');
    assert.equal(result.projectId, 'proj-1');
    assert.equal(result.title, 'Read chapter 3');
    assert.equal(result.status, 'todo');
    assert.equal(result.createdAt, '2024-01-15T10:10:00.000Z');

    // No database-style columns
    assert.equal(result.project_id, undefined);
    assert.equal(result.created_at, undefined);
});

test('listTasksByProject returns an array of DTOs', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const result = await service.listTasksByProject('proj-1', { limit: 10, offset: 0 });

    assert.equal(repo.calls[0].fn, 'listTasksByProject');
    assert.equal(repo.calls[0].args, 'proj-1');
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'task-1');
    assert.equal(result[0].projectId, 'proj-1');
    assert.equal(result[0].createdAt, '2024-01-15T10:10:00.000Z');
});

test('updateTaskStatus calls updateTaskStatus and returns a DTO', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const result = await service.updateTaskStatus('task-1', 'done');

    assert.equal(repo.calls[0].fn, 'updateTaskStatus');
    assert.deepEqual(repo.calls[0].args, { id: 'task-1', status: 'done' });
    assert.equal(result.id, 'task-1');
    assert.equal(result.status, 'done');
    assert.equal(result.createdAt, '2024-01-15T10:10:00.000Z');
});

test('updateTaskStatus returns null when the task does not exist', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const result = await service.updateTaskStatus('no-such-task', 'done');

    assert.equal(repo.calls[0].fn, 'updateTaskStatus');
    assert.equal(result, null);
});
