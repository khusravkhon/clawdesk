# File and video implementation discovery

Verified 2026-10-16. Read-only investigation; no runtime configuration or dependencies changed.

## Confirmed OpenClaw 2026.8.1 contract

Installed package: `apps/bff/node_modules/@openclaw/gateway-protocol/package.json`.
Actual package directory: `node_modules/.pnpm/@openclaw+gateway-protocol@2026.8.1/node_modules/@openclaw/gateway-protocol`.

The bundled `dist/worktrees-DGAMd4T8.mjs:5388` defines attachments with `type`,
`mimeType`, `fileName`, `content`, `sizeBytes`, `durationMs`, `width`, `height`.
At line 5418, `chat.send` requires `sessionKey`, `message`, `idempotencyKey`,
and accepts `agentId` and `attachments`. The generated JSON schema has
`ChatSendParams` at line 109723. Attachment contents are permissive in the schema;
server source is required to establish encoding.

The [versioned attachment parser](https://raw.githubusercontent.com/openclaw/openclaw/v2026.8.1/src/gateway/chat-attachments.ts)
confirms `content` is a base64 string (341–362). Non-image inputs use managed
inbound storage (493–524); their references are `media://inbound/<id>`.
OOXML MIME types receive special handling (434–438). Image inputs also have a
separate size ceiling. Exact effective limits must come from the Gateway handshake,
whose policy has optional `attachments.maxBytes` and `maxImageBytes` fields.
Do not infer document comprehension from successful file admission.

Example envelope (bytes omitted here only):

```ts
gateway.request("chat.send", {
  sessionKey: "agent:main:main",
  agentId: "main",
  message: "Summarize the attached document with source references.",
  idempotencyKey,
  attachments: [{ type: "file", mimeType: "application/pdf", fileName: "source.pdf", content: base64 }],
});
```

The [versioned chat handler](https://raw.githubusercontent.com/openclaw/openclaw/v2026.8.1/src/gateway/server-methods/chat-send-handler.ts)
delegates admission to `chat-send-attachments.ts`; that helper was not retrievable
in this investigation. Its sandbox-specific options remain unverified. A live
main-agent and junior-agent attachment probe is still required.

The [versioned PDF tool](https://raw.githubusercontent.com/openclaw/openclaw/v2026.8.1/src/agents/tools/pdf-tool.ts)
exists: `pdf`, `pdfs`, `prompt`, `pages`, `password`, `model`, `maxBytesMb`.
Defaults are 10 MiB and 20 pages; up to ten PDFs. Registration can return null
when model resolution is unavailable. Native Anthropic/Google and extraction
fallback exist. Native mode rejects explicit page selection and passwords;
sandbox mode rejects remote URLs. Scans require an image-capable model if text
extraction yields nothing. Tool registration and effective model must be tested
on the actual installation before promising OCR or full-document coverage.

## Existing deployment constraints

- `deploy/docker-compose.yml` mounts the panel's `/files` read-only. Direct
  Gateway attachments avoid changing this mount or exposing browser-supplied paths.
- `deploy/clawdesk-bridge.mjs` is authenticated on loopback with the Gateway token;
  `apps/bff/src/gateway/bridge-client.ts` is its existing BFF client.
- Managed junior folders are registered in `<state>/clawdesk/folder-sync.json`
  and synchronized to each junior workspace's `folders/<name>`.
- `deploy/sandbox.Dockerfile` installs Python, but no ffmpeg, yt-dlp, Office/PDF
  parsers, or OCR. Gateway image dependency contents have not been inspected.
- Local pnpm inventory includes Gateway client/protocol, but no pdfjs, mammoth,
  exceljs, xlsx, zip/XML parsing dependency suitable for document extraction.
- Existing audio key setup stores dedicated OpenAI/Groq profiles through CLI;
  it does not expose a standalone BFF transcription API.

## Smallest honest implementation slices

1. Panel attachments: validated bounded base64 payload; preserved filename/type;
   forward only supported fields to `chat.send`; keep client idempotency key on
   retries; show staging errors and attachment names in history. Use handshake
   limits and a lower application aggregate request cap. This provides admission,
   not guaranteed Office extraction.
2. Documents: TXT/MD/CSV require bounded UTF-8 decoding. PDF should first use
   built-in tool after live capability verification. DOCX/XLSX need pinned parsers
   or an isolated extraction image; never interpret arbitrary ZIP/XML with regex.
   Return sheet/page locators and explicit truncation/scan/encryption states.
3. Video queue: BFF SQLite stores ownership and durable queued/running/failed/ready
   states; bridge delegates bounded work to a separate child or worker container.
   Originals stay outside the 32 MiB folder synchronization path. Publish only
   extracted text and bounded frame samples into an authorized workspace.
4. Subtitle-first processing: pinned yt-dlp + ffmpeg in worker image; fixed argv,
   no shell interpolation; no cookies by default; one URL/job and no playlists;
   time/output/disk limits and cancellation. Subtitle result must preserve
   timestamps and say that images were not analyzed. Missing subtitles should
   explicitly offer configured audio transcription, not silently claim success.
5. Download and visual inspection are separate job modes. Enforce approved HTTPS
   hosts/redirects and public-network egress at worker level; URL string validation
   alone does not stop downloader redirects or extractor SSRF. Expose only managed
   download IDs, never absolute paths or arbitrary worker arguments.

These are implementation recommendations, not claims that the queued worker,
Office extraction, or video analysis already exists.

## Phase 3: session permissions and serialized config

The exact [2026.8.1 tools types](https://raw.githubusercontent.com/openclaw/openclaw/v2026.8.1/src/config/types.tools.ts)
have global `tools.agentToAgent.enabled/allow` and `tools.sessions.visibility`.
Per-agent `AgentToolsConfig` has tool allow/deny policy but no per-agent sessions
visibility or agent-to-agent destination field. Current upstream documentation
includes newer `tools.agentToAgent.send`; do not copy it into this pinned version.

The versioned [session context implementation](https://raw.githubusercontent.com/openclaw/openclaw/v2026.8.1/src/agents/tools/sessions-helpers.ts)
uses global config for both visibility and agent-to-agent policy. Consequently,
the current `all` policy plus an allowlist containing all permitted juniors does
not enforce a star topology. Denying list/history/search reduces exposure but
does not restrict `sessions_send` to main.

A hook-only fix is insufficient. In versioned
[hooks.ts](https://raw.githubusercontent.com/openclaw/openclaw/v2026.8.1/src/plugins/hooks.ts),
`before_tool_call` supports sticky block results, but handler errors default to
fail-open (300–324). The versioned plugin manifest documentation also says unknown
plugin IDs warn and are ignored; listing the plugin does not require its presence.

A safer supported extension is a custom `clawdesk_ask_main` tool with permanent
denial of juniors' native cross-session tools. The versioned
[tool factory context](https://raw.githubusercontent.com/openclaw/openclaw/v2026.8.1/src/plugins/tool-types.ts)
is trusted and includes optional `agentId`, `sessionKey`, `getRuntimeConfig`.
Missing identity must deny. The plugin's registration factory can return null.
[Plugin API](https://raw.githubusercontent.com/openclaw/openclaw/v2026.8.1/src/plugins/plugin-api.types.ts)
supports `registerTool(factory, options)`. The custom tool must accept only a
bounded question, derive authorization from trusted context and configured
managed-agent grants, and use a fixed main destination. Native tools remain denied
even if the plugin fails to load, so communication fails closed.

The exact [runtime types](https://raw.githubusercontent.com/openclaw/openclaw/v2026.8.1/src/plugins/runtime/types.ts)
support `runtime.gateway.request`, `runtime.subagent.run({sessionKey,message,
idempotencyKey,...})`, `waitForRun({runId,timeoutMs})`, and
`getSessionMessages({sessionKey,limit})`. Run returns a run ID and optional accepted
session key. Prefer a fresh tool-owned main-agent session per request, then return
only its result. Never forward unrelated shared-main session history. Mark the
question as delegated, untrusted input with the trusted requester agent identity.
Availability/authorization of these runtime helpers inside the installed plugin
still needs a live probe. Native harness support and denial of alternative
conversation tools also need validation before claiming the policy complete.

Plugin discovery uses `plugins.load.paths`; each package needs `openclaw.plugin.json`
with a configSchema and an entrypoint in package.json's `openclaw.extensions`.
Ship trusted code outside writable agent workspaces. Do not enable broad
privileges merely to make the plugin load.

Config implementation boundaries:

- Add a per-Gateway `WeakMap` promise queue in `gateway/config-patch.ts`, enclosing
  the complete get/resolve/patch/stale-retry sequence. A rejected operation must
  not poison later operations; different gateways should stay independent.
- Accept a pure patch resolver `(currentConfig) => patch | null`; execute inside
  the queue on every retry, deriving replacePaths from the same fresh snapshot.
  Null means no-op. Preserve static patch callers and exact removal intent.
- Convert create/delete communication allowlist merges, repair policies, folder
  bind removal, and model-follower synchronization to fresh resolvers. A queue
  alone cannot repair patches constructed from a stale snapshot outside it.
- Keep native setup/plugin install operations in mind: they also mutate config
  outside this queue. Hash retry remains necessary. Never retry ambiguous
  post-disconnect writes or non-idempotent side effects blindly.
- Startup currently launches communication, folders, model followers, memory,
  and Telegram media repairs in separate promise chains. Use one ordered repair
  runner with separate logged failures and continue to the next repair. Prioritize
  permission repair, folder registration, follower models, memory, then media;
  each operation that can restart Gateway needs reconnection before the next.

Required regression proof: concurrent array additions preserve both IDs; stale
retry recomputes patch and removals; queue survives errors; deleted agents are
not recreated by deferred repairs; no-op performs no write; validation errors
are not retried; existing Telegram removal tests keep passing. For the custom
tool: unauthorized/missing identities, missing plugin, sibling targets/labels,
and native alternative tools must fail; permitted junior-to-main returns only
the newly generated response; main and company team workflows remain working.
