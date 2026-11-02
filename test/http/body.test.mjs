import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
    BodyAbortedError,
    BodyError,
    createJsonBodyParser,
    readBoundedBody,
} from '../../src/http/body.mjs';

function createRequest(headers = {}) {
    const req = new PassThrough();
    req.headers = headers;
    return req;
}

function writeAndEnd(req, writes) {
    for (const write of writes) {
        req.write(write);
    }

    req.end();
}

async function readWithWrites(req, writes, options) {
    const bodyPromise = readBoundedBody(req, options);
    writeAndEnd(req, writes);
    return bodyPromise;
}

function jsonHeaders(body, overrides = {}) {
    return {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        ...overrides,
    };
}

function startParser({
                         headers,
                         parserOptions,
                         signal,
                     } = {}) {
    const req = createRequest(headers);
    const ctx = { req, signal };
    const calls = {
        next: 0,
        bodySeenByNext: undefined,
    };
    const parser = createJsonBodyParser(parserOptions);
    const promise = parser(ctx, async () => {
        calls.next += 1;
        calls.bodySeenByNext = ctx.body;
    });

    return { req, ctx, calls, promise };
}

test('reader combines chunks and accepts a body exactly at the limit', async () => {
    const req = createRequest({ 'content-length': '5' });

    const body = await readWithWrites(req, ['12', '345'], { maxBytes: 5 });

    assert.equal(body.toString('utf8'), '12345');
    assert.equal(body.length, 5);
});

test('reader returns an empty Buffer for an empty body', async () => {
    const req = createRequest({ 'content-length': '0' });

    const body = await readWithWrites(req, [], { maxBytes: 5 });

    assert.equal(body.length, 0);
});

test('reader rejects an oversized declared length before consuming data', async () => {
    const req = createRequest({ 'content-length': '6' });
    req.write('123456');

    await assert.rejects(readBoundedBody(req, { maxBytes: 5 }), (error) => {
        assert.ok(error instanceof BodyError);
        assert.equal(error.status, 413);
        assert.equal(error.code, 'body_too_large');
        return true;
    });

    assert.equal(req.readableLength, 6);
});

test('reader rejects an invalid Content-Length', async () => {
    const req = createRequest({ 'content-length': 'five' });

    await assert.rejects(readBoundedBody(req, { maxBytes: 5 }), (error) => {
        assert.ok(error instanceof BodyError);
        assert.equal(error.status, 400);
        assert.equal(error.code, 'invalid_content_length');
        return true;
    });
});

test('reader counts actual bytes and pauses when the limit is crossed', async () => {
    const req = createRequest();
    const bodyPromise = readBoundedBody(req, { maxBytes: 5 });

    req.write('123');
    req.write('456');

    await assert.rejects(bodyPromise, (error) => {
        assert.ok(error instanceof BodyError);
        assert.equal(error.status, 413);
        assert.equal(error.code, 'body_too_large');
        return true;
    });

    assert.equal(req.isPaused(), true);
    assert.equal(req.listenerCount('data'), 0);
});

test('reader rejects when a stream ends before its declared length', async () => {
    const req = createRequest({ 'content-length': '5' });
    const bodyPromise = readBoundedBody(req, { maxBytes: 10 });

    req.end('12');

    await assert.rejects(bodyPromise, BodyAbortedError);
});

test('reader rejects and cleans up when the stream closes before end', async () => {
    const req = createRequest();
    const bodyPromise = readBoundedBody(req, { maxBytes: 10 });

    req.write('ab');
    req.destroy();

    await assert.rejects(bodyPromise, BodyAbortedError);
    assert.equal(req.listenerCount('data'), 0);
    assert.equal(req.listenerCount('end'), 0);
    assert.equal(req.listenerCount('error'), 0);
    assert.equal(req.listenerCount('close'), 0);
});

test('reader preserves an unexpected stream error', async () => {
    const req = createRequest();
    const streamError = new Error('stream exploded');
    const bodyPromise = readBoundedBody(req, { maxBytes: 10 });

    req.destroy(streamError);

    await assert.rejects(bodyPromise, (error) => error === streamError);
});

