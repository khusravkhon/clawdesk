// Data sources: install the official Notion plugin (MCP over OAuth) and see what the Gateway exposes.
//
//   pnpm --filter @clawdesk/bff notion-probe            install (with capability consent) + restart + inspect
//   pnpm --filter @clawdesk/bff notion-probe --inspect  only inspect
//   pnpm --filter @clawdesk/bff notion-probe --mcp-config http://localhost:5173/api/sources/notion/callback
//        write mcp.servers.notion (OAuth, redirect to the panel) so `openclaw mcp login notion` can find it

import { patchConfig } from "../gateway/config-patch.js";
import { connectForScript, flagValue, hasFlag, short } from "./_cli.js";

const PACKAGE = "@openclaw/notion";
const VERSION = "1.0.1";

const { gateway, done } = await connectForScript();
try {
  const redirectUrl = flagValue("mcp-config");
  if (redirectUrl) {
    await patchConfig(
      gateway,
      { mcp: { servers: { notion: { url: "https://mcp.notion.com/mcp", transport: "streamable-http", auth: "oauth", oauth: { redirectUrl } } } } },
      { note: "clawdesk: notion probe" },
    );
    console.log(`mcp.servers.notion written, redirect ${redirectUrl}`);
  } else if (!hasFlag("inspect")) {
    const spec = { source: "clawhub", packageName: PACKAGE, version: VERSION };
    let result: { restartRequired?: boolean; plugin?: { id?: string; version?: string } };
    try {
      result = await gateway.request("plugins.install", spec, { timeoutMs: 300_000 });
    } catch (error) {
      const details = (error as { details?: { reviewToken?: string } }).details;
      console.log(`first install: ${(error as Error).message}\n  details: ${short(details ?? null, 1500)}`);
      if (!details?.reviewToken) throw error;
      result = await gateway.request(
        "plugins.install",
        { ...spec, acknowledgeCapabilities: { reviewToken: details.reviewToken }, acknowledgeInstallPolicyWarning: true },
        { timeoutMs: 300_000 },
      );
    }
    console.log(`installed: ${short(result, 1500)}`);
    if (result.restartRequired) {
      const generation = gateway.generation;
      await gateway.request("gateway.restart.request", { reason: "clawdesk: notion probe" }).catch(() => undefined);
      await gateway.waitForReconnect(generation);
      console.log("restarted, reconnected");
    }
  }

  const inspect = await gateway.request("plugins.inspect", { pluginId: "notion" }).catch((e: Error) => ({ error: e.message }));
  console.log(`\nplugins.inspect notion: ${short(inspect, 3000)}`);
  const cfg = await gateway.request<{ config: { mcp?: unknown; plugins?: { entries?: Record<string, unknown> } } }>("config.get", {});
  console.log(`\nconfig.mcp: ${short(cfg.config.mcp ?? null, 2000)}`);
  console.log(`config.plugins.entries.notion: ${short(cfg.config.plugins?.entries?.notion ?? null, 1000)}`);
} finally {
  await done();
}
