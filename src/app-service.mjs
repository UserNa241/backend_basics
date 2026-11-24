// src/app-service.mjs
//
// S6 Build 1 — The Application Service.
//
// This is the middle layer of the slice:
//
//   Handler  →  Application Service  →  Repository  →  Database
//
// The handler knows HTTP. The repository knows SQL.
// The application service knows the domain: it calls the right
// repository function, gets a raw driver record back, maps it to a
// clean DTO, and returns that DTO to the handler.
//
// The service depends on the repository's interface, not on the
// database. That boundary is the seam (S6 Lesson 8): in production
// you pass the real repository, in a test you pass a mock, and the
// service code is identical in both cases.

// The service depends on the repository's interface, not on the
// database. That boundary is the seam (S6 Lesson 8): in production
// you pass the real repository, in a test you pass a mock, and the
// service code is identical in both cases.

import {
    validateEmail,
    validateRequired,
    validateStatus,
} from "./app-validation.mjs";

/**
 * Converts a raw user row from the database into a client-facing DTO.
 *
 * The driver record uses database naming: snake_case columns like
 * `created_at`. The client should see clean, predictable naming:
 * camelCase like `createdAt`. This helper does that translation.
 *
 * Note: the repository's RETURNING clause already excludes
 * password_hash, so no secret data reaches this mapping. The DTO
 * shape is explicit here so the client contract is clear.
 *
 * @param {object} row - The raw user record from the repository.
 * @returns {object} A clean DTO: { id, email, name, createdAt }.
 */
function toUserDto(row) {
    return {
        id : row.id,
        email: row.email,
        name: row.name,
        createdAt: row.created_at,
    };
}

/**
 * Converts a raw project row from the database into a client-facing DTO.
 *
 * The raw record has `owner_id` and `created_at` (database naming).
 * The DTO converts these to `ownerId` and `createdAt` (client naming).
 *
 * @param {object} row - The raw project record from the repository.
 * @returns {object} A clean DTO: { id, ownerId, name, description, createdAt }.
 */
function toProjectDto(row) {
    return {
        id: row.id,
        ownerId: row.owner_id,
        name: row.name,
        description: row.description,
        createdAt: row.created_at,
    };
}

/**
 * Converts a raw task row from the database into a client-facing DTO.
 *
 * The raw record has `project_id` and `created_at` (database naming).
 * The DTO converts these to `projectId` and `createdAt` (client naming).
 *
 * @param {object} row - The raw task record from the repository.
 * @returns {object} A clean DTO: { id, projectId, title, status, createdAt }.
 */
function toTaskDto(row) {
    return {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        status: row.status,
        createdAt: row.created_at,
    }
}

/**
 * Creates an application service bound to a repository.
 *
 * @param {object} repo - A repository object with CRUD functions
 *   (insertUser, listTasksByProject, etc.). In production this is
 *   the real repository from src/db/repository.mjs. In a test it
 *   can be a mock that returns predictable records.
 *
 * @returns {object} An object containing all application operations,
 *   grouped by domain: users, projects, and tasks.
 */