test('reader validates maxBytes and the abort signal', async () => {
    await assert.rejects(
        readBoundedBody(createRequest(), { maxBytes: 0 }),
        RangeError,
    );

    await assert.rejects(
        readBoundedBody(createRequest(), {
            maxBytes: 10,
            signal: { aborted: false },
        }),
        TypeError,
    );
});

test('reader rejects an already-aborted signal', async () => {
    const abortController = new AbortController();
    abortController.abort(new Error('client left'));

    await assert.rejects(
        readBoundedBody(createRequest(), {
            maxBytes: 10,
            signal: abortController.signal,
        }),
        BodyAbortedError,
    );
});

test('reader rejects when the signal aborts while waiting for data', async () => {
    const abortController = new AbortController();
    const req = createRequest();
    const bodyPromise = readBoundedBody(req, {
        maxBytes: 10,
        signal: abortController.signal,
    });

    setTimeout(() => {
        abortController.abort(new Error('client left'));
    }, 5);

    await assert.rejects(bodyPromise, BodyAbortedError);
    assert.equal(req.isPaused(), true);
});

test('parser parses an object split across chunks and calls next once', async () => {
    const body = '{"title":"Learn HTTP"}';
    const run = startParser({ headers: jsonHeaders(body) });

    writeAndEnd(run.req, ['{"title":"Lea', 'rn HTTP"}']);
    await run.promise;

    assert.deepEqual(run.ctx.body, { title: 'Learn HTTP' });
    assert.deepEqual(run.calls.bodySeenByNext, { title: 'Learn HTTP' });
    assert.equal(run.calls.next, 1);
});

test('parser accepts every valid JSON value shape', async () => {
    const cases = [
        ['[]', []],
        ['null', null],
        ['42', 42],
        ['"text"', 'text'],
        ['true', true],
    ];

    for (const [body, expected] of cases) {
        const run = startParser({ headers: jsonHeaders(body) });
        writeAndEnd(run.req, [body]);
        await run.promise;

        assert.deepEqual(run.ctx.body, expected);
        assert.equal(run.calls.next, 1);
    }
});

test('parser preserves a UTF-8 character split across chunks', async () => {
    const firstChunk = Buffer.concat([
        Buffer.from('{"title":"'),
        Buffer.from([0xc3]),
    ]);
    const secondChunk = Buffer.concat([
        Buffer.from([0xa9]),
        Buffer.from('"}'),
    ]);
    const body = Buffer.concat([firstChunk, secondChunk]);
    const run = startParser({
        headers: {
            'content-type': 'application/json',
            'content-length': String(body.length),
        },
    });

    writeAndEnd(run.req, [firstChunk, secondChunk]);
    await run.promise;

    assert.deepEqual(run.ctx.body, { title: 'é' });
});

test('parser distinguishes an absent required body from an optional body', async () => {
    const requiredRun = startParser({ headers: {} });

    await assert.rejects(requiredRun.promise, (error) => {
        assert.ok(error instanceof BodyError);
        assert.equal(error.status, 400);
        assert.equal(error.code, 'body_required');
        return true;
    });
    assert.equal(requiredRun.calls.next, 0);

    const optionalRun = startParser({
        headers: {},
        parserOptions: { required: false },
    });
    await optionalRun.promise;

    assert.equal(optionalRun.ctx.body, undefined);
    assert.equal(optionalRun.calls.next, 1);
});

test('parser handles an empty chunked body according to required', async () => {
    const headers = {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
    };

    const requiredRun = startParser({ headers });
    requiredRun.req.end();
    await assert.rejects(requiredRun.promise, (error) => {
        assert.equal(error.code, 'body_required');
        return true;
    });
    assert.equal(requiredRun.calls.next, 0);

    const optionalRun = startParser({
        headers,
        parserOptions: { required: false },
    });
    optionalRun.req.end();
    await optionalRun.promise;

    assert.equal(optionalRun.ctx.body, undefined);
    assert.equal(optionalRun.calls.next, 1);
});

