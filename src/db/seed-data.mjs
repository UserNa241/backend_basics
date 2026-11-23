// ---------------------------------------------------------------------------
// Seed data definition — deterministic test data for development and testing.
//
// Fixed UUIDs mean the seed is repeatable: the same rows are inserted every
// time, on every machine. ON CONFLICT DO NOTHING (handled by the seed runner)
// makes re-running safe.
//
// Password hashes here are test-only placeholders — never used in production.
// ---------------------------------------------------------------------------

export const SEED_USER_IDS = {
    alice: '11111111-1111-1111-1111-111111111111',
    bob: '22222222-2222-2222-2222-222222222222',
    carol: '33333333-3333-3333-3333-333333333333',
};

export const SEED_PROJECT_IDS = {
    readingList: 'aaaa1111-1111-1111-1111-111111111111',
    researchNotes: 'bbbb2222-2222-2222-2222-222222222222',
    sideProject: 'cccc3333-3333-3333-3333-333333333333',
};

export const SEED_TASK_IDS = {
    readChapter1: 'dddd4444-4444-4444-4444-444444444444',
    readChapter2: 'eeee5555-5555-5555-5555-555555555555',
    writeSummary: 'ffff6666-6666-6666-6666-666666666666',
    findSources: '99997777-7777-7777-7777-777777777777',
    setupEnvironment: '88888888-8888-8888-8888-888888888888',
};

export const TEST_PASSWORD_HASH = '$argon2id$test-only-placeholder-hash';

export const SEED_USERS = [
    {
        id: SEED_USER_IDS.alice,
        email: 'alice@example.com',
        name: 'Alice',
        passwordHash: TEST_PASSWORD_HASH,
    },
    {
        id: SEED_USER_IDS.bob,
        email: 'bob@example.com',
        name: 'Bob',
        passwordHash: TEST_PASSWORD_HASH,
    },
    {
        id: SEED_USER_IDS.carol,
        email: 'carol@example.com',
        name: 'Carol',
        passwordHash: TEST_PASSWORD_HASH,
    },
];

export const SEED_PROJECTS = [
    {
        id: SEED_PROJECT_IDS.readingList,
        owner_id: SEED_USER_IDS.alice,
        name: 'Reading List',
        description: "Alice's main reading project",
    },
    {
        id: SEED_PROJECT_IDS.researchNotes,
        owner_id: SEED_USER_IDS.alice,
        name: 'Research Notes',
        description: "Alice's research and notes",
    },
    {
        id: SEED_PROJECT_IDS.sideProject,
        owner_id: SEED_USER_IDS.bob,
        name: 'Side Project',
        description: "Bob's side project for isolation testing",
    },
];

export const SEED_TASKS = [
    {
        id: SEED_TASK_IDS.readChapter1,
        project_id: SEED_PROJECT_IDS.readingList,
        title: 'Read chapter 1',
        status: 'done',
    },
    {
        id: SEED_TASK_IDS.readChapter2,
        project_id: SEED_PROJECT_IDS.readingList,
        title: 'Read chapter 2',
        status: 'in_progress',
    },
    {
        id: SEED_TASK_IDS.writeSummary,
        project_id: SEED_PROJECT_IDS.readingList,
        title: 'Write summary',
        status: 'todo',
    },
    {
        id: SEED_TASK_IDS.findSources,
        project_id: SEED_PROJECT_IDS.researchNotes,
        title: 'Find sources',
        status: 'todo',
    },
    {
        id: SEED_TASK_IDS.setupEnvironment,
        project_id: SEED_PROJECT_IDS.sideProject,
        title: 'Setup environment',
        status: 'done',
    },
];
