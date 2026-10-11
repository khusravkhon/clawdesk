// Stage 0: which provider plugins are installed / installable, and how.
//
//   pnpm --filter @clawdesk/bff plugins-probe [--match deepseek,qwen,moonshot,zai]

import { connectForScript, flagValue, short } from "./_cli.js";

type Plugin = { id: string; name?: string; packageName?: string; origin?: string; installed?: boolean; enabled?: boolean; state?: string; install?: unknown; kind?: string; tags?: string[] };

const match = (flagValue("match") ?? "deepseek,qwen,moonshot,kimi,zai,glm,minimax,volcengine,qianfan,tencent,stepfun,xiaomi,anthropic,openai")
  .split(",")
  .map((s) => s.trim().toLowerCase());

const { gateway, done } = await connectForScript();
try {
  const res = await gateway.request<{ plugins: Plugin[] }>("plugins.list", {});
  console.log(`plugins.list: ${res.plugins.length} entries`);
  const hits = res.plugins.filter((p) => match.some((m) => `${p.id} ${p.name ?? ""} ${p.packageName ?? ""}`.toLowerCase().includes(m)));
  for (const p of hits) {
    console.log(`  ${p.installed ? "■" : "□"} ${p.id} (${p.packageName ?? "-"}) origin=${p.origin ?? "-"} state=${p.state ?? "-"} install=${short(p.install ?? null, 160)}`);
  }
  const keys = Object.keys(res.plugins[0] ?? {});
  console.log(`\nentry fields: ${keys.join(", ")}`);
} finally {
  await done();
}
