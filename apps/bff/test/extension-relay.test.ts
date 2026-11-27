import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { relayChromeExtension } from "../src/gateway/extension-relay.js";

const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

async function listen<T extends net.Server>(server: T): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => server.close());
  return (server.address() as AddressInfo).port;
}

/** Sends a WebSocket upgrade for `path` and returns everything the panel sent back before closing. */
function upgrade(port: number, path: string): Promise<string> {
  return new Promise((resolve) => {
    let got = "";
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`GET ${path} HTTP/1.1\r\nHost: panel\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Proof: abc\r\n\r\n`));
    socket.on("data", (d) => { got += d; if (got.includes("after-handshake")) socket.end(); });
    socket.on("close", () => resolve(got));
    socket.on("error", () => resolve(got));
  });
}

describe("Chrome extension relay", () => {
  it("passes /browser/extension to the Gateway with its headers and nothing else", async () => {
    const seen: string[] = [];
    // A stand-in Gateway: records the request, answers the handshake and one frame.
    const gatewayPort = await listen(net.createServer((s) => s.once("data", (d) => { seen.push(String(d)); s.write("HTTP/1.1 101 Switching Protocols\r\n\r\nafter-handshake"); })));
    const panel = http.createServer((_req, res) => res.end("panel"));
    relayChromeExtension(panel, `ws://127.0.0.1:${gatewayPort}`);
    const panelPort = await listen(panel);

    expect(await upgrade(panelPort, "/browser/extension?v=2")).toContain("101 Switching Protocols\r\n\r\nafter-handshake");
    expect(seen[0]).toMatch(/^GET \/browser\/extension\?v=2 HTTP\/1\.1\r\n/);
    expect(seen[0]).toContain("X-Proof: abc");

    expect(await upgrade(panelPort, "/")).toBe("");
    expect(await upgrade(panelPort, "/browser/extension/../x")).toBe("");
    expect(await upgrade(panelPort, "/api/chat")).toBe("");
    expect(seen).toHaveLength(1);
  });

  it("closes the extension's connection when the Gateway is down", async () => {
    const dead = await listen(net.createServer());
    closers.pop()!();
    const panel = http.createServer();
    relayChromeExtension(panel, `ws://127.0.0.1:${dead}`);
    expect(await upgrade(await listen(panel), "/browser/extension")).toBe("");
  });
});
