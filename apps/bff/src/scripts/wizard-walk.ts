// Stage 0: walk the Gateway's setup wizard over RPC far enough to see how model
// login is presented (provider choice, API key / OAuth steps), then cancel.
// Nothing is answered with a real secret; text steps are never submitted.
//
//   pnpm --filter @clawdesk/bff wizard-walk [--flow setup|channels] [--max 12]

import { connectForScript, flagValue, short } from "./_cli.js";

type WizardStep = {
  id: string;
  type: "note" | "select" | "text" | "confirm" | "multiselect" | "progress" | "action";
  title?: string;
  message?: string;
  options?: { value: unknown; label: string; hint?: string }[];
  initialValue?: unknown;
  sensitive?: boolean;
  executor?: "gateway" | "client";
  externalUrl?: string;
};
type WizardResult = { sessionId?: string; done: boolean; step?: WizardStep; status?: string; error?: string };

const STOP = Symbol("stop");
let openedMore = false;
const flow = (flagValue("flow") ?? "setup") as "setup" | "channels";
const max = Number(flagValue("max") ?? 12);

const { gateway, done } = await connectForScript();
let sessionId: string | undefined;
try {
  const channel = flagValue("channel");
  let res = await gateway.request<WizardResult>("wizard.start", { mode: "local", flow, ...(channel ? { channel } : {}) });
  sessionId = res.sessionId;
  for (let i = 0; i < max && !res.done && res.step; i++) {
    const step = res.step;
    const options = step.options?.map((o) => `${o.label}${o.hint ? ` (${o.hint})` : ""} = ${JSON.stringify(o.value)}`);
    console.log(
      `\n#${i + 1} [${step.type}${step.sensitive ? ", sensitive" : ""}${step.executor ? `, executor=${step.executor}` : ""}] ${step.title ?? ""}\n` +
        (step.message ? `   ${short(step.message, 500).replace(/\n/g, "\n   ")}\n` : "") +
        (options ? `   options (${options.length}):\n     ${options.slice(0, 60).join("\n     ")}\n` : "") +
        (step.externalUrl ? `   externalUrl: ${step.externalUrl}\n` : ""),
    );
    const answer = autoAnswer(step);
    if (answer === STOP) {
      console.log("→ stopping here (would need real input or would change config)");
      break;
    }
    res = await gateway.request<WizardResult>("wizard.next", { sessionId, answer: { stepId: step.id, ...(answer === undefined ? {} : { value: answer }) } });
    if (res.error) console.log(`   wizard error: ${res.error}`);
  }
  if (res.done) console.log(`\nwizard finished: status=${res.status}`);
} finally {
  if (sessionId) {
    await gateway.request("wizard.cancel", { sessionId }).then(
      () => console.log(`\ncancelled wizard session ${sessionId}`),
      (e: Error) => console.log(`\ncancel failed: ${e.message}`),
    );
  }
  await done();
}

/** Advances through informational steps and the first choices; never fills text or confirms writes. */
function autoAnswer(step: WizardStep): unknown {
  switch (step.type) {
    case "note":
    case "progress":
      return undefined;
    case "select": {
      // Show the provider list, then stop: choosing one leads to credential entry.
      const looksLikeProviders = step.options?.some((o) => /anthropic|openai|deepseek|qwen|moonshot|gemini|ollama/i.test(`${o.label} ${String(o.value)}`));
      if (looksLikeProviders) {
        // With --more, open the full provider list once before stopping.
        const more = step.options?.find((o) => o.value === "__more");
        if (more && process.argv.includes("--more") && !openedMore) {
          openedMore = true;
          return more.value;
        }
        return STOP;
      }
      return step.initialValue ?? step.options?.[0]?.value;
    }
    case "confirm":
      // Risk acknowledgement in setup is informational; any other confirm stops the walk.
      return /risk|understand|security/i.test(`${step.title} ${step.message}`) ? true : STOP;
    default:
      return STOP;
  }
}
