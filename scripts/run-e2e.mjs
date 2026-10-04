import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// A container DNS name over HTTP is not a secure browser context. Forward the
// real stack through loopback in the browser runner, matching manual localhost
// testing and preserving crypto/clipboard APIs without browser security flags.
// This proxy has no fixtures or API mocks and only listens inside this runner.
const upstream = new URL(process.env.WFS_E2E_UPSTREAM ?? 'http://frontend:8080');
const server = createServer((incoming, outgoing) => {
    const forwarded = request({
        hostname: upstream.hostname,
        port: upstream.port,
        path: incoming.url,
        method: incoming.method,
        headers: incoming.headers
    }, response => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
    });
    forwarded.on('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end('E2E frontend unavailable');
    });
    incoming.on('aborted', () => forwarded.destroy());
    incoming.pipe(forwarded);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}`;
console.log(`Testing real Compose stack through ${url}`);
try {
    const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config=playwright.e2e.config.ts'], {
        stdio: 'inherit', env: { ...process.env, WFS_E2E_URL: url }
    });
    const [code] = await once(child, 'exit');
    process.exitCode = code ?? 1;
} finally {
    server.closeAllConnections();
    server.close();
}
