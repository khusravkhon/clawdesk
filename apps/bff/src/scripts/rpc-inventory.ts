// Stage 0: which RPCs does the live Gateway advertise for each panel screen,
// and can model login / plugin OAuth be done over RPC (the main project risk)?
//
//   pnpm --filter @clawdesk/bff rpc-inventory            read-only probes
//   pnpm --filter @clawdesk/bff rpc-inventory --wizard   also open the setup wizard, print its first step, cancel it

import { connectForScript, hasFlag, short } from "./_cli.js";

const SCREENS: Record<string, string[]> = {
  "1 first run": ["status", "health"],
  "3 connect model": ["wizard.start", "wizard.next", "secrets.store.set", "models.list", "models.authStatus", "models.probe", "config.patch"],
  "4 main agent": ["agents.create", "agents.update", "agents.files.set"],
  "5 data sources": ["plugins.list", "plugins.install", "plugins.setEnabled", "tools.github.authorize.start", "wizard.start"],
  "6 telegram": ["config.patch", "channels.status", "channels.pairing.list", "channels.pairing.approve"],
  "7 my agents": ["agents.list", "sessions.list", "cron.list"],
  "8 agent builder": ["agents.create", "agents.files.set", "config.patch", "cron.add", "agents.delete"],
  "9 chat": ["chat.send", "chat.history", "sessions.messages.subscribe", "agent", "agent.wait"],
  "10 schedules": ["cron.list", "cron.add", "cron.update", "cron.remove", "cron.run"],
  "12 approvals": ["exec.approval.list", "exec.approval.resolve", "plugin.approval.list", "plugin.approval.resolve"],
  "13 usage": ["sessions.usage", "usage.status", "usage.cost"],
  "14 settings & audit": ["config.get", "audit.list", "update.status", "update.run"],
};

const READ_PROBES: [string, unknown][] = [
  ["models.authStatus", {}],
  ["models.list", { view: "configured" }],
  ["channels.status", {}],
  ["cron.status", {}],
  ["plugins.list", {}],
  ["config.schema.lookup", { path: "agents.entries" }],
  ["config.schema.lookup", { path: "agents.defaults.sandbox" }],
  ["config.schema.lookup", { path: "tools.agentToAgent" }],
  ["config.schema.lookup", { path: "channels.telegram" }],
  ["config.schema.lookup", { path: "bindings" }],
];

const { gateway, done } = await connectForScript();
try {
  const advertised = new Set(gateway.hello?.features.methods ?? []);
  console.log(`\nAdvertised methods: ${advertised.size}. Events: ${gateway.hello?.features.events.length ?? 0}.`);
  console.log("(Not advertised ≠ missing: discovery is conservative. Missing ones are probed below where safe.)\n");
  for (const [screen, methods] of Object.entries(SCREENS)) {
    const marks = methods.map((m) => `${advertised.has(m) ? "✓" : "·"} ${m}`);
    console.log(`Screen ${screen}:\n  ${marks.join("\n  ")}`);
  }

  console.log("\n--- read-only probes ---");
  for (const [method, params] of READ_PROBES) {
    try {
      const result = await gateway.request(method, params);
      console.log(`\n✓ ${method} ${JSON.stringify(params)}\n${short(result, 1500)}`);
    } catch (error) {
      console.log(`\n✗ ${method} ${JSON.stringify(params)}: ${(error as Error).message}`);
    }
  }

  if (hasFlag("wizard")) {
    console.log("\n--- setup wizard over RPC ---");
    for (const flow of ["setup", "channels"] as const) {
      try {
        const start = await gateway.request<{ sessionId: string; done: boolean; step?: unknown }>("wizard.start", { mode: "local", flow });
        console.log(`\n✓ wizard.start flow=${flow}: session ${start.sessionId}, done=${start.done}\nfirst step:\n${short(start.step, 2000)}`);
        await gateway.request("wizard.cancel", { sessionId: start.sessionId }).catch((e: Error) => console.log(`  (cancel failed: ${e.message})`));
      } catch (error) {
        console.log(`\n✗ wizard.start flow=${flow}: ${(error as Error).message}`);
      }
    }
  }
} finally {
  await done();
}
