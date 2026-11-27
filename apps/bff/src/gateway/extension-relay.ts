import type { Server } from "node:http";
import net from "node:net";

/**
 * The OpenClaw Chrome extension (the person's signed-in Chrome) connects to the Gateway's /browser/extension
 * WebSocket. The Gateway listens on loopback only and the panel is the one published port, so the panel passes
 * that single path through. The Gateway authenticates the extension itself (pairing proofs); the panel session
 * cannot: an extension has no panel cookie.
 */
export const EXTENSION_PATH = "/browser/extension";

export function relayChromeExtension(server: Server, gatewayUrl: string): void {
  const { hostname, port } = new URL(gatewayUrl);
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://panel").pathname !== EXTENSION_PATH) return void socket.destroy();
    const headers: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    const upstream = net.connect(Number(port) || 80, hostname, () => {
      upstream.write(`GET ${req.url} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const close = () => { socket.destroy(); upstream.destroy(); };
    upstream.on("error", close).on("close", close);
    socket.on("error", close).on("close", close);
  });
}
