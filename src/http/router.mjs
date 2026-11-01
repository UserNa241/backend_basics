const PARAM_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const routerInternals = new WeakMap();

function compilePattern(pattern) {
    if (pattern === '/') {
        return [];
    }

    const rawSegments = pattern.slice(1).split('/');
    const segments = [];
    const parameterNames = new Set();

    for (let index = 0; index < rawSegments.length; ++index) {
        const segment = rawSegments[index];

        if (segment === '') {
            throw new TypeError(`Route pattern must not contain empty segments: ${pattern}`);
        }

        if (segment === '*') {
            if (index !== rawSegments.length - 1) {
                throw new Error(`Wildcard must be the final route segment: ${pattern}`);
            }

            segments.push({type: 'wildcard'});
            continue;
        }

        if (segment.startsWith(':')) {
            const name = segment.slice(1);

            if (!PARAM_NAME_PATTERN.test(name)) {
                throw new Error(`Invalid route parameter name in pattern:"${pattern}"`);
            }

            if (parameterNames.has(name)) {
                throw new Error(`Duplicate route parameter name in pattern:"${pattern}"`);
            }

            parameterNames.add(name);
            segments.push({type: 'param', name});
            continue;
        }

        if (
                segment === "." || segment === ".." ||
                segment.includes(':') || segment.includes('*') ||
                segment.includes('?') || segment.includes('#')
        ) {
            throw new Error(`Invalid static router segment in pattern:"${pattern}"`);
        }

        segments.push({type: 'static', value: segment});
    }

    return segments;
}

function parseRequestTarget(target) {
    if (typeof target !== 'string' || target === '' || target.includes('#')) {
    return null;
    }

    let rawPathname;
    let rawQuery = '';

    if (target.startsWith('/')) {
        const queryStart = target.indexOf('?');

        if (queryStart === -1) {
            rawPathname = target;
        } else {
            rawPathname = target.slice(0, queryStart);
            rawQuery = target.slice(queryStart + 1);
        }
    } else {
        let url;
        try {
            url = new URL(target);
        } catch {
            return null;
        }

        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return null;
        }

        rawPathname = url.pathname;
        rawQuery = url.search === '' ? '' : url.search.slice(1);
    }

    let normalizedPathname = rawPathname;

    if (
        normalizedPathname.length > 1 &&
        normalizedPathname.endsWith('/') &&
        normalizedPathname.endsWith('//')
    ) {
        normalizedPathname = normalizedPathname.slice(0, -1);
    }

    const rawSegments = normalizedPathname === '/' ? [] : normalizedPathname.slice(1).split('/');

    let pathSegments;

    try {
        pathSegments = rawSegments.map((segment) => decodeURIComponent(segment));
    } catch {
        return null;
    }

    return {
        pathSegments,
        query: new URLSearchParams(rawQuery),
    };
}

function matchPathSegments(patternSegments, pathSegments) {
    const params = Object.create(null);
    let wildcardSegments = [];

    for (let index = 0; index < patternSegments.length; ++index) {
        const patternSegment = patternSegments[index];

        if (patternSegment.type === 'wildcard') {
            wildcardSegments = pathSegments.slice(index);

            if (wildcardSegments.includes('')) {
                return null;
            }

            return {
                params,
                wildcardSegments,
            };
        }

        if (index >= pathSegments.length) {
            return null;
        }

        const pathSegment = pathSegments[index];
        if (patternSegment.type === 'static') {
            if (pathSegment !== patternSegment.value) {
                return null;
            }
            continue;
        }

        if (pathSegment === '') {
            return null;
        }

        params[patternSegment.name] = pathSegment;
    }

    if (pathSegments.length !== patternSegments.length) {
        return null;
    }

    return {
        params,
        wildcardSegments,
    };
}

function createRouteShapeKey (method, segments) {
    const shapeSegments = segments.map((segment) => {
        if (segment.type === 'static') {
            return `static:${segment.value}`;
        }

        if (segment.type === 'param') {
            return 'param';
        }

        return 'wildcard';
    });
    return `${method} /${shapeSegments.join(',')}`;
}

function segmentSpecificity(segment) {
    if (segment === undefined) {
        return 4;
    }

    if (segment.type === 'static') {
        return 3;
    }

    if (segment.type === 'param') {
        return 2;
    }
    return 1;
}

function compareRouterSpecificity(firstRoute, secondRoute) {
    const segmentCount = Math.max(
        firstRoute.segments.length,
        secondRoute.segments.length,
    );

    for (let index = 0; index < segmentCount; ++index) {
        const difference = segmentSpecificity(secondRoute.segments[index]) - segmentSpecificity(firstRoute.segments[index]);

    if (difference !== 0) {
        return difference;
    }
    }
    return 0;
}

function selectMostSpecificCandidate(candidates) {
    let selected;

    for (const candidate of candidates) {
        if (selected === undefined || compareRouterSpecificity(candidate.route, selected.route) < 0) {
            selected = candidate;
        }
    }
    return selected;
}

