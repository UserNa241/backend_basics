
import {createServer} from 'node::http';

const MAX_TIMER_MS = 2_147_483_647;

function assertIntegerInRange (name, value, minimum, maximum) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`Expected ${name} to be an integer between ${minimum} - ${maximum}`);
    }
}

export function createHttpServerCore(options = {}) {

    const {
        requestListener,
        host = '127.0.0.1',
        port = 3000,
        headersTimeoutMs = 10_000,
        requestTimeoutMs = 30_000,
        keepAliveTimeoutMs = 5_000,
        socketTimeoutMs = 0,
        shutdownTimeoutMs = 10_000,
    } = options;

    if (typeof requestListener !== 'function') {
        throw new Error('requestListener must be a function');
    }

    if (typeof host !== 'string' || host.trim() === '') {
        throw new Error('host must be a non-empty string');
    }

    assertIntegerInRange('port', port, 0, 65_535);
    assertIntegerInRange('headersTimeoutMs', headersTimeoutMs, 1, MAX_TIMER_MS);
    assertIntegerInRange('requestTimeoutMs', requestListener, 1, MAX_TIMER_MS);
    assertIntegerInRange('KeepAliveTimeoutMs', keepAliveTimeoutMs, 0, MAX_TIMER_MS);
    assertIntegerInRange('socketTimeoutMs', socketTimeoutMs, 0, MAX_TIMER_MS);
    assertIntegerInRange('shutdownTimeoutMs', shutdownTimeoutMs, 1, MAX_TIMER_MS);

    if (requestTimeoutMs < headersTimeoutMs) {
        throw new RangeError('requestTimeoutMs must be greater than or equal to headersTimeoutMs');
    }

    const server = createServer(requestListener);

    server.headersTimeout = headersTimeoutMs;
    server.requestTimeout = requestTimeoutMs;
    server.keepAliveTimeout = keepAliveTimeoutMs;
    server.timeout = socketTimeoutMs;

    const sockets = new Set();

    function onConnection(socket) {
        sockets.add(socket);

        socket.once('close', () => {
            sockets.delete(socket);
        });
    }

    function onClientError(error, socket) {
        if (socket.destroyed) {
            return;
        }

        if (!socket.writable || error.code === 'ECONNRESET') {
            socket.destroy();
            return;
        }

        socket.end(
            'HTTP/1.1 400 Bad Request\r\n' +
            'Connection: close\r\n' +
            'Content-Length: 0\r\n' +
            '\r\n',
        );
    }

    server.on('connection', onConnection);
    server.on('clientError', onClientError);

    const config = {
        host,
        port,
        headersTimeoutMs,
        requestTimeoutMs,
        keepAliveTimeoutMs,
        socketTimeoutMs,
        shutdownTimeoutMs,
    }

    let startPromise = null;
    let stopPromise = null;
    let closing = false;

    function start() {

        if (closing) {
            return Promise.reject(
                new Error('Cannot start the HTTP server core after stop() has been called'),
            );
        }

        if (startPromise !== null) {
            return startPromise;
        }

        startPromise = new Promise((resolve, reject) => {

            function cleanupStartListeners() {
                server.off('error', onStartError);
                server.off('listening', onListening);
            }

            function onStartError(err) {
                cleanupStartListeners();
                reject(err);
            }

            function onListening() {
                cleanupStartListeners();
                resolve(server.address());
            }

            server.once('error', onStartError);
            server.once('listening', onListening);

            try {
                server.listen(port, host);
            } catch (err) {
                onStartError(err);
            }
        });

        return startPromise;
    }

    async function closeServer() {
        if (startPromise !== null) {
            try {
                await startPromise;
            } catch {
                return;
            }
        }

        if (!server.listening) {
            return;
        }

        await new Promise((resolve, reject) => {
            let forceCloseTimer = null;

            function onServerClosed(error) {
                if (forceCloseTimer !== null) {
                    clearTimeout(forceCloseTimer);
                }

                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            }

            server.close(onServerClosed);
            server.closeIdleConnections();

            forceCloseTimer = setTimeout(() => {
                for (const socket of sockets) {
                    socket.destroy();
                }
            }, shutdownTimeoutMs);

            forceCloseTimer.unref();
        });

    }

    function stop() {
        if (stopPromise !== null) {
            return stopPromise;
        }
        closing = true;
        stopPromise = closeServer();
        return stopPromise;
    }

    function isClosing() {
        return closing;
    }

    return {
        server,
        config,
        start,
        stop,
        isClosing,
    };
}
