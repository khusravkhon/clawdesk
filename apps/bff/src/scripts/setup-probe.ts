// Stage 0: what does the Gateway's AI-access setup API offer for one agent?
// openclaw.setup.detect is read-only: it lists ready candidates, API-key
// providers, and OAuth / device-code (subscription) sign-in options.
//
//   pnpm --filter @clawdesk/bff setup-probe [--agent main]

import { connectForScript, flagValue, short } from "./_cli.js";

type DetectResult = {
  candidates: { kind: string; label: string; detail: string; modelRef: string; recommended: boolean; credentials?: boolean }[];
  unavailableCandidates?: { id: string; label: string; reason: string; authOptionId?: string; manualProviderId?: string }[];
  manualProviders: { id: string; label: string; groupLabel?: string; hint?: string; website?: string; icon?: string }[];
  authOptions?: { id: string; label: string; hint?: string; kind: "oauth" | "device-code"; featured: boolean }[];
  prepareOptions?: { id: string; label: string; hint?: string }[];
  workspace: string;
  configuredModel?: string;
  setupComplete: boolean;
};

const agentId = flagValue("agent") ?? "main";
const { gateway, done } = await connectForScript();
try {
  const t0 = performance.now();
  const res = await gateway.request<DetectResult>("openclaw.setup.detect", { agentId }, { timeoutMs: 60_000 });
  console.log(`openclaw.setup.detect {agentId:"${agentId}"} in ${Math.round(performance.now() - t0)}ms`);
  console.log(`setupComplete=${res.setupComplete} configuredModel=${res.configuredModel ?? "-"} workspace=${res.workspace}`);
  console.log(`\nready candidates (${res.candidates.length}):`);
  for (const c of res.candidates) console.log(`  ${c.recommended ? "★" : " "} [${c.kind}] ${c.label} → ${c.modelRef} — ${c.detail}`);
  console.log(`\nunavailable (${res.unavailableCandidates?.length ?? 0}):`);
  for (const u of res.unavailableCandidates ?? []) console.log(`  ${u.id}: ${u.label} — ${u.reason}${u.authOptionId ? ` (auth: ${u.authOptionId})` : ""}`);
  console.log(`\nAPI-key providers (${res.manualProviders.length}):`);
  console.log(`  ${res.manualProviders.map((p) => `${p.id}${p.groupLabel ? `[${p.groupLabel}]` : ""}`).join(", ")}`);
  console.log(`  sample: ${short(res.manualProviders.slice(0, 2), 600)}`);
  console.log(`\nsign-in (subscription/OAuth) options (${res.authOptions?.length ?? 0}):`);
  for (const a of res.authOptions ?? []) console.log(`  ${a.featured ? "★" : " "} [${a.kind}] ${a.id}: ${a.label}${a.hint ? ` — ${a.hint}` : ""}`);
  console.log(`\nprepare options: ${short(res.prepareOptions ?? [], 800)}`);
} finally {
  await done();
}
