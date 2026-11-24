// test/app-validation.test.mjs
//
// S6 Build 2 — Tests for input validation in the application service.
//
// Two groups of tests:
//   1. Direct helper tests — validateRequired, validateEmail,
//      validateStatus each catch the right failures.
//   2. Service operation tests — invalid input throws ValidationError
//      AND the repository is never called. Valid input passes through
//      to the repository normally.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    ValidationError,
    validateRequired,
    validateEmail,
    validateStatus,
} from '../src/app-validation.mjs';
import { createAppService } from '../src/app-service.mjs';

// ---------------------------------------------------------------------------
// Mock repository — minimal, just tracks calls.
// ---------------------------------------------------------------------------

function createMockRepo() {
    const calls = [];

    return {
        calls,

        async insertUser(input) {
            calls.push({ fn: 'insertUser', args: input });
            return { id: 'u1', email: input.email, name: input.name, created_at: '2024-01-01T00:00:00.000Z' };
        },

        async getUserByEmail(email) {
            calls.push({ fn: 'getUserByEmail', args: email });
            return { id: 'u1', email, name: 'Alice', created_at: '2024-01-01T00:00:00.000Z' };
        },

        async insertProject(input) {
            calls.push({ fn: 'insertProject', args: input });
            return { id: 'p1', owner_id: input.ownerId, name: input.name, description: input.description, created_at: '2024-01-01T00:00:00.000Z' };
        },

        async insertTask(input) {
            calls.push({ fn: 'insertTask', args: input });
            return { id: 't1', project_id: input.projectId, title: input.title, status: input.status, created_at: '2024-01-01T00:00:00.000Z' };
        },

        async updateTaskStatus(id, status) {
            calls.push({ fn: 'updateTaskStatus', args: { id, status } });
            return { id, project_id: 'p1', title: 'Task', status, created_at: '2024-01-01T00:00:00.000Z' };
        },
    };
}

// ---------------------------------------------------------------------------
// Part 1: validateRequired helper
// ---------------------------------------------------------------------------

test('validateRequired passes when all fields are present and non-empty', () => {
    const input = { email: 'a@b.com', name: 'Alice', passwordHash: 'hash' };
    // Should not throw
    validateRequired(input, ['email', 'name', 'passwordHash']);
});

test('validateRequired throws when a field is missing', () => {
    const input = { name: 'Alice', passwordHash: 'hash' };
    assert.throws(
        () => validateRequired(input, ['email', 'name', 'passwordHash']),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.field, 'email');
            assert.match(err.message, /required/);
            return true;
        },
    );
});

test('validateRequired throws when a field is null', () => {
    const input = { email: null, name: 'Alice' };
    assert.throws(
        () => validateRequired(input, ['email', 'name']),
        (err) => err.field === 'email' && err instanceof ValidationError,
    );
});

test('validateRequired throws when a field is not a string', () => {
    const input = { email: 123, name: 'Alice' };
    assert.throws(
        () => validateRequired(input, ['email', 'name']),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.field, 'email');
            assert.match(err.message, /must be a string/);
            return true;
        },
    );
});

test('validateRequired throws when a field is an empty string', () => {
    const input = { email: '', name: 'Alice' };
    assert.throws(
        () => validateRequired(input, ['email', 'name']),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.field, 'email');
            assert.match(err.message, /must not be empty/);
            return true;
        },
    );
});

test('validateRequired throws when a field is whitespace only', () => {
    const input = { email: '   ', name: 'Alice' };
    assert.throws(
        () => validateRequired(input, ['email', 'name']),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.field, 'email');
            assert.match(err.message, /must not be empty/);
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// Part 1: validateEmail helper
// ---------------------------------------------------------------------------

test('validateEmail passes a valid email', () => {
    // Should not throw
    validateEmail('alice@example.com');
});

test('validateEmail throws when there is no @', () => {
    assert.throws(
        () => validateEmail('not-an-email'),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.field, 'email');
            assert.match(err.message, /must contain "@"/);
            return true;
        },
    );
});

test('validateEmail throws when there are multiple @', () => {
    assert.throws(
        () => validateEmail('a@b@c.com'),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.field, 'email');
            return true;
        },
    );
});

