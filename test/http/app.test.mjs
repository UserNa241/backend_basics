import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createVanillaApp } from '../../src/app.mjs';

async function createAppFixture() {
    const workspaceDir = await mkdtemp(
        path.join(tmpdir(), 'vanilla-app-test-'),
    );
    const publicDir = path.join(workspaceDir, 'public');

    await mkdir(publicDir, { recursive: true });
    await writeFile(
        path.join(publicDir, 'hello.css'),
        'body { color: teal; }\n',
        'utf8',
    );

    const app = createVanillaApp({
        serverConfig: {
            host: '127.0.0.1',
            port: 0,
        },
        publicRootDir: publicDir,
        routes: [
            {
                method: 'GET',
                pattern: '/api/hello',
                handler: async (ctx) => {
                    ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
                    ctx.res.end(JSON.stringify({ message: 'hello' }));
                },
            },
            {
                method: 'POST',
                pattern: '/api/echo',
                handler: async (ctx) => {
                    ctx.res.writeHead(200, { 'Content-Type': 'application/json' });
                    ctx.res.end(JSON.stringify({ received: ctx.body }));
                },
            },
        ],
        middlewares: [],
    });

    await app.start();
    const address = app.core.server.address();
    const port = address.port;

    return { workspaceDir, publicDir, app, port };
}

test('normal JSON GET request returns 200 with correct body', async () => {
    const { workspaceDir, app, port } = await createAppFixture();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/hello`);
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'application/json');
        assert.deepEqual(body, { message: 'hello' });
    } finally {
        await app.stop();
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('static asset delivery returns 200 with correct headers and body', async () => {
    const { workspaceDir, app, port } = await createAppFixture();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/assets/hello.css`);
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8');
        assert.equal(response.headers.get('content-length'), '22');
        assert.equal(body, 'body { color: teal; }\n');
    } finally {
        await app.stop();
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('HEAD on static asset returns 200 with headers and no body', async () => {
    const { workspaceDir, app, port } = await createAppFixture();

    try {
        const response = await fetch(
            `http://127.0.0.1:${port}/assets/hello.css`,
            { method: 'HEAD' },
        );
        const body = await response.text();

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8');
        assert.equal(response.headers.get('content-length'), '22');
        assert.equal(body, '');
    } finally {
        await app.stop();
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('unknown route returns 404 Problem JSON', async () => {
    const { workspaceDir, app, port } = await createAppFixture();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/unknown`);
        const body = await response.json();

        assert.equal(response.status, 404);
        assert.equal(response.headers.get('content-type'), 'application/problem+json; charset=utf-8');
        assert.equal(body.code, 'not_found');
        assert.equal(body.status, 404);
        assert.equal(typeof body.requestId, 'string');
    } finally {
        await app.stop();
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('wrong method returns 405 Problem JSON with Allow header', async () => {
    const { workspaceDir, app, port } = await createAppFixture();

    try {
        const response = await fetch(
            `http://127.0.0.1:${port}/assets/hello.css`,
            { method: 'POST' },
        );
        const body = await response.json();

        assert.equal(response.status, 405);
        assert.equal(response.headers.get('content-type'), 'application/problem+json; charset=utf-8');
        assert.equal(response.headers.get('allow'), 'GET, HEAD');
        assert.equal(body.code, 'method_not_allowed');
        assert.equal(body.status, 405);
    } finally {
        await app.stop();
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('malformed percent-encoding returns 400 Problem JSON', async () => {
    const { workspaceDir, app, port } = await createAppFixture();

    try {
        const response = await fetch(
            `http://127.0.0.1:${port}/assets/%E0%A4%A.css`,
        );
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(response.headers.get('content-type'), 'application/problem+json; charset=utf-8');
        assert.equal(body.code, 'invalid_target');
        assert.equal(body.status, 400);
    } finally {
        await app.stop();
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('path traversal on static assets returns 404', async () => {
    const { workspaceDir, app, port } = await createAppFixture();

    try {
        const response = await fetch(
            `http://127.0.0.1:${port}/assets/..%2fhello.css`,
        );
        const body = await response.json();

        assert.equal(response.status, 404);
        assert.equal(body.code, 'not_found');
    } finally {
        await app.stop();
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('POST with JSON body echoes the parsed body', async () => {
    const { workspaceDir, app, port } = await createAppFixture();

    try {
        const response = await fetch(
            `http://127.0.0.1:${port}/api/echo`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Arena' }),
            },
        );
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.deepEqual(body, { received: { name: 'Arena' } });
    } finally {
        await app.stop();
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('POST with malformed JSON returns 400 Problem JSON', async () => {
    const { workspaceDir, app, port } = await createAppFixture();

    try {
        const response = await fetch(
            `http://127.0.0.1:${port}/api/echo`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{ invalid json',
            },
        );
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(body.code, 'malformed_json');
    } finally {
        await app.stop();
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('slow client that disconnects mid-request does not crash the server', async () => {
    const { workspaceDir, app, port } = await createAppFixture();

    try {
        // Start a request but abort it immediately
        const controller = new AbortController();
        const promise = fetch(
            `http://127.0.0.1:${port}/api/hello`,
            { signal: controller.signal },
        ).catch((error) => error);

        controller.abort();
        const error = await promise;

        assert.ok(error instanceof Error);

        // Server should still be responsive
        const response = await fetch(`http://127.0.0.1:${port}/api/hello`);
        assert.equal(response.status, 200);
    } finally {
        await app.stop();
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('server survives multiple rapid requests', async () => {
    const { workspaceDir, app, port } = await createAppFixture();

    try {
        const requests = Array.from({ length: 20 }, () =>
            fetch(`http://127.0.0.1:${port}/api/hello`),
        );
        const responses = await Promise.all(requests);

        for (const response of responses) {
            assert.equal(response.status, 200);
        }
    } finally {
        await app.stop();
        await rm(workspaceDir, { recursive: true, force: true });
    }
});