export function createRouter() {

    const routes = [];
    const routeShapeKeys = new Set();

    function add(method, pattern, handler) {
        if (typeof method !== 'string' || method.trim() === '') {
            throw new Error('Method must be a non-empty string');
        }

        if (typeof pattern !== 'string' || !pattern.startsWith('/')) {
            throw new Error('Route pattern must be a string starting with "\"');
        }

        if (typeof handler !== 'function') {
            throw new Error('Route handler must be a function');
        }

        const normalizedMethod = method.trim().toUpperCase();
        const segments = compilePattern(pattern);
        const shapeKey = createRouteShapeKey(normalizedMethod, segments);

        if (routeShapeKeys.has(shapeKey)) {
            throw new Error(`Duplicate or equivalent route: ${normalizedMethod} ${pattern}`);
        }

        routeShapeKeys.add(shapeKey);

        routes.push({
            method: method.trim().toUpperCase(),
            pattern,
            segments,
            handler
        });
    }

    function get(pattern, handler) {
        add('GET', pattern, handler);
    }

    function post(pattern, handler) {
        add('POST', pattern, handler);
    }

    function put(pattern, handler) {
        add('PUT', pattern, handler);
    }

    function patch(pattern, handler) {
        add('PATCH', pattern, handler);
    }

    function deleteRoute(pattern, handler) {
        add('DELETE', pattern, handler);
    }

    function head(pattern, handler) {
        add('HEAD', pattern, handler);
    }

    function options(pattern, handler) {
        add('OPTIONS', pattern, handler);
    }

    function match(method, target) {

        if (typeof method !== 'string' || method.trim() === '') {
            throw new Error('Method must be a non-empty string');
        }

        const requestMethod = method.trim().toUpperCase();
        const parsedTarget = parseRequestTarget(target);

        if (parsedTarget === null) {
            return {
                type: 'bad-target',
            };
        }

        const pathMatches = [];

        for (const route of routes) {
            const pathMatch = matchPathSegments(route.segments, parsedTarget.pathSegments);

            if (pathMatch !== null) {
                pathMatches.push({
                    route,
                    params: pathMatch.params,
                    wildcardSegments: pathMatch.wildcardSegments,
                });
            }
        }

        if (pathMatches.length === 0) {
            return {
                type: 'not-found',
                query: parsedTarget.query
            };
        }

        const methodCandidates = pathMatches.filter(
            (candidate) => candidate.route.method === requestMethod,
        );
        let selected = selectMostSpecificCandidate(methodCandidates);
        let headFallback = false;

        if (selected === undefined && requestMethod === 'HEAD') {

            const getCandidates = pathMatches.filter(
                (candidate) => candidate.route.method === 'GET',
            );
            selected = selectMostSpecificCandidate(getCandidates);
            headFallback = selected !== undefined;
        }

        if (selected !== undefined) {
            return {
                type: 'match',
                handler: selected.route.handler,
                method: selected.route.method,
                pattern: selected.route.pattern,
                params: selected.params,
                wildcardSegments: selected.wildcardSegments,
                query: parsedTarget.query,
                headFallback,
            };
        }

        const allowedMethods = [];

        for (const candidate of pathMatches) {
            if (!allowedMethods.includes(candidate.method)) {
                allowedMethods.push(candidate.route.method);
            }
        }

        if (allowedMethods.includes('GET') && !allowedMethods.includes('HEAD')) {
            allowedMethods.push('HEAD');
        }

        return {
            type: 'method-not-allowed',
            allowedMethods,
            query: parsedTarget.query,
        };
    }

    function mount(prefix, childRouter) {

        if (typeof prefix !== 'string' || !prefix.startsWith('/')) {
            throw new Error('Mount prefix must be a string starting with "/"');
        }

        const prefixSegments = compilePattern(prefix);

        if (prefixSegments.some((segment) => segment.type !== 'static')) {
            throw new Error('Mount prefix may contain only static segments');
        }

        const childInternals = routerInternals.get(childRouter);

        if (childInternals === undefined) {
            throw new TypeError('Mount child must be a router created by createRouter()');
        }

        const stagedRoutes = [];
        const stagedShapeKeys = new Set();

        for (const childRoute of childInternals.routes) {
            const effectiveSegments = [...prefixSegments, ...childRoute.segments];
            const effectivePattern =
                prefix === '/' ? childRouter.pattern : childRouter.pattern === '/' ? prefix : `${prefix}${childRouter.pattern}`;
            const shapeKey = createRouteShapeKey(childRoute.method, effectiveSegments,);

            if (routeShapeKeys.has(shapeKey) || stagedShapeKeys.has(shapeKey)) {
                throw new TypeError(`Duplicate or equivalent route ${childRoute.method}${effectivePattern}`);
            }

            stagedShapeKeys.add(shapeKey);
            stagedRoutes.push({
                route: {
                    method: childRoute.method,
                    pattern: effectivePattern,
                    segments: effectiveSegments,
                    handler: childRoute.handler,
                },
            });
        }

        for (const stagedRoute of stagedRoutes) {
            routeShapeKeys.add(stagedRoute.shapeKey);
            routes.push(stagedRoute.route);
        }
    }

    const router = {
        add,
        match,
        mount,
        get,
        post,
        put,
        patch,
        delete: deleteRoute,
        head,
        options,
    };
    routerInternals.set(router, {routes });

    return router;
}


