export const AUDIO_PROFILE = "openai:clawdesk-audio";
export const AUDIO_PROVIDERS = {
  openai: { profile: AUDIO_PROFILE, prefix: "sk-", baseUrl: "https://api.openai.com/v1", models: ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"] },
  groq: { profile: "groq:clawdesk-audio", prefix: "gsk_", baseUrl: "https://api.groq.com/openai/v1", models: ["whisper-large-v3-turbo", "whisper-large-v3"] },
};

export class AudioSetupError extends Error {
  constructor(code, message, status = 400) { super(message); Object.assign(this, { code, status }); }
}

export function audioSettings(apiKey, provider = "openai", model) {
  const selected = Object.hasOwn(AUDIO_PROVIDERS, provider) ? AUDIO_PROVIDERS[provider] : undefined;
  if (!selected || typeof apiKey !== "string" || !/^[A-Za-z0-9_-]{20,1024}$/.test(apiKey) || !apiKey.startsWith(selected.prefix)) throw new AudioSetupError("audio_key_provider_mismatch", "The API key does not match the selected provider.");
  if (model !== undefined && !selected.models.includes(model)) throw new AudioSetupError("audio_model_unavailable", "The selected transcription model is not supported.");
  return { ...selected, provider, model: model ?? selected.models[0] };
}

export async function verifyAudioKey(apiKey, provider, model, fetchImpl = fetch) {
  const selected = audioSettings(apiKey, provider, model);
  let response;
  try {
    response = await fetchImpl(`${selected.baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
  } catch { throw new AudioSetupError("audio_unreachable", "The selected audio provider is unreachable. Try again.", 502); }
  if (response.status === 401 || response.status === 403) throw new AudioSetupError("audio_key_rejected", "The selected provider rejected the API key or its permissions.");
  if (response.status === 429) throw new AudioSetupError("audio_rate_limit", "The provider rate or account limit has been reached.", 429);
  if (!response.ok) throw new AudioSetupError("audio_unreachable", "The selected provider could not validate the key. Try again.", 502);
  let body;
  try { body = await response.json(); } catch { throw new AudioSetupError("audio_unreachable", "The audio provider returned an invalid response.", 502); }
  if (!Array.isArray(body.data) || !body.data.some((item) => item.id === selected.model)) throw new AudioSetupError("audio_model_unavailable", "The selected model is not available for this API key.");
}

export function parseCliJson(out) {
  return JSON.parse(out.slice(out.indexOf("{")));
}

export function normalAuthOrder(order, profiles) {
  const ids = Array.isArray(order) ? order : profiles.map((profile) => profile.id);
  return [...new Set(ids.filter((id) => typeof id === "string" && !Object.values(AUDIO_PROVIDERS).some((provider) => provider.profile === id)))];
}

export async function audioStatus(runCli) {
  const providers = {};
  for (const [id, selected] of Object.entries(AUDIO_PROVIDERS)) {
    const result = await runCli(["models", "auth", "list", "--agent", "main", "--provider", id, "--json"]);
    if (result.code !== 0) throw new Error("could not read speech recognition credentials");
    providers[id] = (parseCliJson(result.out).profiles ?? []).some((profile) => profile.id === selected.profile && profile.type === "api_key");
  }
  return { configured: providers.openai || providers.groq, providers };
}

export async function saveAudioKey(runCli, apiKey, agentIds, provider = "openai", model) {
  const selected = audioSettings(apiKey, provider, model);
  for (const agentId of [...new Set(["main", ...agentIds])]) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(agentId)) throw new Error("invalid agent id");
    const args = ["--agent", agentId, "--provider", provider];
    const profiles = await runCli(["models", "auth", "list", ...args, "--json"]);
    const order = await runCli(["models", "auth", "order", "get", ...args, "--json"]);
    if (profiles.code !== 0 || order.code !== 0) throw new Error("could not preserve the agent's current authentication");
    const existing = normalAuthOrder(parseCliJson(order.out).order, parseCliJson(profiles.out).profiles ?? []);
    // Explicit audio profile selection bypasses this normal inference order; never add the audio key to it.
    if (existing.length) {
      const restored = await runCli(["models", "auth", "order", "set", ...args, ...existing]);
      if (restored.code !== 0) throw new Error("could not restore the agent's authentication order");
    }
    const saved = await runCli(["models", "auth", "paste-api-key", ...args, "--profile-id", selected.profile], { input: `${apiKey}\n` });
    if (saved.code !== 0) throw new Error("could not save the speech recognition API key");
  }
  return { configured: true };
}
