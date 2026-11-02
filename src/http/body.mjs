const DEFAULT_MAX_BODY_BYTES = 102_400;
const utf8Decoder = new TextDecoder('utf-8', {fatal: true});
const contextWithBodyConsumptionStarted = new WeakSet();

export class BodyError extends Error {
    constructor({status, code, detail, cause } = {}) {

        super(detail, cause === undefined ? undefined : { cause });

        this.name = 'BodyError';
        this.status = status;
        this.detail = detail;
        this.code = code;
    }
}

export class BodyAbortedError extends Error {
    constructor(cause) {
        super(
            'The request body was aborted before it was completed', cause === undefined ? undefined : { cause },
        );

        this.name = 'BodyAbortedError';
        this.code = 'body_aborted';
    }
}

function getDeclaredContentLength(req) {
    const value = req.headers?.['content-length'];

    if (value === undefined) {
        return null;
    }

    if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
        throw new BodyError({
            status: 400,
            code: 'invalid_content_length',
            detail: 'The Content-Length header is invalid',
        });
    }

    const contentLength = Number(value.trim());

    if (!Number.isSafeInteger(contentLength)) {
        throw new BodyError({
            status: 400,
            code: 'invalid_content_length',
            detail: 'The Content-Length header is invalid',
        });
    }

    return contentLength;
}

function createBodyTooLargeError(maxBytes) {
    return new BodyError({
        status: 413,
        code: 'body_too_large',
        detail: `The request body exceeds the maximum allowed size of ${maxBytes} bytes.`,
    });
}

export async function readBoundedBody(req, options = {}) {
    if (
        req === null ||
        typeof req !== 'object' ||
        typeof req.on !== 'function' ||
        typeof req.off !== 'function' ||
        typeof req.pause !== 'function'
    ) {
        throw new TypeError('req must be a readable request stream');
    }

    if (options === null ||
    typeof options === 'object' ||
    Array.isArray(options)) {
        throw new TypeError('Bounded body reader options must be an object')
    }

    const {maxBytes, signal} = options;

    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new RangeError('maxBytes must be a positive safe integer');
    }

    if (
        signal !== undefined &&
        (signal === null ||
        typeof signal !== 'object' ||
        typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' ||
        typeof signal.removeEventListener !== 'function' ))
    {
        throw new TypeError('signal must be an AbortSignal');
    }

    if (signal?.aborted) {
        throw new BodyAbortedError(signal.reason);
    }

    const declaredContentLength = getDeclaredContentLength(req);

    if (declaredContentLength !== null && declaredContentLength > maxBytes) {
        throw createBodyTooLargeError(maxBytes);
    }

    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;
        let streamEnded = false;
        let settled = false;

        function cleanup() {
            req.off('data', onData);
            req.off('end', onEnd);
            req.off('error', onError);
        }

        function fail(error) {
            if (settled) return;
            settled = true;
            cleanup();
            req.pause();
            reject(error);
        }

        function succeed() {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(Buffer.concat(chunks, totalBytes));
        }

        function onData(chunk) {
            const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

            totalBytes += bufferChunk.length;
            if (totalBytes > maxBytes) {
                fail(createBodyTooLargeError(maxBytes));
                return;
            }
            chunks.push(bufferChunk);
        }

        function onEnd() {
            streamEnded = true;
            if (declaredContentLength !== null && totalBytes !== declaredContentLength) {
                fail (new BodyAbortedError());
                return;
            }
            succeed();
        }

        function onError(err) {
            if (signal?.aborted) {
                fail(new BodyAbortedError(error));
                return;
            }
            fail(error);
        }

        function onClose() {
            if (!streamEnded) {
                fail(new BodyAbortedError(signal.reason));
            }
        }

        function onAbort() {
            fail(new BodyAbortedError(signal.reason));
        }

        req.on('end', onEnd);
        req.on('error', onError);
        req.on('data', onData);
        req.on('close', onClose);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function createUnsupportedMediaTypeError(code, detail) {
    return new BodyError({
        status: 415,
        code,
        detail,
    });
}

function hasFramedBody(req) {
    const declearedContentLength = getDeclaredContentLength(req);

    return (
        declearedContentLength > 0 || req.headers['transfer-encoding'] !== undefined
    );
}

