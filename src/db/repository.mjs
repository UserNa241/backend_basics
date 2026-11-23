import { dbPool } from './pool.mjs';

export function createRepository(pool = dbPool) {

    async function insertUser({ email, name, passwordHash }) {
        const result = await pool.query(
            `INSERT INTO users (email, name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, created_at`,
            [email, name, passwordHash],
        );

        return result.rows[0];
    }

    async function getUserByEmail(email) {
        const result = await pool.query(
            `SELECT id, email, name, created_at
       FROM users
       WHERE email = $1`,
            [email],
        );

        return result.rows[0] || null;
    }

    async function getUserById(id) {
        const result = await pool.query(
            `SELECT id, email, name, created_at
       FROM users
       WHERE id = $1`,
            [id],
        );

        return result.rows[0] || null;
    }

    async function listUsers({ limit = 10, offset = 0 } = {}) {
        const result = await pool.query(
            `SELECT id, email, name, created_at
       FROM users
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
            [limit, offset],
        );

        return result.rows;
    }

    async function insertProject({ ownerId, name, description }) {
        const result = await pool.query(
            `INSERT INTO projects (owner_id, name, description)
       VALUES ($1, $2, $3)
       RETURNING *`,
            [ownerId, name, description],
        );

        return result.rows[0];
    }

    async function listProjectsByOwner(ownerId) {
        const result = await pool.query(
            `SELECT * FROM projects
       WHERE owner_id = $1
       ORDER BY created_at DESC`,
            [ownerId],
        );

        return result.rows;
    }

    async function getProjectById(id) {
        const result = await pool.query(
            `SELECT * FROM projects
       WHERE id = $1`,
            [id],
        );

        return result.rows[0] || null;
    }

    async function updateProject(id, { name, description }) {
        const result = await pool.query(
            `UPDATE projects
       SET name = $2, description = $3
       WHERE id = $1
       RETURNING *`,
            [id, name, description],
        );

        return result.rows[0] || null;
    }

    async function deleteProject(id) {
        const result = await pool.query(
            `DELETE FROM projects
       WHERE id = $1
       RETURNING *`,
            [id],
        );

        return result.rows[0] || null;
    }

    async function insertTask({ projectId, title, status }) {
        const result = await pool.query(
            `INSERT INTO tasks (project_id, title, status)
       VALUES ($1, $2, $3)
       RETURNING *`,
            [projectId, title, status],
        );

        return result.rows[0];
    }

    async function listTasksByProject(projectId, { limit = 10, offset = 0 } = {}) {
        const result = await pool.query(
            `SELECT * FROM tasks
       WHERE project_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
            [projectId, limit, offset],
        );

        return result.rows;
    }

    async function getTaskById(id) {
        const result = await pool.query(
            `SELECT * FROM tasks
       WHERE id = $1`,
            [id],
        );

        return result.rows[0] || null;
    }

    async function updateTaskStatus(id, status) {
        const result = await pool.query(
            `UPDATE tasks
       SET status = $2
       WHERE id = $1
       RETURNING *`,
            [id, status],
        );

        return result.rows[0] || null;
    }

    async function deleteTask(id) {
        const result = await pool.query(
            `DELETE FROM tasks
       WHERE id = $1
       RETURNING *`,
            [id],
        );

        return result.rows[0] || null;
    }

    return {
        insertUser,
        getUserByEmail,
        getUserById,
        listUsers,
        insertProject,
        listProjectsByOwner,
        getProjectById,
        updateProject,
        deleteProject,
        insertTask,
        listTasksByProject,
        getTaskById,
        updateTaskStatus,
        deleteTask,
    };
}
