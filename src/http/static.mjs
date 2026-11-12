import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { HttpError } from "./error.mjs";

export const DEFAULT_STATIC_MIME_TYPES = Object.freeze({
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.woff2': 'font/woff'
});

function normalizeUrlPrefix(urlPrefix) {
    if (typeof urlPrefix !== 'string' || urlPrefix.trim() === '') {
        throw new TypeError('Static handler urlPrefix must be a non-empty string');
    }

    if (!urlPrefix.startsWith('/') || urlPrefix.includes('?') ||
        urlPrefix.includes('#') || urlPrefix.includes('\\')
    ) {
        throw new TypeError('Static handler urlPrefix must start with "/" and not contain query, fragment, or backslash characters');
    }

    if (urlPrefix.length > 1 && urlPrefix.endsWith("/")) {
        return urlPrefix.slice(0, -1);
    }

    return urlPrefix;
}

function createStaticNoteFoundError() {
    return new HttpError({
        status: 404,
        code: 'not_found',
        detail: 'Static assert was not found.'
    });
}

function extractDecodedSegments(ctx, normalizedPrefix) {
    if (typeof ctx.params?.assetPath === 'string') {
        if (ctx.params.assetPath === '') {
            throw createStaticNoteFoundError();
        }
        return ctx.params.assetPath.split('/');
    }

    const rawTarget = typeof ctx.path === 'string'? ctx.path : typeof ctx.req.url === 'string'? ctx.req.url : '';

    const queryIndex = rawTarget.indexOf('?');
    const rawPathname = queryIndex === -1? rawTarget : rawTarget.slice(0, queryIndex);

    const requiredPrefix = normalizedPrefix === '/'? '/' : `${normalizedPrefix}/`;

    if (!rawPathname.startsWith(requiredPrefix)) {
        throw createStaticNoteFoundError();
    }

    const relativeRawPath = rawPathname.slice(requiredPrefix.length);

    if (relativeRawPath === '') {
        throw createStaticNoteFoundError();
    }

    return relativeRawPath.split('/').map((rawSegment) => {
        try {
            return decodeURIComponent(rawSegment);
        } catch (error) {
            throw new HttpError({
                status: 404,
                code: 'invalid_target',
                detail: 'The request target contains invalid percent-encoding',
                cause: error,
            });
        }
    });
}

function resolveSanitizedAssetTarget(ctx, resolvedRootDir, normalizedPrefix) {
    const segments = extractDecodedSegments(ctx, normalizedPrefix);

    if (segments.length === 0) {
        throw createStaticNoteFoundError();
    }

    for (const segment of segments) {
        if (segment === '' || segment === '.' ||
            segment === '..' || segment.startsWith('.') ||
            segment.includes('/') || segment.includes('\\') ||
            segment.includes('\0')
        ) {
            throw createStaticNoteFoundError();
        }
    }

    const fileName = segments[segments.length - 1];
    const extension = path.extname(fileName).toLowerCase();
    const contentType = DEFAULT_STATIC_MIME_TYPES[extension];

    if (contentType === undefined) {
        throw createStaticNoteFoundError();
    }

    return {
        candidatePath: path.resolve(resolvedRootDir, ...segments),
        contentType,
    };
}

async function resolveContainedRegularFile(resolvedRootDir, candidatePath) {
    let canonicalRootDir;
    let canonicalFilePath;

    try {
        [canonicalRootDir, canonicalFilePath] = await Promise.all([
            realpath(resolvedRootDir),
            realpath(candidatePath),
        ]);
    } catch {
        throw createStaticNoteFoundError();
    }

    const relativeFromRoot = path.relative(canonicalRootDir, canonicalFilePath);

    if ( relativeFromRoot === '' || relativeFromRoot.startsWith('..') ||
        path.isAbsolute(relativeFromRoot)
    ) {
        throw createStaticNoteFoundError();
    }

    const canonicalSegments = relativeFromRoot.split(path.sep);

    if (canonicalSegments.some( (segment) => segment === '' || segment === '.' ||
                                                    segment === '..' || segment.startsWith('.'),
    )) {
        throw createStaticNoteFoundError();
    }

    const canonicalExtension = path.extname(canonicalFilePath).toLowerCase();

    if (DEFAULT_STATIC_MIME_TYPES[canonicalExtension] === undefined) {
        throw createStaticNoteFoundError();
    }

    let fileStat;
    try {
        fileStat = await stat(canonicalFilePath);
    } catch {
        throw createStaticNoteFoundError();
    }

    if (!fileStat.isFile()) {
        throw createStaticNoteFoundError();
    }

    return {
        canonicalFilePath,
        fileStat,
    };
}

export function createStaticFileHandler(options = {}) {

    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('Static handler option must be an object');
    }

    const {
        rootDir,
        urlPrefix = '/assets',
        cacheControl = 'public, max-age=60',
    } = options;

    if (typeof rootDir !== 'string' || rootDir.trim() === '') {
        throw new TypeError('Static handler rootDir must be a non-empty string');
    }

    if (typeof cacheControl !== 'string' || cacheControl.trim() === '') {
        throw new TypeError('Static handler cacheControl must be a non-empty string');
    }

    const resolvedRootDir = path.resolve(rootDir);
    const normalizedPrefix = normalizeUrlPrefix(urlPrefix);

    async function serveStaticFile(ctx) {
        if (ctx === null || typeof ctx !== 'object' ||
            ctx.req === null || typeof ctx.req !== 'object' ||
            ctx.res === null || typeof ctx.res !== 'object'
        ) {
            throw new TypeError('Static file handler requires ctx.req and ctx.res');
        }

        const method = typeof ctx.req.method === 'string'? ctx.req.method.toUpperCase() : '';

        if (method !== 'GET' && method !== 'HEAD') {
            throw new HttpError({
                status: 405,
                code: 'method_not_allowed',
                detail: `Method ${method || 'UNKNOWN'} is not allowed for static assets.`,
                headers: { Allow: 'GET, HEAD' },
            });
        }

        const assetTarget = resolveSanitizedAssetTarget(ctx, resolvedRootDir, normalizedPrefix);

        const resolvedFile = await resolveContainedRegularFile(resolvedRootDir, assetTarget.candidatePath);

        const headers = {
            'Content-Type': assetTarget.contentType,
            'Content-Length': String(resolvedFile.fileStat.size),
            'Last-Modified': resolvedFile.fileStat.mtime.toUTCString(),
            'Cache-Control': cacheControl,
            'X-Content-Type-Options': 'nosniff',
        };

        ctx.res.writeHead(200, headers);

        if (method === 'HEAD') {
            ctx.res.end();
            return;
        }

        await pipeline(
            createReadStream(resolvedFile.canonicalFilePath),
            ctx.res,
            {signal: ctx.signal},
        );
    }

    return serveStaticFile;
}










