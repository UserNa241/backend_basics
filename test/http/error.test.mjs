import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
    BodyAbortedError,
    BodyError,
    createJsonBodyParser,
} from '../../src/http/body.mjs';
import {
    HttpError,
    classifyError,
    createCorrelationMiddleware,
    createErrorBoundary,
    resolveRequestId,
    writeProblemResponse,
} from '../../src/http/error.mjs';
import { composeMiddleware } from '../../src/http/middleware.mjs';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createExchange({
                            method = 'GET',
                            headers = {},
                            headersSent = false,
                            signal,
                        } = {}) {
    const req = new PassThrough();
    req.method = method;
    req.headers = headers;

    const stagedHeaders = {};
    const res = {
        headersSent,
        writableEnded: false,
        destroyed: false,
        status: null,
        headers: null,
        bodyBuffer: null,
        setHeader(name, value) {
            stagedHeaders[name] = value;
        },
        getHeader(name) {
            return stagedHeaders[name];
        },
        writeHead(status, responseHeaders) {
            this.headersSent = true;
            this.status = status;
            this.headers = { ...stagedHeaders, ...responseHeaders };
        },
        end(chunk) {
            this.writableEnded = true;
            this.bodyBuffer = chunk ?? Buffer.alloc(0);
        },
        destroy() {
            this.destroyed = true;
        },
    };

    return { req, res, signal };
}

test('resolveRequestId preserves valid client IDs and replaces invalid ones with a UUID', () => {
    assert.equal(resolveRequestId('  trace_2026-10.28  '), 'trace_2026-10.28');
    assert.match(resolveRequestId(undefined), UUID_PATTERN);
    assert.match(resolveRequestId(''), UUID_PATTERN);
    assert.match(resolveRequestId('bad id with spaces'), UUID_PATTERN);
    assert.match(resolveRequestId('bad\r\nheader'), UUID_PATTERN);
    assert.match(resolveRequestId('a'.repeat(65)), UUID_PATTERN);
});

test('correlation middleware sets ctx.requestId, stages X-Request-Id, and awaits next', async () => {
    const middleware = createCorrelationMiddleware();
    const ctx = createExchange({
        headers: { 'x-request-id': 'client-request-01' },
    });
    let seenDownstream = null;

    await middleware(ctx, async () => {
        seenDownstream = ctx.requestId;
    });

    assert.equal(ctx.requestId, 'client-request-01');
    assert.equal(seenDownstream, 'client-request-01');
    assert.equal(ctx.res.getHeader('X-Request-Id'), 'client-request-01');
});

test('HttpError validates status, code, detail, headers, and cause', () => {
    const cause = new Error('missing record');
    const error = new HttpError({
        status: 405,
        code: 'method_not_allowed',
        detail: 'Method POST is not allowed.',
        headers: { Allow: 'GET, HEAD' },
        cause,
    });

    assert.equal(error.status, 405);
    assert.equal(error.code, 'method_not_allowed');
    assert.equal(error.detail, 'Method POST is not allowed.');
    assert.deepEqual(error.headers, { Allow: 'GET, HEAD' });
    assert.equal(Object.isFrozen(error.headers), true);
    assert.equal(error.cause, cause);

    assert.throws(
        () => new HttpError({ status: 200, code: 'ok', detail: 'Not an error.' }),
        RangeError,
    );
    assert.throws(
        () => new HttpError({ status: 400, code: '', detail: 'Bad request.' }),
        TypeError,
    );
    assert.throws(
        () => new HttpError({ status: 400, code: 'bad_request', detail: '' }),
        TypeError,
    );
    assert.throws(
        () =>
            new HttpError({
                status: 405,
                code: 'method_not_allowed',
                detail: 'Bad header.',
                headers: { Allow: 123 },
            }),
        TypeError,
    );
});

test('classifyError maps HttpError, BodyError, BodyAbortedError, and unknown errors', () => {
    const httpClassification = classifyError(
        new HttpError({
            status: 404,
            code: 'not_found',
            detail: 'No route matched.',
        }),
        'req-404',
    );
    assert.equal(httpClassification.aborted, false);
    assert.equal(httpClassification.isInternal, false);
    assert.equal(httpClassification.problem.title, 'Not Found');
    assert.equal(httpClassification.problem.type, 'urn:problem:not_found');

    const bodyClassification = classifyError(
        new BodyError({
            status: 415,
            code: 'unsupported_media_type',
            detail: 'The request body must use a JSON media type.',
        }),
        'req-415',
    );
    assert.equal(bodyClassification.status, 415);
    assert.equal(bodyClassification.problem.title, 'Unsupported Media Type');

    const abortedClassification = classifyError(
        new BodyAbortedError(),
        'req-abort',
    );
    assert.equal(abortedClassification.aborted, true);
    assert.equal(abortedClassification.problem, null);

    const internalClassification = classifyError(
        new Error('SELECT * FROM secrets failed'),
        'req-500',
    );
    assert.equal(internalClassification.isInternal, true);
    assert.equal(internalClassification.status, 500);
    assert.equal(internalClassification.problem.code, 'internal_error');
    assert.equal(
        internalClassification.problem.detail,
        'An unexpected internal error occurred.',
    );
});

