import { randomUUID } from 'node:crypto';
import { STATUS_CODES } from 'node:http';

import { BodyAbortedError, BodyError} from "./body.mjs";

const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const INTERNAL_ERROR_DETAIL = 'An unexpected internal error occurred.';
const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';


function normalizeErrorHeaders(headers) {
    if (headers === undefined) {
        return Object.freeze({});
    }

    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
        throw new TypeError('HttpError headers must be a plain object');
    }

    const normalized = {};
    for (const [name, value] of Object.entries(headers)) {
        if (name.trim() === '' || typeof value !== 'string') {
            throw new TypeError('HttpError headers must map non-empty headers names to string values');
        }
        normalized[name] = value;
    }
    return Object.freeze(normalized);
}

export class HttpError extends Error {
    constructor({status, code, detail, headers, cause} = {}) {

        if (!Number.isInteger(status) || status < 400 || status >= 599) {
            throw new RangeError('HttpError status must be a integer between 400 and 599');
        }

        if (typeof code !== 'string' || code.trim() === '') {
            throw new TypeError('HttpError code must be a non-empty string');
        }

        if (typeof detail !== 'string' || detail.trim() === '') {
            throw new TypeError('HttpError details must be a non-empty string');
        }

        const normalizedHeaders = normalizeErrorHeaders(headers);

        super(detail, cause !== undefined? {cause} : undefined);
        this.name = 'HttpError';
        this.status = status;
        this.detail = detail;
        this.code = code;
        this.headers = normalizedHeaders;
    }
}

export function resolveRequestId(headerValue) {
    if (typeof headerValue === 'string') {
        const candidate = headerValue.trim();

        if (SAFE_REQUEST_ID_PATTERN.test(candidate)) {
            return candidate;
        }
    }
    return randomUUID();
}

export function createCorrelationMiddleware() {
    async function correlationMiddleware(ctx, next) {
        if (ctx === null || typeof ctx !== 'object' ||
            ctx.req === null || typeof ctx.req !== 'object' ||
            ctx.req.headers === null || typeof ctx.req.headers !== 'object' ||
            ctx.res === null || typeof ctx.res !== 'object') {
            throw new TypeError('Correlation middleware requires ctx.req.headers and ctx.res');
        }

        if (typeof next !== 'function') {
            throw new TypeError('Correlation middleware requires next function');
        }

        const requestId = resolveRequestId(ctx.req.headers['x-request-id']);
        ctx.requestId = requestId;

        if (!ctx.res.headersSent && typeof ctx.res.setHeader === 'function') {
            ctx.res.setHeader('X-Request-Id', requestId);
        }
        await next();
    }
    return correlationMiddleware;
}

function getProblemTitle(status) {
    return STATUS_CODES[status] ?? (status > 500? 'Server Error' : 'Client Error');
}

function createProblemDocument({status, code, detail, requestId}) {
    return {
        type: `urn:problem:${code}`,
        title: getProblemTitle(status),
        status,
        detail,
        code,
        requestId,
    };
}

export function classifyError(error, requestId) {
    const safeRequestId = resolveRequestId(requestId);

    if (error instanceof BodyAbortedError) {
        return {
            aborted: true,
            isInternal: false,
            status: null,
            headers: Object.freeze({}),
            problem: null,
        };
    }

    if (error instanceof HttpError) {
        return {
            aborted: false,
            isInternal: error.status >= 500,
            status: error.status,
            headers: error.headers,
            problem: createProblemDocument({
                status: error.status,
                code: error.code,
                detail: error.detail,
                requestId: safeRequestId,
            }),
        };
    }

    if (error instanceof BodyError) {
        return {
            aborted: false,
            isInternal: error.status >= 500,
            status: error.status,
            headers: error.headers,
            problem: createProblemDocument({
                status: error.status,
                code: error.code,
                detail: error.detail,
                requestId: safeRequestId,
            }),
        };
    }

    return {
        aborted: false,
        isInternal: true,
        status: 500,
        headers: Object.freeze({}),
        problem: createProblemDocument({
            status: 500,
            code: 'internal_error',
            detail: INTERNAL_ERROR_DETAIL,
            requestId: safeRequestId,
        }),
    };
}

