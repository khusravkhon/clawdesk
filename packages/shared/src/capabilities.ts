// P0: what this installation can actually do, checked now. Each capability is a fact about this machine
// (a tool answers, a setting is on, an account is bound), not a promise; the interface explains what each
// one enables and what is limited without it. The written matrix of what was verified live, by tests only
// or not at all is docs/company-mode.md ("На что опирается панель в OpenClaw").

export type CapabilityId = "gateway" | "openclaw" | "company_mode" | "model" | "sandbox" | "docker" | "requests_plugin" | "telegram" | "google" | "git";
/** ok — present and working; off — present but switched off; missing — not there; unknown — could not be checked now. */
export type CapabilityState = "ok" | "off" | "missing" | "unknown";
export type CapabilityDto = { id: CapabilityId; state: CapabilityState; value: string | null };
export type CapabilitiesDto = { checkedAt: number; items: CapabilityDto[] };
