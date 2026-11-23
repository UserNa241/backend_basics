import { Pool } from 'pg';

import {
    SEED_USERS,
    SEED_PROJECTS,
    SEED_TASKS,
} from './seed-data.mjs';

async function seedDatabase(pool) {
    const client = await pool.connect();

    try {
        // Clear existing data in reverse dependency order:
        // tasks depend on projects, projects depend on users.
        // Delete children first so foreign keys are satisfied.
        await client.query('DELETE FROM tasks');
        await client.query('DELETE FROM projects');
        await client.query('DELETE FROM users');

        // Insert users — ON CONFLICT DO NOTHING makes this safe to re-run
        for (const user of SEED_USERS) {
            await client.query(
                `INSERT INTO users (id, email, name, password_hash)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (id) DO NOTHING`,
                [user.id, user.email, user.name, user.passwordHash],
            );
        }

        // Insert projects — same conflict handling
        for (const project of SEED_PROJECTS) {
            await client.query(
                `INSERT INTO projects (id, owner_id, name, description)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (id) DO NOTHING`,
                [project.id, project.owner_id, project.name, project.description],
            );
        }

        // Insert tasks — same conflict handling
        for (const task of SEED_TASKS) {
            await client.query(
                `INSERT INTO tasks (id, project_id, title, status)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (id) DO NOTHING`,
                [task.id, task.project_id, task.title, task.status],
            );
        }

        return {
            users: SEED_USERS.length,
            projects: SEED_PROJECTS.length,
            tasks: SEED_TASKS.length,
        };
    } finally {
        client.release();
    }
}

export { seedDatabase };

const isDirectRun = process.argv[1] &&
    import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectRun) {
    const pool = new Pool({
        host: '127.0.0.1',
        port: 5432,
        database: 'web_product',
        user: 'app_user',
        password: 'app_password',
        max: 5,
    });

    try {
        const result = await seedDatabase(pool);

        console.log(`Seed complete:`);
        console.log(`  ✓ ${result.users} users`);
        console.log(`  ✓ ${result.projects} projects`);
        console.log(`  ✓ ${result.tasks} tasks`);
    } catch (error) {
        console.error('Seed failed:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}
