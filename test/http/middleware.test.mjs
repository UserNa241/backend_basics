import assert from 'node:assert/strict';
import test from 'node:test';

import { composeMiddleware } from '../../src/http/middleware.mjs';

function sleep(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

test('validates the middleware list during composition', () => {
    assert.throws(
        () => composeMiddleware('not-an-array'),
        /Middlewares must be an array of functions/,
    );

    assert.throws(
        () => composeMiddleware([async () => {}, 'not-a-function']),
        /Middleware at index 1 must be a function/,
    );
});

test('resolves normally for an empty middleware chain', async () => {
    const runMiddleware = composeMiddleware([]);

    const result = await runMiddleware({});

    assert.equal(result, undefined);
});

test('uses a snapshot of the middleware array from composition time', async () => {
    const ctx = { events: [] };
    const middlewares = [
        async (currentCtx, next) => {
            currentCtx.events.push('original first');
            await next();
        },
        async (currentCtx) => {
            currentCtx.events.push('handler');
        },
    ];

    const runMiddleware = composeMiddleware(middlewares);

    middlewares[0] = async (currentCtx) => {
        currentCtx.events.push('replacement first');
    };
    middlewares.push(async (currentCtx) => {
        currentCtx.events.push('added later');
    });

    await runMiddleware(ctx);

    assert.deepEqual(ctx.events, ['original first', 'handler']);
});

test('passes the same context through the chain in inward and outward order', async () => {
    const ctx = { events: [] };
    const seenContexts = [];

    const runMiddleware = composeMiddleware([
        async (currentCtx, next) => {
            seenContexts.push(currentCtx);
            currentCtx.events.push('first before');
            await next();
            currentCtx.events.push('first after');
        },
        (currentCtx, next) => {
            seenContexts.push(currentCtx);
            currentCtx.events.push('second before');
            return next().then(() => {
                currentCtx.events.push('second after');
            });
        },
        async (currentCtx) => {
            seenContexts.push(currentCtx);
            currentCtx.events.push('handler');
        },
    ]);

    await runMiddleware(ctx);

    assert.deepEqual(ctx.events, [
        'first before',
        'second before',
        'handler',
        'second after',
        'first after',
    ]);
    assert.equal(seenContexts.length, 3);
    assert.ok(seenContexts.every((seenContext) => seenContext === ctx));
});

test('stops downstream when a middleware does not call next', async () => {
    const ctx = { events: [] };

    const runMiddleware = composeMiddleware([
        async (currentCtx, next) => {
            currentCtx.events.push('outer before');
            await next();
            currentCtx.events.push('outer after');
        },
        async (currentCtx) => {
            currentCtx.events.push('stop here');
        },
        async (currentCtx) => {
            currentCtx.events.push('must not run');
        },
    ]);

    await runMiddleware(ctx);

    assert.deepEqual(ctx.events, ['outer before', 'stop here', 'outer after']);
});

test('propagates downstream errors and runs finally cleanup', async () => {
    const ctx = { cleanedUp: false };

    const runMiddleware = composeMiddleware([
        async (currentCtx, next) => {
            try {
                await next();
            } finally {
                currentCtx.cleanedUp = true;
            }
        },
        async () => {
            throw new Error('downstream failed');
        },
    ]);

    await assert.rejects(runMiddleware(ctx), /downstream failed/);
    assert.equal(ctx.cleanedUp, true);
});

test('allows an outer middleware to recover from a downstream error', async () => {
    const ctx = {};

    const runMiddleware = composeMiddleware([
        async (currentCtx, next) => {
            try {
                await next();
            } catch (error) {
                currentCtx.recoveredError = error.message;
            }
        },
        () => {
            throw new Error('sync failure');
        },
    ]);

    await runMiddleware(ctx);

    assert.equal(ctx.recoveredError, 'sync failure');
});

test('rejects sequential double next without running downstream twice', async () => {
    let handlerCalls = 0;

    const runMiddleware = composeMiddleware([
        async (ctx, next) => {
            await next();
            await next();
        },
        async () => {
            handlerCalls += 1;
        },
    ]);

    await assert.rejects(
        runMiddleware({}),
        /next\(\) called multiple times/,
    );
    assert.equal(handlerCalls, 1);
});

test('rejects concurrent double next without running downstream twice', async () => {
    let handlerCalls = 0;

    const runMiddleware = composeMiddleware([
        async (ctx, next) => {
            await Promise.all([next(), next()]);
        },
        async () => {
            handlerCalls += 1;
        },
    ]);

    await assert.rejects(
        runMiddleware({}),
        /next\(\) called multiple times/,
    );
    assert.equal(handlerCalls, 1);
});

test('rejects next when called by the final middleware', async () => {
    const runMiddleware = composeMiddleware([
        async (ctx, next) => {
            await next();
        },
    ]);

    await assert.rejects(
        runMiddleware({}),
        /next\(\) called after the final middleware/,
    );
});

test('rejects a saved next after its middleware has returned', async () => {
    let savedNext;
    let handlerCalls = 0;

    const runMiddleware = composeMiddleware([
        async (ctx, next) => {
            savedNext = next;
        },
        async () => {
            handlerCalls += 1;
        },
    ]);

    await runMiddleware({});

    await assert.rejects(
        savedNext(),
        /next\(\) called after the middleware returned/,
    );
    assert.equal(handlerCalls, 0);
});

test('allows next to be called later while its middleware is still active', async () => {
    const ctx = { events: [] };

    const runMiddleware = composeMiddleware([
        async (currentCtx, next) => {
            await sleep(5);
            await next();
            currentCtx.events.push('first after');
        },
        async (currentCtx) => {
            currentCtx.events.push('handler');
        },
    ]);

    await runMiddleware(ctx);

    assert.deepEqual(ctx.events, ['handler', 'first after']);
});

test('keeps concurrent runs of the same pipeline isolated', async () => {
    const runMiddleware = composeMiddleware([
        async (ctx, next) => {
            ctx.events.push(`${ctx.name} before`);
            await sleep(ctx.delayMs);
            await next();
            ctx.events.push(`${ctx.name} after`);
        },
        async (ctx) => {
            ctx.events.push(`${ctx.name} handler`);
        },
    ]);

    const firstCtx = { name: 'first', delayMs: 15, events: [] };
    const secondCtx = { name: 'second', delayMs: 1, events: [] };

    await Promise.all([
        runMiddleware(firstCtx),
        runMiddleware(secondCtx),
    ]);

    assert.deepEqual(firstCtx.events, [
        'first before',
        'first handler',
        'first after',
    ]);
    assert.deepEqual(secondCtx.events, [
        'second before',
        'second handler',
        'second after',
    ]);
});