export function writeProblemResponse(res, problem, options = {}) {
    if (res === null || typeof res !== 'object' ||
        typeof res.writeHead !== 'function' || typeof res.end !== 'function'
    ) {
        throw new TypeError('writeProblemResponse requires a response with writeHead and end');
    }

    if (problem === null || typeof problem !== 'object' ||
        !Number.isInteger(problem.status) || problem.status < 400 || problem.status > 599 ||
        typeof problem.code !== 'string' || typeof problem.detail !== 'string' || typeof problem.requestId !== 'string'
    ) {
        throw new TypeError('writeProblemResponse requires a valid problem document');
    }

    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('writeProblemResponse options must be an object');
    }

    const { method = 'GET', headers } = options;
    const extraHeaders = normalizeErrorHeaders(headers);
    const bodyBuffer = Buffer.from(JSON.stringify(problem), 'utf8');
    const responseHeaders = {
        ...extraHeaders,
        'Content-Type': PROBLEM_CONTENT_TYPE,
        'Content-Length': String(bodyBuffer.length),
        'Cache-Control': 'no-store',
        'X-Request-Id': problem.requestId,
    };

    res.writeHead(problem.status, responseHeaders);

    if (typeof method === 'string' && method.toUpperCase() === 'HEAD') {
        res.end();
        return;
    }

    res.end(bodyBuffer);
}

function isRequestAborted(ctx, classification) {
    if (classification.aborted) {
        return true;
    }

    if (ctx.signal?.aborted) {
        return true;
    }

    if (ctx.req.aborted) {
        return true;
    }

    return Boolean(ctx.req.destroyed) && !Boolean(ctx.req.readableEnded) && !Boolean(ctx.req.complete);
}

export function createErrorBoundary(options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('Error Boundary options must be an object');
    }

    const {onError} = options;

    if (onError !== undefined && typeof onError !== 'function') {
        throw new TypeError('Error Boundary onError options must be a function');
    }

    async function errorBoundary(ctx, next) {
        if (ctx === null || typeof ctx !== 'object' ||
            ctx.req === null || typeof ctx.req !== 'object' ||
            ctx.res === null || typeof ctx.res !== 'object'
        ) {
            throw new TypeError('Error Boundary requires ctx.req and ctx.res');
        }

        if (typeof next !== 'function') {
            throw new TypeError('Error boundary requires a next function')
        }

        if (
            typeof ctx.requestId !== 'string' ||
            !SAFE_REQUEST_ID_PATTERN.test(ctx.requestId)
        ) {
            ctx.requestId = resolveRequestId(ctx.req.headers?.['x-request-id']);
        }

        try {
            await next();
        } catch (error) {
            const classification = classifyError(error, ctx.requestId);
            const requestAborted = isRequestAborted(ctx, classification);
            const responseCommitted = Boolean(ctx.res.headersSent);

            if (onError !== undefined) {
                try {
                    onError(error, {
                        ctx,
                        requestId: ctx.requestId,
                        classification,
                        requestAborted,
                        responseCommitted,
                    });
                } catch (error) {
                    //Diagnostic hooks must never break error handling.
                }
            }

            if (responseCommitted) {
                if (typeof ctx.res.destroy === 'function') {
                    ctx.res.destroy();
                } else if (!ctx.res.writableEnded && typeof ctx.res.end === 'function') {
                    ctx.res.end();
                }
                return;
            }

            if (requestAborted) {
                return;
            }

            if (!ctx.res.writableEnded && !ctx.res.destroyed) {
                writeProblemResponse(ctx.res, classification.problem, {
                    method: ctx.req.method,
                    headers: classification.headers,
                });
            }
        }
    }
    return errorBoundary;
}