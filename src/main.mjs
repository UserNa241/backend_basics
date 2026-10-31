
import {createHttpServerCore} from "./http/server-core.mjs";

function temporaryRequestListener(req, res) {
    const body =
        'Server core is running. The HTTP adapter has not been assembled yet.\n';

    res.writeHead(503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });

    if (req.method === 'HEAD') {
        res.end();
        return;
    }
    res.end(body);
}

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? '3000');

const core = createHttpServerCore({
    requestListener: temporaryRequestListener,
    host,
    port,
});

let shutdownStarted = false;
async function shutdown(signal) {
    if (shutdownStarted) {
        return;
    }

    shutdownStarted = true;
    console.log(`Recieved ${signal}; shutting down gracefully...`);

    try {
        await core.stop();
    } catch (error) {
        console.error('Graceful shutdown failed:', error);
        process.exitCode = 1;
    }
}

process.once('SIGINT', () => {
    void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
})

const address = await core.start();

console.log(
    `HTTP server core listening on http://${address.address}:${address.port}`,
);







