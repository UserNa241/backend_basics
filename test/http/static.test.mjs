import assert from 'node:assert/strict';
import {
    mkdir,
    mkdtemp,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Writable } from 'node:stream';

import {
    DEFAULT_STATIC_MIME_TYPES,
    createStaticFileHandler,
} from '../../src/http/static.mjs';

class MockResponse extends Writable {
    constructor() {
        super({ decodeStrings: true });
        this.statusCode = null;
        this.headers = null;
        this.headersSent = false;
        this.ended = false;
        this.destroyedFlag = false;
        this.chunks = [];
    }

    _write(chunk, encoding, callback) {
        this.chunks.push(chunk);
        callback();
    }

    writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
        this.headersSent = true;
        return this;
    }

    end(chunk, encoding) {
        if (chunk !== undefined) {
            this.chunks.push(chunk);
        }
        this.ended = true;
        super.end(chunk, encoding);
    }

    destroy(error) {
        this.destroyedFlag = true;
        super.destroy(error);
    }
}

async function createAssetFixture() {
    const workspaceDir = await mkdtemp(
        path.join(tmpdir(), 'vanilla-static-test-'),
    );
    const publicDir = path.join(workspaceDir, 'public');

    await mkdir(publicDir, { recursive: true });
    await writeFile(
        path.join(publicDir, 'hello.css'),
        'body { color: teal; }\n',
        'utf8',
    );
    await writeFile(path.join(publicDir, 'logo.svg'), '<svg></svg>', 'utf8');
    await writeFile(path.join(publicDir, 'secret.txt'), 'Top secret', 'utf8');
    await writeFile(
        path.join(publicDir, '.hidden.txt'),
        'Hidden secret',
        'utf8',
    );
    await writeFile(
        path.join(publicDir, 'script.mjs'),
        'export default 1;',
        'utf8',
    );
    await mkdir(path.join(publicDir, 'folder.css'));

    const outsideFile = path.join(workspaceDir, 'outside.txt');
    await writeFile(outsideFile, 'Outside secret', 'utf8');

    await symlink(outsideFile, path.join(publicDir, 'escape-link.txt'));
    await symlink(
        path.join(publicDir, '.hidden.txt'),
        path.join(publicDir, 'hidden-link.txt'),
    );
    await symlink(
        path.join(publicDir, 'script.mjs'),
        path.join(publicDir, 'mjs-link.txt'),
    );

    return { workspaceDir, publicDir };
}

function createMockCtx({ method, params, url }) {
    return {
        req: { method, url },
        res: new MockResponse(),
        params,
        signal: undefined,
    };
}

test('exposes a frozen default MIME table', () => {
    assert.equal(Object.isFrozen(DEFAULT_STATIC_MIME_TYPES), true);
    assert.equal(DEFAULT_STATIC_MIME_TYPES['.css'], 'text/css; charset=utf-8');
    assert.equal(DEFAULT_STATIC_MIME_TYPES['.svg'], 'image/svg+xml');
});

test('factory validates rootDir, urlPrefix, and cacheControl', () => {
    assert.throws(() => createStaticFileHandler({}), /rootDir/);
    assert.throws(
        () => createStaticFileHandler({ rootDir: '/tmp', urlPrefix: 'assets' }),
        /urlPrefix/,
    );
    assert.throws(
        () => createStaticFileHandler({ rootDir: '/tmp', cacheControl: '   ' }),
        /cacheControl/,
    );
    assert.doesNotThrow(() =>
        createStaticFileHandler({ rootDir: '/tmp', urlPrefix: '/assets' }),
    );
});

