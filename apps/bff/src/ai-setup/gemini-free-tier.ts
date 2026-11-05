import type { Logger } from "pino";
import type { GatewayService } from "../gateway/gateway-service.js";

// Google AI Studio keys on the free tier have no quota for Pro models, but
// OpenClaw's key check always probes the provider's default (a Pro preview),
// so a perfectly good free key fails with 429. For the main agent we then pick
// a Flash model this key can use and store key + model through the Gateway's
// own setup wizard, which (unlike openclaw.setup.activate) lets the model be chosen.

const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";
const NOT_CHAT = /lite|image|tts|live|audio|embedding|vision|exp|thinking|native|computer/i;

/**
 * General Flash chat models this key can use, best first (stable before preview, newer first).
 * Google can be ahead of the pinned OpenClaw catalog, so callers try them in order.
 */
export function selectFlashModels(models: { name: string; supportedGenerationMethods?: string[] }[]): string[] {
  const candidates = models
    .map((m) => ({ id: m.name.replace(/^models\//, ""), methods: m.supportedGenerationMethods ?? [] }))
    .filter((m) => /^gemini-[\d.]+-flash(-preview(-[\w-]+)?)?$/.test(m.id) && !NOT_CHAT.test(m.id) && m.methods.includes("generateContent"))
    .map((m) => ({ id: m.id, version: Number.parseFloat(m.id.split("-")[1] ?? "0"), preview: m.id.includes("preview") }));
  candidates.sort((a, b) => Number(a.preview) - Number(b.preview) || b.version - a.version);
  return candidates.map((c) => c.id);
}

export function selectFlashModel(models: { name: string; supportedGenerationMethods?: string[] }[]): string | null {
  return selectFlashModels(models)[0] ?? null;
}

export async function findFlashModels(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  try {
    const res = await fetchImpl(MODELS_URL, { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    return selectFlashModels(body.models ?? []);
  } catch {
    return [];
  }
}

const GEMINI_KEY_CHOICE = "gemini-api-key";

type Step = { id: string; type: string; title?: string; message?: string; options?: { value: unknown }[]; sensitive?: boolean };
type WizardResult = { sessionId?: string; done: boolean; step?: Step; error?: string };

/** Steps through notes after the model step and declines the wizard's live test; stops at anything else. */
async function answerLiveTestOffer(gateway: GatewayService, sessionId: string, res: WizardResult): Promise<WizardResult> {
  for (let i = 0; i < 5 && !res.done && res.step; i++) {
    const step = res.step;
    const text = `${step.title ?? ""} ${step.message ?? ""}`;
    if (step.type === "confirm" && /test/i.test(text)) {
      return gateway.request<WizardResult>("wizard.next", { sessionId, answer: { stepId: step.id, value: false } }, { timeoutMs: 120_000 });
    }
    if (step.type !== "note" && step.type !== "progress") break;
    res = await gateway.request<WizardResult>("wizard.next", { sessionId, answer: { stepId: step.id } }, { timeoutMs: 120_000 });
  }
  return res;
}

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
      // Asked when Google is already configured (e.g. left over from an earlier attempt): enter the new key.
      else if (step.type === "select" && has(GEMINI_KEY_CHOICE)) value = GEMINI_KEY_CHOICE;
      else if (step.type === "select" && has("__manual__")) {
        value = "__manual__";
        manualModelChosen = true;
      } else if (step.type === "select" && has("plaintext")) value = "plaintext";
      else if (step.type === "select" && has(false) && has(true)) value = false; // optional telemetry
      else if (step.type === "text" && step.sensitive) value = params.apiKey;
      else if (step.type === "text" && manualModelChosen && /model/i.test(text)) {
        res = await gateway.request<WizardResult>("wizard.next", { sessionId, answer: { stepId: step.id, value: params.modelRef } }, { timeoutMs: 120_000 });
        // openclaw-bump-review: OpenClaw 2026.8.1 writes key + model only once the next step (the offer of a
        // live test) is answered; cancelling right after the model step left nothing behind. The caller
        // verifies the model itself, so the wizard's own test is declined.
        res = await answerLiveTestOffer(gateway, sessionId, res);
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
