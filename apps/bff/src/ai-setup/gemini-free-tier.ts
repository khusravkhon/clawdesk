import type { Logger } from "pino";
import type { GatewayService } from "../gateway/gateway-service.js";

// Google AI Studio keys on the free tier have no quota for Pro models, but
// OpenClaw's key check always probes the provider's default (a Pro preview),
// so a perfectly good free key fails with 429. For the main agent we then pick
// a Flash model this key can use and store key + model through the Gateway's
// own setup wizard, which (unlike openclaw.setup.activate) lets the model be chosen.

const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";
const NOT_CHAT = /lite|image|tts|live|audio|embedding|vision|exp|thinking|native|computer/i;

/** Picks the newest general Flash chat model; stable versions win over previews. */
export function selectFlashModel(models: { name: string; supportedGenerationMethods?: string[] }[]): string | null {
  const candidates = models
    .map((m) => ({ id: m.name.replace(/^models\//, ""), methods: m.supportedGenerationMethods ?? [] }))
    .filter((m) => /^gemini-[\d.]+-flash(-preview(-[\w-]+)?)?$/.test(m.id) && !NOT_CHAT.test(m.id) && m.methods.includes("generateContent"))
    .map((m) => ({ id: m.id, version: Number.parseFloat(m.id.split("-")[1] ?? "0"), preview: m.id.includes("preview") }));
  candidates.sort((a, b) => Number(a.preview) - Number(b.preview) || b.version - a.version);
  return candidates[0]?.id ?? null;
}

export async function findFlashModel(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(MODELS_URL, { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    return selectFlashModel(body.models ?? []);
  } catch {
    return null;
  }
}

type Step = { id: string; type: string; title?: string; message?: string; options?: { value: unknown }[]; sensitive?: boolean };
type WizardResult = { sessionId?: string; done: boolean; step?: Step; error?: string };

/**
 * Drives the Gateway setup wizard just far enough to store the key and choose
 * the model, then cancels (the wizard persists both at the model step). Main agent only:
 * the wizard has no agent parameter.
 */
export async function storeKeyWithModelViaWizard(
  gateway: GatewayService,
  logger: Logger,
  params: { provider: string; apiKey: string; modelRef: string },
): Promise<void> {
  let res = await gateway.request<WizardResult>("wizard.start", { mode: "local", flow: "setup" });
  const sessionId = res.sessionId!;
  let manualModelChosen = false;
  try {
    for (let i = 0; i < 30; i++) {
      if (res.done || !res.step) throw new Error(res.error ?? "setup wizard ended before the model step");
      const step = res.step;
      const text = `${step.title ?? ""} ${step.message ?? ""}`;
      const has = (value: unknown) => step.options?.some((o) => o.value === value) ?? false;
      let value: unknown;
      if (step.type === "note" || step.type === "progress" || step.type === "action") value = undefined;
      else if (step.type === "confirm") value = true;
      else if (step.type === "select" && has("quickstart")) value = "quickstart";
      else if (step.type === "select" && has(params.provider)) value = params.provider;
      else if (step.type === "select" && has("__manual__")) {
        value = "__manual__";
        manualModelChosen = true;
      } else if (step.type === "select" && has("plaintext")) value = "plaintext";
      else if (step.type === "select" && has(false) && has(true)) value = false; // optional telemetry
      else if (step.type === "text" && step.sensitive) value = params.apiKey;
      else if (step.type === "text" && manualModelChosen && /model/i.test(text)) {
        await gateway.request("wizard.next", { sessionId, answer: { stepId: step.id, value: params.modelRef } }, { timeoutMs: 120_000 });
        logger.info({ modelRef: params.modelRef }, "stored key and model through the setup wizard");
        return;
      } else throw new Error(`unexpected setup wizard step: ${step.type} ${text.slice(0, 80)}`);
      res = await gateway.request<WizardResult>("wizard.next", { sessionId, answer: { stepId: step.id, ...(value === undefined ? {} : { value }) } }, { timeoutMs: 120_000 });
    }
    throw new Error("setup wizard did not reach the model step");
  } finally {
    await gateway.request("wizard.cancel", { sessionId }).catch(() => undefined);
  }
}