test('GET streams a regular file with correct headers and body', async () => {
    const { workspaceDir, publicDir } = await createAssetFixture();

    try {
        const handler = createStaticFileHandler({ rootDir: publicDir });
        const ctx = createMockCtx({
            method: 'GET',
            params: { assetPath: 'hello.css' },
        });

        await handler(ctx);

        assert.equal(ctx.res.statusCode, 200);
        assert.equal(
            ctx.res.headers['Content-Type'],
            'text/css; charset=utf-8',
        );
        assert.equal(ctx.res.headers['X-Content-Type-Options'], 'nosniff');
        assert.equal(ctx.res.headers['Cache-Control'], 'public, max-age=60');
        assert.equal(ctx.res.headersSent, true);
        assert.equal(ctx.res.ended, true);
        assert.equal(
            Buffer.concat(ctx.res.chunks).toString('utf8'),
            'body { color: teal; }\n',
        );
    } finally {
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('HEAD writes headers and ends without reading bytes', async () => {
    const { workspaceDir, publicDir } = await createAssetFixture();

    try {
        const handler = createStaticFileHandler({ rootDir: publicDir });
        const ctx = createMockCtx({
            method: 'HEAD',
            params: { assetPath: 'hello.css' },
        });

        await handler(ctx);

        assert.equal(ctx.res.statusCode, 200);
        assert.equal(ctx.res.headers['Content-Type'], 'text/css; charset=utf-8');
        assert.equal(ctx.res.headersSent, true);
        assert.equal(ctx.res.ended, true);
        assert.equal(ctx.res.chunks.length, 0);
    } finally {
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('non-GET/HEAD methods reject with 405 and Allow header', async () => {
    const { workspaceDir, publicDir } = await createAssetFixture();

    try {
        const handler = createStaticFileHandler({ rootDir: publicDir });

        await assert.rejects(
            handler(
                createMockCtx({ method: 'POST', params: { assetPath: 'hello.css' } }),
            ),
            (error) => {
                assert.equal(error.status, 405);
                assert.equal(error.code, 'method_not_allowed');
                assert.deepEqual(error.headers, { Allow: 'GET, HEAD' });
                return true;
            },
        );
    } finally {
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('path traversal via .. segment rejects with 404', async () => {
    const { workspaceDir, publicDir } = await createAssetFixture();

    try {
        const handler = createStaticFileHandler({ rootDir: publicDir });

        await assert.rejects(
            handler(
                createMockCtx({ method: 'GET', params: { assetPath: '../secret.txt' } }),
            ),
            (error) => {
                assert.equal(error.status, 404);
                assert.equal(error.code, 'not_found');
                return true;
            },
        );
    } finally {
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('encoded slash inside a segment rejects with 404', async () => {
    const { workspaceDir, publicDir } = await createAssetFixture();

    try {
        const handler = createStaticFileHandler({ rootDir: publicDir });

        await assert.rejects(
            handler({
                req: { method: 'GET', url: '/assets/..%2fsecret.txt' },
                res: new MockResponse(),
            }),
            (error) => {
                assert.equal(error.status, 404);
                assert.equal(error.code, 'not_found');
                return true;
            },
        );
    } finally {
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('backslash inside a segment rejects with 404', async () => {
    const { workspaceDir, publicDir } = await createAssetFixture();

    try {
        const handler = createStaticFileHandler({ rootDir: publicDir });

        await assert.rejects(
            handler(
                createMockCtx({
                    method: 'GET',
                    params: { assetPath: '..\\secret.txt' },
                }),
            ),
            (error) => {
                assert.equal(error.status, 404);
                assert.equal(error.code, 'not_found');
                return true;
            },
        );
    } finally {
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('null byte inside a segment rejects with 404', async () => {
    const { workspaceDir, publicDir } = await createAssetFixture();

    try {
        const handler = createStaticFileHandler({ rootDir: publicDir });

        await assert.rejects(
            handler(
                createMockCtx({
                    method: 'GET',
                    params: { assetPath: 'app.js\0.txt' },
                }),
            ),
            (error) => {
                assert.equal(error.status, 404);
                assert.equal(error.code, 'not_found');
                return true;
            },
        );
    } finally {
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('hidden dotfile rejects with 404', async () => {
    const { workspaceDir, publicDir } = await createAssetFixture();

    try {
        const handler = createStaticFileHandler({ rootDir: publicDir });

        await assert.rejects(
            handler(
                createMockCtx({ method: 'GET', params: { assetPath: '.hidden.txt' } }),
            ),
            (error) => {
                assert.equal(error.status, 404);
                assert.equal(error.code, 'not_found');
                return true;
            },
        );
    } finally {
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('symlink escaping root rejects with 404', async () => {
    const { workspaceDir, publicDir } = await createAssetFixture();

    try {
        const handler = createStaticFileHandler({ rootDir: publicDir });

        await assert.rejects(
            handler(
                createMockCtx({
                    method: 'GET',
                    params: { assetPath: 'escape-link.txt' },
                }),
            ),
            (error) => {
                assert.equal(error.status, 404);
                assert.equal(error.code, 'not_found');
                return true;
            },
        );
    } finally {
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('symlink to hidden file rejects with 404', async () => {
    const { workspaceDir, publicDir } = await createAssetFixture();

    try {
        const handler = createStaticFileHandler({ rootDir: publicDir });

        await assert.rejects(
            handler(
                createMockCtx({
                    method: 'GET',
                    params: { assetPath: 'hidden-link.txt' },
                }),
            ),
            (error) => {
                assert.equal(error.status, 404);
                assert.equal(error.code, 'not_found');
                return true;
            },
        );
    } finally {
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('symlink to unapproved extension rejects with 404', async () => {
    const { workspaceDir, publicDir } = await createAssetFixture();

    try {
        const handler = createStaticFileHandler({ rootDir: publicDir });

        await assert.rejects(
            handler(
                createMockCtx({
                    method: 'GET',
                    params: { assetPath: 'mjs-link.txt' },
                }),
            ),
            (error) => {
                assert.equal(error.status, 404);
                assert.equal(error.code, 'not_found');
                return true;
            },
        );
    } finally {
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('directory disguised with .css extension rejects with 404', async () => {
    const { workspaceDir, publicDir } = await createAssetFixture();

    try {
        const handler = createStaticFileHandler({ rootDir: publicDir });

        await assert.rejects(
            handler(
                createMockCtx({
                    method: 'GET',
                    params: { assetPath: 'folder.css' },
                }),
            ),
            (error) => {
                assert.equal(error.status, 404);
                assert.equal(error.code, 'not_found');
                return true;
            },
        );
    } finally {
        await rm(workspaceDir, { recursive: true, force: true });
    }
});

test('unapproved extension rejects with 404', async () => {
    const { workspaceDir, publicDir } = await createAssetFixture();

    try {
        const handler = createStaticFileHandler({ rootDir: publicDir });

        await assert.rejects(
            handler(
                createMockCtx({
                    method: 'GET',
                    params: { assetPath: 'script.mjs' },
                }),
            ),
            (error) => {
                assert.equal(error.status, 404);
                assert.equal(error.code, 'not_found');
                return true;
            },
        );
    } finally {
        await rm(workspaceDir, { recursive: true, force: true });
    }
});
