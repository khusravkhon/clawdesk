// A scheduled run's final reply is delivered by OpenClaw itself (delivery "announce"). When the agent also
// sends the text with the message tool, OpenClaw 2026.8.35 is meant to skip its own delivery, but it compares
// the targets as written: the job's "-100…" + threadId 2 and the tool's "telegram:-100…:topic:2" + "2" differ,
// so the owner got every reminder twice (seen live, 12.11.2026). In a scheduled run the agent therefore does
// not send messages itself; it answers, and the answer is delivered once.

const ID = "clawdesk-schedule-guard";
const CRON_RUN = /^agent:[^:]+:cron:/;

export const BLOCK_REASON = "This is a scheduled run: your final reply is delivered to the chat automatically. Do not send messages yourself — reply with the text only, once.";

export function isScheduledRun(ctx) {
  return ctx?.trigger === "cron" || (typeof ctx?.sessionKey === "string" && CRON_RUN.test(ctx.sessionKey));
}

export function registerScheduleGuard(api) {
  api.on("before_tool_call", (event, ctx) => {
    if (event?.toolName !== "message" || !isScheduledRun(ctx)) return undefined;
    return { block: true, blockReason: BLOCK_REASON };
  });
}

export default { id: ID, name: "ClawDesk Schedule Guard", register: registerScheduleGuard };
