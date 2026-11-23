-- 003_create_tasks.sql
-- Creates the tasks table with a foreign key to projects,
-- a CHECK constraint for status, and a composite index for pagination.

-- up
CREATE TABLE IF NOT EXISTS tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo'
        CHECK (status IN ('todo', 'in_progress', 'done')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_created
    ON tasks(project_id, created_at DESC);

-- down
DROP TABLE IF EXISTS tasks;