test('validateEmail throws when there is no domain after @', () => {
    assert.throws(
        () => validateEmail('user@'),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.field, 'email');
            assert.match(err.message, /domain/);
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// Part 1: validateStatus helper
// ---------------------------------------------------------------------------

test('validateStatus passes for each allowed value', () => {
    validateStatus('todo');
    validateStatus('in_progress');
    validateStatus('done');
});

test('validateStatus throws for an invalid status', () => {
    assert.throws(
        () => validateStatus('archived'),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.field, 'status');
            assert.match(err.message, /must be one of/);
            return true;
        },
    );
});

// ---------------------------------------------------------------------------
// Part 2: Service operations — invalid input rejects without calling repo
// ---------------------------------------------------------------------------

test('createUser throws ValidationError when email is missing, repo not called', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    await assert.rejects(
        service.createUser({ name: 'Alice', passwordHash: 'hash' }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.field, 'email');
            return true;
        },
    );

    // The repository should NOT have been called
    assert.equal(repo.calls.length, 0);
});

test('createUser throws ValidationError when email is malformed, repo not called', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    await assert.rejects(
        service.createUser({ email: 'not-an-email', name: 'Alice', passwordHash: 'hash' }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.field, 'email');
            return true;
        },
    );

    assert.equal(repo.calls.length, 0);
});

test('createUser calls repo and returns DTO when input is valid', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const result = await service.createUser({
        email: 'alice@example.com',
        name: 'Alice',
        passwordHash: 'hash',
    });

    // Repo was called once with the input
    assert.equal(repo.calls.length, 1);
    assert.equal(repo.calls[0].fn, 'insertUser');

    // Returns a clean DTO
    assert.equal(result.id, 'u1');
    assert.equal(result.email, 'alice@example.com');
    assert.equal(result.createdAt, '2024-01-01T00:00:00.000Z');
});

test('getUserByEmail throws ValidationError when email is malformed, repo not called', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    await assert.rejects(
        service.getUserByEmail('bad-email'),
        (err) => err instanceof ValidationError && err.field === 'email',
    );

    assert.equal(repo.calls.length, 0);
});

test('getUserByEmail calls repo and returns DTO when email is valid', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const result = await service.getUserByEmail('alice@example.com');

    assert.equal(repo.calls.length, 1);
    assert.equal(result.id, 'u1');
    assert.equal(result.email, 'alice@example.com');
});

test('createProject throws ValidationError when name is missing, repo not called', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    await assert.rejects(
        service.createProject({ ownerId: 'u1' }),
        (err) => err instanceof ValidationError && err.field === 'name',
    );

    assert.equal(repo.calls.length, 0);
});

test('createProject calls repo and returns DTO when input is valid', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const result = await service.createProject({
        ownerId: 'u1',
        name: 'Reading List',
        description: 'Books to read',
    });

    assert.equal(repo.calls.length, 1);
    assert.equal(repo.calls[0].fn, 'insertProject');
    assert.equal(result.id, 'p1');
    assert.equal(result.ownerId, 'u1');
});

test('createTask throws ValidationError when status is invalid, repo not called', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    await assert.rejects(
        service.createTask({ projectId: 'p1', title: 'Task', status: 'archived' }),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.field, 'status');
            return true;
        },
    );

    assert.equal(repo.calls.length, 0);
});

test('createTask throws ValidationError when title is missing, repo not called', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    await assert.rejects(
        service.createTask({ projectId: 'p1', status: 'todo' }),
        (err) => err instanceof ValidationError && err.field === 'title',
    );

    assert.equal(repo.calls.length, 0);
});

test('createTask calls repo and returns DTO when input is valid', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const result = await service.createTask({
        projectId: 'p1',
        title: 'Read chapter 3',
        status: 'todo',
    });

    assert.equal(repo.calls.length, 1);
    assert.equal(repo.calls[0].fn, 'insertTask');
    assert.equal(result.id, 't1');
    assert.equal(result.projectId, 'p1');
    assert.equal(result.status, 'todo');
});

test('updateTaskStatus throws ValidationError when status is invalid, repo not called', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    await assert.rejects(
        service.updateTaskStatus('t1', 'archived'),
        (err) => {
            assert.ok(err instanceof ValidationError);
            assert.equal(err.field, 'status');
            return true;
        },
    );

    assert.equal(repo.calls.length, 0);
});

test('updateTaskStatus calls repo and returns DTO when status is valid', async () => {
    const repo = createMockRepo();
    const service = createAppService(repo);

    const result = await service.updateTaskStatus('t1', 'done');

    assert.equal(repo.calls.length, 1);
    assert.equal(repo.calls[0].fn, 'updateTaskStatus');
    assert.equal(result.id, 't1');
    assert.equal(result.status, 'done');
});
