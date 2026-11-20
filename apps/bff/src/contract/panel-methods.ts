// Every Gateway RPC the panel calls. The contract test checks each one is in the live Gateway's
// hello.features.methods; test/panel-methods.test.ts keeps this list in step with the source.

export const PANEL_METHODS = [
  "agents.create", "agents.delete", "agents.files.get", "agents.files.set", "agents.list", "agents.update",
  "approval.history", "audit.list",
  "channels.pairing.approve", "channels.pairing.list", "channels.status",
  "chat.abort", "chat.history", "chat.send",
  "config.get", "config.patch",
  "cron.add", "cron.list", "cron.remove", "cron.run", "cron.runs", "cron.update",
  "exec.approval.list", "exec.approvals.get", "exec.approvals.set", "plugin.approval.list",
  // Named in a ternary (approvals-service.ts) or returned by telegramSendRequest, not as a literal call.
  "exec.approval.resolve", "plugin.approval.resolve", "message.action",
  "gateway.restart.request",
  "models.authLogout", "models.authStatus", "models.list",
  "openclaw.setup.activate", "openclaw.setup.auth.start", "openclaw.setup.detect", "openclaw.setup.verify",
  "plugins.install", "plugins.list", "plugins.setEnabled",
  "secrets.store.delete", "secrets.store.set",
  "send",
  "sessions.create", "sessions.list", "sessions.usage",
  "skills.install", "skills.search", "skills.status", "skills.upload.begin", "skills.upload.chunk", "skills.upload.commit",
  "tools.github.authorize.poll", "tools.github.authorize.start", "tools.github.configure", "tools.github.status",
  "wizard.cancel", "wizard.next", "wizard.start",
] as const;
