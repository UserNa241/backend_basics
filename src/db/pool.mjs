import {Pool, types} from 'pg';

const DEFAULT_DB_HOST = '127.0.0.1';
const DEFAULT_DB_PORT = 5432;
const DEFAULT_DB_NAME = 'web_product';
const DEFAULT_DB_USER = 'app_user';
const DEFAULT_DB_PASSWORD = 'mission';
const DEFAULT_DB_MAX_CONNECTIONS = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

export function createPool (options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('Database pool options must be an object');
    }

    const {
        host = DEFAULT_DB_HOST,
        port = DEFAULT_DB_PORT,
        database = DEFAULT_DB_NAME,
        user = DEFAULT_DB_USER,
        password = DEFAULT_DB_PASSWORD,
        max = DEFAULT_DB_MAX_CONNECTIONS,
        idleTimeoutMillis = DEFAULT_IDLE_TIMEOUT_MS,
        connectionTimeoutMillis = DEFAULT_CONNECTION_TIMEOUT_MS,
    } = options;

    if (typeof host !== 'string' || host.trim() === '') {
        throw new TypeError('Database pool host must be a non-empty string');
    }

    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new RangeError('Database pool port must be between 1 and 65535');
    }

    if (typeof database !== 'string' || database.trim() === '') {
        throw new TypeError('Database pool database must be a non-empty string');
    }

    if (typeof user !== 'string' || user.trim() === '') {
        throw new TypeError('Database pool user must be a non-empty string');
    }

    if (typeof password !== 'string') {
        throw new TypeError('Database pool password must be a string');
    }

    if (!Number.isInteger(max) || max < 1 || max > 200) {
        throw new RangeError('Database pool max connections must be between 1 and 200');
    }

    if (!Number.isInteger(idleTimeoutMillis) || idleTimeoutMillis < 0) {
        throw new RangeError('Database pool idleTimeoutMillis must be a non-negative integer');
    }

    if (!Number.isInteger(connectionTimeoutMillis) || connectionTimeoutMillis < 1) {
        throw new RangeError('Database pool connectionTimeoutMillis must be a positive integer')
    }

    const pool = new Pool({
        host,
        port,
        database,
        user,
        password,
        max,
        idleTimeoutMillis,
        connectionTimeoutMillis,
    });
    return pool;
}

export const dbPool = createPool();
