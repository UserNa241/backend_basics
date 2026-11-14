import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPool, dbPool } from '../../src/db/pool.mjs';

test('exports createPool as a function and dbPool as a Pool instance', () => {
    assert.equal(typeof createPool, 'function');
    assert.equal(dbPool.constructor.name, 'BoundPool');
});

test('dbPool is configured with the correct default values', () => {
    const config = dbPool.options;

    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 5432);
    assert.equal(config.database, 'web_product');
    assert.equal(config.user, 'app_user');
    assert.equal(config.max, 10);
    assert.equal(config.idleTimeoutMillis, 30_000);
    assert.equal(config.connectionTimeoutMillis, 5_000);
});

test('createPool applies custom options correctly', () => {
    const customPool = createPool({
        host: '10.0.0.1',
        port: 5433,
        database: 'test_db',
        user: 'test_user',
        password: 'test_pass',
        max: 5,
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 2_000,
    });

    assert.equal(customPool.options.host, '10.0.0.1');
    assert.equal(customPool.options.port, 5433);
    assert.equal(customPool.options.database, 'test_db');
    assert.equal(customPool.options.user, 'test_user');
    assert.equal(customPool.options.password, 'test_pass');
    assert.equal(customPool.options.max, 5);
    assert.equal(customPool.options.idleTimeoutMillis, 10_000);
    assert.equal(customPool.options.connectionTimeoutMillis, 2_000);

    customPool.end();
});

test('createPool uses defaults for missing options', () => {
    const partialPool = createPool({ host: '192.168.1.1' });

    assert.equal(partialPool.options.host, '192.168.1.1');
    assert.equal(partialPool.options.port, 5432);
    assert.equal(partialPool.options.database, 'web_product');
    assert.equal(partialPool.options.user, 'app_user');
    assert.equal(partialPool.options.max, 10);

    partialPool.end();
});

test('createPool rejects null options', () => {
    assert.throws(() => createPool(null), {
        message: 'Database pool options must be an object',
    });
});

test('createPool rejects array options', () => {
    assert.throws(() => createPool([]), {
        message: 'Database pool options must be an object',
    });
});

test('createPool rejects empty host', () => {
    assert.throws(() => createPool({ host: '' }), {
        message: 'Database pool host must be a non-empty string',
    });
});

test('createPool rejects invalid port', () => {
    assert.throws(() => createPool({ port: 0 }), {
        message: 'Database pool port must be between 1 and 65535',
    });
    assert.throws(() => createPool({ port: 70_000 }), {
        message: 'Database pool port must be between 1 and 65535',
    });
    assert.throws(() => createPool({ port: 3.5 }), {
        message: 'Database pool port must be between 1 and 65535',
    });
});

test('createPool rejects empty database name', () => {
    assert.throws(() => createPool({ database: '' }), {
        message: 'Database pool database must be a non-empty string',
    });
});

test('createPool rejects empty user', () => {
    assert.throws(() => createPool({ user: '' }), {
        message: 'Database pool user must be a non-empty string',
    });
});

test('createPool rejects non-string password', () => {
    assert.throws(() => createPool({ password: 12345 }), {
        message: 'Database pool password must be a string',
    });
});

test('createPool rejects invalid max connections', () => {
    assert.throws(() => createPool({ max: 0 }), {
        message: 'Database pool max connections must be between 1 and 200',
    });
    assert.throws(() => createPool({ max: 999 }), {
        message: 'Database pool max connections must be between 1 and 200',
    });
});

test('createPool rejects invalid idleTimeoutMillis', () => {
    assert.throws(() => createPool({ idleTimeoutMillis: -1 }), {
        message: 'Database pool idleTimeoutMillis must be a non-negative integer',
    });
});

test('createPool rejects invalid connectionTimeoutMillis', () => {
    assert.throws(() => createPool({ connectionTimeoutMillis: 0 }), {
        message: 'Database pool connectionTimeoutMillis must be a positive integer',
    });
});
