import { describe, expect, it } from "vitest";
import { AUDIO_PROFILE, cloudAudioPatch, telegramMediaPatch, type MediaConfig } from "../src/telegram/media-config.js";
import { TELEGRAM_AUDIO_PROVIDERS, TelegramVoiceKeyRequest } from "@clawdesk/shared";

describe("Telegram media defaults", () => {
  it("adds message without replacing the coding profile or granting unrelated tools", () => {
    const patch = telegramMediaPatch({ tools: { alsoAllow: ["web_search"] } });
    expect(patch).toMatchObject({ tools: { alsoAllow: ["web_search", "message"], sandbox: { tools: { alsoAllow: ["message"] } }, message: { crossContext: { allowWithinProvider: false, allowAcrossProviders: false } } } });
    expect(JSON.stringify(patch)).not.toContain('"profile"');
    expect(JSON.stringify(patch)).not.toContain('"full"');
  });

  it("extends an explicit allowlist rather than combining allow and alsoAllow", () => {
    const patch = telegramMediaPatch({ tools: { allow: ["read"], sandbox: { tools: { allow: ["read", "write"] } } } });
    expect(patch).toMatchObject({ tools: { allow: ["read", "message"], sandbox: { tools: { allow: ["read", "write", "message"] } } } });
    expect(JSON.stringify(patch)).not.toContain('"alsoAllow"');
  });

  it("does not remove explicit denials", () => {
    const patch = telegramMediaPatch({ tools: { deny: ["message"], sandbox: { tools: { deny: ["group:messaging"] } } } });
    expect(patch).not.toHaveProperty("tools.alsoAllow");
    expect(patch).not.toHaveProperty("tools.sandbox");
    expect(patch).not.toHaveProperty("tools.deny");
  });

  it("configures cloud audio with its own profile, limits size and preserves image models", () => {
    const image = { provider: "google", model: "vision", capabilities: ["image"] };
    const patch = cloudAudioPatch({ tools: { media: { models: [image] } } }, true);
    expect(patch).toMatchObject({ tools: { media: { models: [{ provider: "openai", model: "gpt-4o-mini-transcribe", profile: AUDIO_PROFILE, capabilities: ["audio"], timeoutSeconds: 90 }, image], audio: { enabled: true, maxBytes: 20971520 } } } });
    expect(patch).not.toHaveProperty("models.providers.openai");
    expect(patch).not.toHaveProperty("auth");
  });

  it("preserves deliberately disabled audio and a custom transcription provider", () => {
    expect(telegramMediaPatch({ tools: { media: { audio: { enabled: false } } } })).not.toHaveProperty("tools.media");
    expect(telegramMediaPatch({ tools: { media: { models: [{ provider: "deepgram", capabilities: ["audio"] }] } } })).not.toHaveProperty("tools.media");
  });

  it("does not patch or restart again after defaults are applied", () => {
    const config = telegramMediaPatch({}) as MediaConfig;
    expect(telegramMediaPatch(config)).toBeNull();
  });

  it("does not accidentally narrow an empty allowlist to messaging only", () => {
    expect(telegramMediaPatch({ tools: { allow: [] } })).toMatchObject({ tools: { allow: null, alsoAllow: ["message"] } });
  });

  it("can disable audio without deleting credentials or model setup", () => {
    expect(cloudAudioPatch({}, false)).toEqual({ tools: { media: { audio: { enabled: false } } } });
    expect(telegramMediaPatch({})).toHaveProperty("tools.media.audio.enabled", false);
  });

  it("accepts Groq keys only with Groq models and keeps OpenAI requests backward compatible", () => {
    expect(TelegramVoiceKeyRequest.safeParse({ apiKey: "gsk_test012345678901234567890", provider: "groq", model: "whisper-large-v3" }).success).toBe(true);
    expect(TelegramVoiceKeyRequest.safeParse({ apiKey: "gsk_test012345678901234567890", provider: "openai" }).success).toBe(false);
    expect(TelegramVoiceKeyRequest.safeParse({ apiKey: "gsk_test012345678901234567890", provider: "groq", model: "gpt-4o-mini-transcribe" }).success).toBe(false);
    expect(TelegramVoiceKeyRequest.parse({ apiKey: "sk-test012345678901234567890" }).provider).toBe("openai");
  });

  it("routes Groq audio exclusively through its endpoint and profile, without retaining the old managed OpenAI fallback", () => {
    const image = { provider: "google", capabilities: ["image"] };
    const patch = cloudAudioPatch({ tools: { media: { models: [{ profile: AUDIO_PROFILE, capabilities: ["audio"] }, image] } } }, true, "groq", "whisper-large-v3");
    expect(patch).toMatchObject({ tools: { media: { models: [{ provider: "groq", profile: TELEGRAM_AUDIO_PROVIDERS.groq.profile, baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3", capabilities: ["audio"] }, image] } } });
    expect(JSON.stringify(patch)).not.toContain("https://api.openai.com");
    expect(patch).not.toHaveProperty("agents");
  });
});