test('writeProblemResponse writes byte-accurate Problem JSON and omits body on HEAD', () => {
    const { problem, headers } = classifyError(
        new HttpError({
            status: 405,
            code: 'method_not_allowed',
            detail: 'Method DELETE is not allowed for /café.',
            headers: { Allow: 'GET, HEAD' },
        }),
        'req-head-405',
    );

    const getCtx = createExchange({ method: 'GET' });
    writeProblemResponse(getCtx.res, problem, {
        method: 'GET',
        headers,
    });

    assert.equal(getCtx.res.status, 405);
    assert.equal(getCtx.res.headers.Allow, 'GET, HEAD');
    assert.equal(
        getCtx.res.headers['Content-Type'],
        'application/problem+json; charset=utf-8',
    );
    assert.equal(getCtx.res.headers['Cache-Control'], 'no-store');
    assert.equal(getCtx.res.headers['X-Request-Id'], 'req-head-405');
    assert.equal(
        Number(getCtx.res.headers['Content-Length']),
        getCtx.res.bodyBuffer.length,
    );
    assert.deepEqual(
        JSON.parse(getCtx.res.bodyBuffer.toString('utf8')),
        problem,
    );

    const headCtx = createExchange({ method: 'HEAD' });
    writeProblemResponse(headCtx.res, problem, {
        method: 'HEAD',
        headers,
    });

    assert.equal(headCtx.res.status, 405);
    assert.equal(
        headCtx.res.headers['Content-Length'],
        getCtx.res.headers['Content-Length'],
    );
    assert.equal(headCtx.res.bodyBuffer.length, 0);
});

test('error boundary translates Build 4 parser BodyError into Problem JSON', async () => {
    const ctx = createExchange({
        method: 'POST',
        headers: {
            'x-request-id': 'req-bad-json',
            'content-type': 'application/json',
            'content-length': '9',
        },
    });

    const pipeline = composeMiddleware([
        createCorrelationMiddleware(),
        createErrorBoundary(),
        createJsonBodyParser(),
        async () => {
            throw new Error('handler should not run');
        },
    ]);

    const runPromise = pipeline(ctx);
    ctx.req.end('{"title":');
    await runPromise;

    assert.equal(ctx.res.status, 400);
    const problem = JSON.parse(ctx.res.bodyBuffer.toString('utf8'));
    assert.deepEqual(problem, {
        type: 'urn:problem:malformed_json',
        title: 'Bad Request',
        status: 400,
        detail: 'The request body contains malformed JSON.',
        code: 'malformed_json',
        requestId: 'req-bad-json',
    });
});

test('error boundary redacts unknown errors to 500 while passing the original error to onError', async () => {
    const observed = [];
    const internalFailure = new Error('postgres connection refused at 10.0.0.12');
    const ctx = createExchange({
        headers: { 'x-request-id': 'req-internal-500' },
    });

    const pipeline = composeMiddleware([
        createCorrelationMiddleware(),
        createErrorBoundary({
            onError(error, info) {
                observed.push({ error, info });
            },
        }),
        async () => {
            throw internalFailure;
        },
    ]);

    await pipeline(ctx);

    assert.equal(ctx.res.status, 500);
    const problem = JSON.parse(ctx.res.bodyBuffer.toString('utf8'));
    assert.equal(problem.code, 'internal_error');
    assert.equal(problem.detail, 'An unexpected internal error occurred.');
    assert.equal(problem.requestId, 'req-internal-500');
    assert.equal(observed.length, 1);
    assert.equal(observed[0].error, internalFailure);
    assert.equal(observed[0].info.classification.isInternal, true);
});

test('error boundary does not write a response when the client aborted', async () => {
    const observed = [];
    const abortController = new AbortController();
    abortController.abort(new Error('client disconnected'));

    const ctx = createExchange({
        headers: { 'x-request-id': 'req-client-gone' },
        signal: abortController.signal,
    });

    const boundary = createErrorBoundary({
        onError(_error, info) {
            observed.push(info);
        },
    });

    await boundary(ctx, async () => {
        throw new BodyAbortedError();
    });

    assert.equal(ctx.res.status, null);
    assert.equal(ctx.res.writableEnded, false);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].requestAborted, true);
});

test('error boundary destroys the response without writing headers when already committed', async () => {
    const observed = [];
    const ctx = createExchange({
        headers: { 'x-request-id': 'req-already-sent' },
        headersSent: true,
    });

    const boundary = createErrorBoundary({
        onError(_error, info) {
            observed.push(info);
        },
    });

    await boundary(ctx, async () => {
        throw new Error('stream read failed after headers');
    });

    assert.equal(ctx.res.status, null);
    assert.equal(ctx.res.destroyed, true);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].responseCommitted, true);
});

test('error boundary survives a throwing onError callback', async () => {
    const ctx = createExchange({
        headers: { 'x-request-id': 'req-hook-throws' },
    });

    const boundary = createErrorBoundary({
        onError() {
            throw new Error('logger callback broke');
        },
    });

    await boundary(ctx, async () => {
        throw new HttpError({
            status: 400,
            code: 'bad_request',
            detail: 'Invalid query parameter.',
        });
    });

    assert.equal(ctx.res.status, 400);
    const problem = JSON.parse(ctx.res.bodyBuffer.toString('utf8'));
    assert.equal(problem.code, 'bad_request');
    assert.equal(problem.requestId, 'req-hook-throws');
});
