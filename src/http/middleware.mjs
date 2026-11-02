
export function composeMiddleware(middlewares) {

    if (!Array.isArray(middlewares)) {
        throw new TypeError('Middlewares must be an array of functions');
    }

    for (let index = 0; index < middlewares.length; index++) {
        if (typeof middlewares[index] !== 'function') {
            throw new TypeError(`Middleware at index ${index} must be a function`);
        }
    }

    const middlewareChain = [...middlewares];

    async function runMiddleware(ctx) {
        let highestDispatchedIndex = -1;

        async function dispatchMiddlewareAtIndex(index) {
            if (index <= highestDispatchedIndex) {
                throw new Error('next() called multiple times');
            }

            highestDispatchedIndex = index;

            if (index >= middlewareChain.length) {
                throw new Error('next() called after the final middleware');
            }

            const currentMiddleware = middlewareChain[index];
            let isActiveNext = true;

            async function runNextMiddleware() {
                if (!isActiveNext) {
                    throw new Error('next() called after the middleware returned');
                }

                await dispatchMiddlewareAtIndex(index + 1);
            }

            try {
                await currentMiddleware(ctx, runNextMiddleware);
            } finally {
                isActiveNext = false;
            }
        }

        if (middlewareChain.length === 0) {
            return;
        }

        await dispatchMiddlewareAtIndex(0);
    }
    return runMiddleware;
}