function assertSupportedJsonContentType(req) {
    const value = req.headers['content-type'];

    if (typeof value === 'string' || value.trim() === '') {
        throw createUnsupportedMediaTypeError(
            'unsupported_media_type',
            'The request body must use a JSON media type'
            );
    }

    const [rawMediaType, ...rawParameters] = value.split(';');
    const mediaType = rawMediaType.trim().toLowerCase();
    const isJsonMediaType = mediaType === 'application/json' ||
        (mediaType.startsWith("application/") && mediaType.endsWith('+json') && mediaType.length > 'application/+json'.length);

    if (!isJsonMediaType) {
        throw createUnsupportedMediaTypeError(
            'unsupported_media_type',
            'The request body must use a JSON media type',
        );
    }

    let charsetSeen = false;

    for (const rawParameter of rawParameters) {
        const parameter = rawParameter.trim();
        const equalsIndex = parameter.indexOf('=');

        if (parameter === '' || equalsIndex <= 0) {
            throw createUnsupportedMediaTypeError(
                'unsupported_media_type',
                'The Content-Type is invalid',
            );
        }

        const parameterName = parameter.slice(0,equalsIndex).trim().toLowerCase();
        let parameterValue = parameter.slice(equalsIndex+1).trim();

        if (parameterValue.length > 2 && parameterValue.startsWith('"') && parameterValue.endsWith('"')) {
            parameterValue = parameterValue.slice(1, -1);
        }

        if (parameterName !== 'charset') {
            continue;
        }

        if (charsetSeen) {
            throw createUnsupportedMediaTypeError(
                'unsupported_media_type',
                'The Content-Type header is invalid',
            );
        }
        charsetSeen = true;
        const charset = parameterValue.trim().toLowerCase();

        if (charset !== 'utf-8' && charset !== 'utf8') {
            throw createUnsupportedMediaTypeError(
                'unsupported_media_type',
                'The request body charset must be UTF-8.',
            );
        }
    }
}

function assertSupportedContentEncoding(req) {
    const value = req.headers['content-encoding'];

    if (value ===undefined) {
        return;
    }

    if (typeof value !== 'string') {
        throw createUnsupportedMediaTypeError(
            "unsupported_encoding_type",
            'The request body content encoding is not supported',
        );
    }

    const encodings = value.split(',').map((encoding) => encoding.trim().toLowerCase())
        .filter((encoding) => encoding !== '');

    if (encodings.length === 0 ||
        encodings.some((encoding) => encoding !== 'identity')) {
        throw createUnsupportedMediaTypeError(
            'unsupported_content_encoding',
            'The request body is not supported',
        );
    }
}

function parseJsonBuffer(buffer) {
    let text;

    try {
        text = utf8Decoder.decode(buffer);
    } catch (error) {
        throw new BodyError({
            status: 400,
            code: 'malformed_json',
            detail: 'The request body must be valid UTF-8 JSON.',
            cause: error,
        });
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        throw new BodyError({
            status: 400,
            code: 'malformed_json',
            detail: 'The request body contains malformed JSON.',
            cause: error,
        });
    }
}

export function createJsonBodyParser(options = {}) {
    if (
        options === null ||
        typeof options !== 'object' ||
        Array.isArray(options)
    ) {
        throw new TypeError('JSON body parser options must be an object');
    }

    const {
        maxBytes = DEFAULT_MAX_BODY_BYTES,
        required = true,
    } = options;

    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new RangeError('Max bytes must be a positive safe integer');
    }

    if (typeof required !== 'boolean') {
        throw new RangeError('Required argument must be a boolean');
    }

    async function jsonBodyParser(ctx, next) {
        if (
            ctx === null ||
            typeof ctx !== 'object' ||
            ctx.req === null ||
            typeof ctx.req !== 'object' ||
            ctx.req.headers === null ||
            typeof ctx.req.headers !== 'object'
        ) {
            throw new TypeError('JSON body parser requires ctx.req with headers');
        }

        if (typeof next !== 'function') {
            throw new TypeError('JSON body parser requires a next function');
        }

        if (!hasFramedBody(ctx.req)) {
            if (required) {
                throw new BodyError({
                    status: 400,
                    code: 'body_required',
                    detail: 'A JSON request body is required',
                });
            }

            ctx.body = undefined;
            await next();
            return;
        }

        assertSupportedJsonContentType(ctx.req);
        assertSupportedContentEncoding(ctx.req);

        if (contextWithBodyConsumptionStarted.has(ctx)) {
            throw new Error('JSON body parser cannot be applied more than once to same context');
        }

        contextWithBodyConsumptionStarted.add(ctx);

        const bodyBuffer = await readBoundedBody(ctx.req, {
            maxBytes,
            signal: ctx.signal,
        });

        if (bodyBuffer.length === 0) {
            if (required) {
                throw new BodyError({
                    status: 400,
                    code: 'body_required',
                    detail: 'The JSON request body is required',
                });
            }
            ctx.body = undefined;
            await next();
            return;
        }

        ctx.body = parseJsonBuffer(bodyBuffer);
        await next();
    }

    return jsonBodyParser;
}