export function createAppService(repo) {
    // --- User operations ---

    /**
     * Creates a new user.
     *
     * Step 1: Call the repository to insert the user.
     * Step 2: The repository returns a raw driver record.
     * Step 3: Map the raw record to a clean DTO.
     * Step 4: Return the DTO.
     *
     * @param {object} input - { email, name, passwordHash }
     * @returns {Promise<object>} The created user as a DTO.
     */
    async function createUser(input) {
        //Validate required fields are present and non-empty strings
        validateRequired(input, ['email', 'name', 'passwordHash']);

        //Validate the email looks like email
        validateEmail(input.email);

        const row = await repo.insertUser(input);
        return toUserDto(row);
    }

    /**
     * Finds a single user by email.
     *
     * The repository returns null when no row matches,
     * so we check for that and pass null through.
     *
     * @param {string} email - The email to search for.
     * @returns {Promise<object>} The user as a DTO, or null if not found.
     */
    async function getUserByEmail(email) {
        //Validate email looks like email
        validateEmail(email);

        const row = await repo.getUserByEmail(email);
        return row ? toUserDto(row) : null;
    }

    /**
     * Lists users with optional pagination.
     *
     * The repository returns an array of records,
     * so we map each row to a DTO using map().
     *
     * @param {object} [options] - { limit, offset }
     * @returns {Promise<object[]>} An array of user DTOs.
     */
    async function listUsers(options = {}) {
        const rows = await repo.listUsers(options);
        return rows.map(toUserDto);
    }

    // --- Project operations ---

    /**
     * Creates a new project.
     *
     * Same pattern as createUser: call the repository,
     * get the raw record back, map it to a DTO, return it.
     *
     * @param {object} input - { ownerId, name, description }
     * @returns {Promise<object>} The created project as a DTO.
     */
    async function createProject(input) {
        //Validate required fields are present and non-empty strings
        validateRequired(input, ['ownerId', 'name']);

        const row = await repo.insertProject(input);
        return toProjectDto(row);
    }

    /**
     * Lists all projects owned by a given user.
     *
     * The repository returns an array, so we map each row
     * through toProjectDto, just like listUsers.
     *
     * @param {string} ownerId - The owner's user ID.
     * @returns {Promise<object[]>} An array of project DTOs.
     */
    async function listProjectsByOwner(ownerId) {
        const rows = await repo.listProjectsByOwner(ownerId);
        return rows.map(toProjectDto);
    }

    /**
     * Gets a single project by ID.
     *
     * Same "not found" handling as getUserByEmail:
     * if the repository returns null, pass null through.
     *
     * @param {string} id - The project ID.
     * @returns {Promise<object>} The project DTO, or null if not found.
     */
    async function getProject(id) {
        const row = await repo.getProjectById(id);
        return row ? toProjectDto(row) : null;
    }

    // --- Task operations ---

    /**
     * Creates a new task in a project.
     *
     * Same create pattern as createUser and createProject:
     * call the repository, map the raw record, return the DTO.
     *
     * @param {object} input - { projectId, title, status }
     * @returns {Promise<object>} The created task as a DTO.
     */
    async function createTask(input) {
        //Validate required fields are present and non-empty strings
        validateRequired(input, ['projectId', 'title', 'status']);

        //Validate the status is one of the allowed values
        validateStatus(input.status);

        const row = await repo.insertTask(input);
        return toTaskDto(row);
    }

    /**
     * Lists all tasks in a project with optional pagination.
     *
     * The repository returns an array, so we map each row
     * through toTaskDto, just like listUsers and listProjectsByOwner.
     *
     * @param {string} projectId - The project ID.
     * @param {object} [options] - { limit, offset }
     * @returns {Promise<object[]>} An array of task DTOs.
     */
    async function listTasksByProject(projectId, options = {}) {
        const rows = await repo.listTasksByProject(projectId, options);
        return rows.map(toTaskDto);
    }

    /**
     * Updates a task's status.
     *
     * Same "not found" handling as getUserByEmail and getProject:
     * if the repository returns null, pass null through.
     *
     * @param {string} id - The task ID.
     * @param {string} status - The new status: 'todo', 'in_progress', or 'done'.
     * @returns {Promise<object>} The updated task as a DTO, or null if not found.
     */
    async function updateTaskStatus (id, status) {
        //Validate the status is one of the allowed values
        validateStatus(status);

        const row = await repo.updateTaskStatus(id, status);
        return row ? toTaskDto(row) : null;
    }

    return {
        //user operations
        createUser,
        listUsers,
        getUserByEmail,

        //project operations
        createProject,
        getProject,
        listProjectsByOwner,

        //task operations
        createTask,
        updateTaskStatus,
        listTasksByProject,

    };
}
