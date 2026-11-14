import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {createVanillaApp} from "./app.mjs";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const publicRootDir = path.resolve(currentDir, '../public');

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? '3000');

const app = createVanillaApp({
    serverConfig: {
        host,
        port,
    },
    publicRootDir,
    routes: [
        {
            method: 'GET',
            pattern: '/api/hello',
            handler: async (ctx) => {
                ctx.res.writeHead(200, {'Content-Type': 'application/json'});
                ctx.res.end(JSON.stringify({message: 'Hello from the Vanilla HTTP adapter'}),);
            },
        },
        {
            method: "POST",
            pattern: '/api/echo',
            handler: async (ctx) => {
                ctx.res.writeHead(200, {'Content-Type': 'application/json'});
                ctx.res.end(JSON.stringify({received: ctx.body}))
            },
        },
    ],
    middlewares: [],
});

let shutdownStarted = false;

async function shutdown(signal) {
    if (shutdownStarted) {
        return;
    }

    shutdownStarted = true;
    console.log(`Received ${signal}; shutting down gracefully...`);

    try {
        await app.stop();
    } catch (err) {
        console.error('Graceful shutdown failed:', err);
        process.exitCode = 1;
    }
}
process.once ('SIGINT', () => {
    void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
});

const address = await app.start();

console.log(`Vanilla HTTP adapter listening on http://http://localhost:3000/`);

