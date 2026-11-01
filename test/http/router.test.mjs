import assert from 'node:assert/strict';
import test from 'node:test';

import { createRouter } from '../../src/http/router.mjs';

function handlerA() {}
function handlerB() {}
function handlerC() {}

test('matches a static route and extracts parameters and query values', () => {
    const router = createRouter();

    router.get('/tasks', handlerA);
    router.get('/tasks/:id', handlerB);

    const result = router.match('GET', '/tasks/42?tag=study&tag=home');

    assert.equal(result.type, 'match');
    assert.equal(result.handler, handlerB);
    assert.equal(result.method, 'GET');
    assert.equal(result.pattern, '/tasks/:id');
    assert.equal(result.params.id, '42');
    assert.deepEqual(result.query.getAll('tag'), ['study', 'home']);
    assert.deepEqual(result.wildcardSegments, []);
    assert.equal(result.headFallback, false);
});

test('decodes path segments once after splitting and handles plus correctly', () => {
    const router = createRouter();

    router.get('/files/:name', handlerA);
    router.get('/tasks/:title', handlerB);

    const encodedSlash = router.match('GET', '/files/a%2Fb?tag=a+b');
    const plusInPath = router.match('GET', '/tasks/a+b');

    assert.equal(encodedSlash.type, 'match');
    assert.equal(encodedSlash.params.name, 'a/b');
    assert.deepEqual(encodedSlash.query.getAll('tag'), ['a b']);

    assert.equal(plusInPath.type, 'match');
    assert.equal(plusInPath.params.title, 'a+b');
});

test('returns bad-target for malformed percent encoding', () => {
    const router = createRouter();

    router.get('/tasks/:id', handlerA);

    const result = router.match('GET', '/tasks/%E0%A4%A');

    assert.deepEqual(result, { type: 'bad-target' });
});

test('rejects patterns outside the bounded grammar', () => {
    const router = createRouter();
    const invalidPatterns = [
        '/tasks/',
        '/tasks//42',
        '/tasks/*/comments',
        '/tasks/:',
        '/tasks/:123',
        '/tasks/:id/:id',
        '/tasks/task-:id',
        '/tasks/:id.json',
        '/tasks/..',
        '/tasks?preview=true',
    ];

    for (const pattern of invalidPatterns) {
        assert.throws(
            () => router.get(pattern, handlerA),
            TypeError,
            `expected pattern to be rejected: ${pattern}`,
        );
    }
});

test('distinguishes not-found from method-not-allowed', () => {
    const router = createRouter();

    router.get('/tasks/:id', handlerA);
    router.patch('/tasks/:id', handlerB);

    const missingPath = router.match('GET', '/reports');
    const wrongMethod = router.match('DELETE', '/tasks/42');

    assert.equal(missingPath.type, 'not-found');

    assert.equal(wrongMethod.type, 'method-not-allowed');
    assert.deepEqual(wrongMethod.allowedMethods, ['GET', 'PATCH', 'HEAD']);
});

test('uses an explicit HEAD route before the GET fallback', () => {
    const fallbackRouter = createRouter();
    fallbackRouter.get('/tasks/:id', handlerA);

    const fallback = fallbackRouter.match('HEAD', '/tasks/42');

    assert.equal(fallback.type, 'match');
    assert.equal(fallback.handler, handlerA);
    assert.equal(fallback.method, 'GET');
    assert.equal(fallback.headFallback, true);

    const explicitRouter = createRouter();
    explicitRouter.get('/tasks/:id', handlerA);
    explicitRouter.head('/tasks/:id', handlerB);

    const explicit = explicitRouter.match('HEAD', '/tasks/42');

    assert.equal(explicit.type, 'match');
    assert.equal(explicit.handler, handlerB);
    assert.equal(explicit.method, 'HEAD');
    assert.equal(explicit.headFallback, false);
});

test('selects the most specific method-matching route', () => {
    const router = createRouter();

    router.get('/tasks/:id', handlerA);
    router.get('/tasks/new', handlerB);
    router.get('/assets/*', handlerA);
    router.get('/assets/:name', handlerB);
    router.get('/assets', handlerC);

    assert.equal(router.match('GET', '/tasks/new').handler, handlerB);
    assert.equal(router.match('GET', '/tasks/42').handler, handlerA);
    assert.equal(router.match('GET', '/assets/logo.png').handler, handlerB);
    assert.equal(router.match('GET', '/assets').handler, handlerC);

    const deepWildcard = router.match('GET', '/assets/images/logo.png');
    assert.equal(deepWildcard.handler, handlerA);
    assert.deepEqual(deepWildcard.wildcardSegments, ['images', 'logo.png']);
});

test('filters by method before applying path specificity', () => {
    const router = createRouter();

    router.get('/tasks/new', handlerA);
    router.post('/tasks/:id', handlerB);

    const result = router.match('POST', '/tasks/new');

    assert.equal(result.type, 'match');
    assert.equal(result.handler, handlerB);
    assert.equal(result.params.id, 'new');
});

test('rejects duplicate and equivalent route shapes for one method', () => {
    const router = createRouter();

    router.get('/tasks/:id', handlerA);

    assert.throws(
        () => router.get('/tasks/:id', handlerB),
        /Duplicate or equivalent route/,
    );
    assert.throws(
        () => router.get('/tasks/:name', handlerB),
        /Duplicate or equivalent route/,
    );

    assert.doesNotThrow(() => {
        router.post('/tasks/:name', handlerB);
    });
});

test('mounts routers under static prefixes with global behaviour', () => {
    const tasksRouter = createRouter();
    tasksRouter.get('/', handlerA);
    tasksRouter.get('/:id', handlerB);
    tasksRouter.patch('/:id', handlerC);

    const apiRouter = createRouter();
    apiRouter.mount('/tasks', tasksRouter);

    const rootRouter = createRouter();
    rootRouter.mount('/api', apiRouter);

    const list = rootRouter.match('GET', '/api/tasks');
    const byId = rootRouter.match('GET', '/api/tasks/42');
    const wrongMethod = rootRouter.match('DELETE', '/api/tasks/42');
    const wrongSegment = rootRouter.match('GET', '/apiary/tasks');

    assert.equal(list.handler, handlerA);
    assert.equal(list.pattern, '/api/tasks');

    assert.equal(byId.handler, handlerB);
    assert.equal(byId.pattern, '/api/tasks/:id');
    assert.equal(byId.params.id, '42');

    assert.equal(wrongMethod.type, 'method-not-allowed');
    assert.deepEqual(wrongMethod.allowedMethods, ['GET', 'PATCH', 'HEAD']);
    assert.equal(wrongSegment.type, 'not-found');
});

test('a failed mount copies no routes into the parent', () => {
    const parent = createRouter();
    parent.get('/api/conflict', handlerA);

    const child = createRouter();
    child.get('/safe', handlerB);
    child.get('/conflict', handlerC);

    assert.throws(
        () => parent.mount('/api', child),
        /Duplicate or equivalent route/,
    );

    assert.equal(parent.match('GET', '/api/safe').type, 'not-found');
    assert.equal(parent.match('GET', '/api/conflict').handler, handlerA);
});

test('mounting copies the child routes available at mount time', () => {
    const child = createRouter();
    child.get('/:id', handlerA);

    const parent = createRouter();
    parent.mount('/tasks', child);

    child.get('/new', handlerB);

    const result = parent.match('GET', '/tasks/new');

    assert.equal(result.type, 'match');
    assert.equal(result.handler, handlerA);
    assert.equal(result.params.id, 'new');
});
