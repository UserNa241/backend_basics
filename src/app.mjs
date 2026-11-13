import path from 'node:path';

import {createJsonBodyParser} from "./http/body.mjs";
import {createCorrelationMiddleware,
        createErrorBoundary,
        HttpError} from "./http/error.mjs";
import {composeMiddleware} from "./http/middleware.mjs";
import {createRouter} from "./http/router.mjs";
import {createHttpServerCore} from "./http/server-core.mjs";
import {createStaticFileHandler} from "./http/static.mjs";


export function createVanillaApp(options = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
        throw new TypeError('Vanilla app options must be an object');
    }

    const {
        serverConfig,
        publicRootDir,
        routes = [],
        middlewares = [],
    } = options;

    if (serverConfig === null || typeof serverConfig !== "object" || Array.isArray(serverConfig)) {
        throw new TypeError('Vanilla app serverConfig must be an object');
    }

    if (typeof publicRootDir !== "string" || publicRootDir.trim() === '') {
        throw new TypeError('Vanilla app publicRootDir must be a non-empty string');
    }

    if (!Array.isArray(routes)) {
        throw new TypeError('Vanilla app routes must be an array');
    }

    if (!Array.isArray(middlewares)) {
        throw new TypeError('Vanilla app middlewares must be an array');
    }

    const router = createRouter();
    const staticHandler = createStaticFileHandler({
        rootDir: publicRootDir,
        urlPrefix: '/assets'
    });

    const jsonBodyParser = createJsonBodyParser({maxBytes: 102_400, required: false,});

    for (const route of routes) {
        if (route === null || typeof route !== "object" ||
            typeof route.method !== 'string' || typeof route.pattern !== 'string' || typeof route.handler !== 'function'
        ) {
            throw new TypeError('Vanilla app routes must be objects with method, pattern, and handler');
        }

        router.add(route.method, route.pattern, route.handler);
    }

    router.add('GET', '/assets/*', staticHandler);
    router.add('HEAD', '/assets/*', staticHandler);

    function createContext(req, res) {
        const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

        return {
            req,
            res,
            url,
            path: url.pathname,
            method: req.method,
            headers: req.headers,
            requestId: null,
            body: undefined,
            params: null,
            query: url.searchParams,
            signal: undefined,
        };
    }

    async function dispatch(ctx) {

        const matchResult = router.match(ctx.method, ctx.path);

        if (matchResult.type === 'not-found') {
            throw new HttpError({
                status: 404,
                code: 'not_found',
                detail: 'The requested resource was not found.',
            });
        }

        if (matchResult.type === 'method-not-allowed') {
            throw new HttpError({
                status: 405,
                code: 'method_not_allowed',
                detail: `Method ${ctx.method} is not allowed for this resource.`,
                headers: {Allow: matchResult.allowedMethods.join(', ')},
            });
        }

        if (matchResult.type === 'bad-target') {
            throw new HttpError({
                status: 400,
                code: 'invalid_target',
                detail: 'The request target is malformed.',
            });
        }

        ctx.params = matchResult.params;
        ctx.query = matchResult.query;

        const {handler} = matchResult;
        await handler(ctx);
    }

    const loggingMiddleware = async (ctx, next) => {
        const start = process.hrtime.bigint();

        try {
            await next();
        } finally {
            const end = process.hrtime.bigint();
            const durationMs = Number(end - start) / 1_000_000;
            console.log(`${ctx.method} ${ctx.path} ${ctx.res.statusCode ?? '-'} ${durationMs.toFixed(2)}ms`,);
        }
    };

    const correlationMiddleware = createCorrelationMiddleware();

    const errorBoundary = createErrorBoundary({
        onError: (error, observation) => {
            console.error(`Request failed: ${error.code ?? error.name} (${error.status ?? '500'}`, observation.requestId,);
        },
    });

    const errorBoundaryMiddleware = async (ctx, next) => errorBoundary(ctx, next);

    const chain = [correlationMiddleware, loggingMiddleware, errorBoundaryMiddleware, ...middlewares, jsonBodyParser, dispatch,];

    const runMiddleware = composeMiddleware(chain);

    async function requestHandler(req, res) {
        const ctx = createContext(req, res);
        await runMiddleware(ctx);
    }

    const core = createHttpServerCore({
        ...serverConfig,
        requestListener: requestHandler,
    });

    return {
        core,
        router,
        staticHandler,
        start: core.start,
        stop: core.stop,
        isClosing: core.isClosing,
    };
}