test('parser rejects unsupported media types, charsets, and encodings', async () => {
    const cases = [
        [
            'missing content type',
            { 'content-length': '2' },
            'unsupported_media_type',
        ],
        [
            'plain text',
            jsonHeaders('{}', { 'content-type': 'text/plain' }),
            'unsupported_media_type',
        ],
        [
            'unsupported charset',
            jsonHeaders('{}', {
                'content-type': 'application/json; charset=iso-8859-1',
            }),
            'unsupported_media_type',
        ],
        [
            'gzip encoding',
            jsonHeaders('{}', { 'content-encoding': 'gzip' }),
            'unsupported_content_encoding',
        ],
    ];

    for (const [label, headers, expectedCode] of cases) {
        const run = startParser({ headers });
        run.req.end('{}');

        await assert.rejects(run.promise, (error) => {
            assert.ok(error instanceof BodyError, label);
            assert.equal(error.status, 415, label);
            assert.equal(error.code, expectedCode, label);
            return true;
        });
        assert.equal(run.calls.next, 0, label);
    }
});

test('parser accepts a JSON suffix media type with a UTF-8 charset', async () => {
    const body = '{}';
    const run = startParser({
        headers: jsonHeaders(body, {
            'content-type': 'Application/Vnd.Example+JSON; Charset="UTF-8"',
        }),
    });

    writeAndEnd(run.req, [body]);
    await run.promise;

    assert.deepEqual(run.ctx.body, {});
    assert.equal(run.calls.next, 1);
});

test('parser rejects malformed JSON and invalid UTF-8 without calling next', async () => {
    const malformedRun = startParser({
        headers: jsonHeaders('{"title":'),
    });
    writeAndEnd(malformedRun.req, ['{"title":']);

    await assert.rejects(malformedRun.promise, (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, 'malformed_json');
        assert.ok(error.cause instanceof Error);
        return true;
    });
    assert.equal(malformedRun.calls.next, 0);
    assert.equal('body' in malformedRun.ctx, false);

    const invalidUtf8Run = startParser({
        headers: {
            'content-type': 'application/json',
            'content-length': '3',
        },
    });
    writeAndEnd(invalidUtf8Run.req, [Buffer.from([0x22, 0xff, 0x22])]);

    await assert.rejects(invalidUtf8Run.promise, (error) => {
        assert.equal(error.status, 400);
        assert.equal(error.code, 'malformed_json');
        return true;
    });
    assert.equal(invalidUtf8Run.calls.next, 0);
});

test('parser rejects an oversized body without calling next', async () => {
    const body = '{"title":"too large"}';
    const run = startParser({
        headers: jsonHeaders(body),
        parserOptions: { maxBytes: 8 },
    });

    writeAndEnd(run.req, [body]);

    await assert.rejects(run.promise, (error) => {
        assert.equal(error.status, 413);
        assert.equal(error.code, 'body_too_large');
        return true;
    });
    assert.equal(run.calls.next, 0);
});

test('parser rejects a prematurely closed body without calling next', async () => {
    const run = startParser({
        headers: {
            'content-type': 'application/json',
            'transfer-encoding': 'chunked',
        },
    });

    run.req.write('{"title":');
    run.req.destroy();

    await assert.rejects(run.promise, BodyAbortedError);
    assert.equal(run.calls.next, 0);
});

test('parser prevents a second consumption of the same context', async () => {
    const body = '{"title":"Learn HTTP"}';
    const parser = createJsonBodyParser();
    const req = createRequest(jsonHeaders(body));
    const ctx = { req };
    let finalNextCalls = 0;

    const promise = parser(ctx, async () => {
        await parser(ctx, async () => {
            finalNextCalls += 1;
        });
    });

    req.end(body);

    await assert.rejects(
        promise,
        /cannot be applied more than once to the same context/,
    );
    assert.deepEqual(ctx.body, { title: 'Learn HTTP' });
    assert.equal(finalNextCalls, 0);
});
