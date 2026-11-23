import {readdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from "node:url";
import {join, dirname} from 'node:path';
import {Pool} from 'pg';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
const migrationsTable = 'schema_migrations';

function parseMigrationFile (fileContent) {

    const lines = fileContent.split('\n');
    const upIndex = lines.findIndex((line) => line.trim() === '-- up');

    if (upIndex === -1) {
        throw new Error('Migration file is missing the "-- up" section');
    }

    const downIndex = lines.findIndex(
        (line, index) => index > upIndex && line.trim() === '-- down',
    );

    const upLines = downIndex === -1 ? lines.slice(upIndex + 1) : lines.slice(upIndex + 1, downIndex);

    const downLines = downIndex === -1 ? [] : lines.slice(downIndex + 1);

    return {
        up : upLines.join('\n').trim(),
        down : downLines.join('\n').trim(),
    };
}

async function ensureMigrationsTable(client) {
    await client.query(`
    CREATE TABLE IF NOT EXISTS ${migrationsTable} (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW() 
    )`
    );
}

async function migrateUp(pool) {
    const client = await pool.connect();

    try {
        await ensureMigrationsTable(client);

        const files = (await readdir(migrationsDir))
            .filter((file) => file.endsWith('.sql')).sort();

        const {rows} = await client.query(
            `SELECT version FROM ${migrationsTable}`,
        );

        const appliedVersions = new Set(rows.map ((row) => row.version));

        const pending = files.filter((file) => !appliedVersions.has(file));

        if (pending.length === 0) {
            return {applied: [], skipped: files.length};
        }

        const applied = [];

        for (const file of pending) {
            const fileContent = await readFile(join(migrationsDir, file), 'utf-8');
            const {up} = parseMigrationFile(fileContent);

            await client.query('BEGIN');

            try {
                await client.query(up);
                await client.query(`
                INSERT INTO ${migrationsTable} (version) VALUES ($1)`, [file],
                );
                await client.query('COMMIT');
                applied.push(file);
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
        }
        return {applied, skipped: files.length - applied.length};

    } finally {
        client.release();
    }

}

async function migrateDown (pool, count = 1) {
    const client = await pool.connect();

    try {
        await ensureMigrationsTable(client);

        const {rows} = await client.query(
            `SELECT version FROM ${migrationsTable}
             ORDER BY version DESC LIMIT $1`,
            [count],
        );

        const toRollback = rows.map((row) => row.version);

        if (toRollback.length === 0) {
            return {rolledBack: []};
        }

        const rolledBack = [];

        for (const file of toRollback) {
            const fileContent = await readFile(join(migrationsDir, file), 'utf-8');
            const {down} = parseMigrationFile(fileContent);

            if (!down) {
                continue;
            }

            await client.query('BEGIN');

            try {
                await client.query(down);
                await client.query(
                    `DELETE FROM ${migrationsTable} WHERE version = $1`, [file],
                );
                await client.query('COMMIT');
                rolledBack.push(file);
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
        }
        return {rolledBack};
    } finally {
        client.release();
    }
}

export {migrateUp, migrateDown, parseMigrationFile, migrationsTable};

const isDirectRun = process.argv[1] &&  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
    const pool = new Pool ({
        host: '127.0.0.1',
        port: 5432,
        database: 'web_product',
        user: 'app_user',
        password: 'mission',
        max: 5,
    });

    try {
        const result = await migrateUp(pool);

        if (result.applied.length > 0) {
            console.log(`Applied ${result.applied.length} migration(s):`);
            for(const file of result.applied) {
                console.log(`   ${file}`);
            }
        } else {
            console.log('No pending migrations. Database is up to date');
        }
    } catch (error) {
        console.log('Migration failed:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}
