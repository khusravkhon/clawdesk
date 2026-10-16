<script setup lang="ts">
// Chat with an agent (screen 9): its main session, replies streamed live.
import type { AgentListItemDto, ChatAttachmentInput, ChatAttachmentLimitsDto, ChatAttachmentReadDto, ChatMessageDto, ChatRunPhase, ChatStreamEvent } from "@clawdesk/shared";
import type { VideoJobDto } from "@clawdesk/shared";
import { CHAT_ATTACHMENT_ACCEPT, isVideoUrl } from "@clawdesk/shared";
import { AlertCircle, ArrowUp, CircleSlash, Film, Paperclip, Square, Wrench, X } from "@lucide/vue";
import MarkdownIt from "markdown-it";
import { NButton, NSelect, NSpin, useMessage } from "naive-ui";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "../api/client";
import ApprovalCard from "../components/ApprovalCard.vue";
import { formatBytes, intlLocale } from "../format";
import { modelErrorHint } from "../model-errors";
import { useApprovalsStore } from "../stores/approvals";

const { t, locale } = useI18n();
const message = useMessage();
const route = useRoute();
const router = useRouter();

// The model's text is untrusted: no raw HTML, links open in a new tab.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("target", "_blank");
  tokens[idx]!.attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

const agents = ref<AgentListItemDto[]>([]);
const agentId = computed(() => (route.params.agentId as string | undefined) || "main");
const agent = computed(() => agents.value.find((a) => a.id === agentId.value) ?? null);
const agentOptions = computed(() => agents.value.map((a) => ({ value: a.id, label: `${a.emoji ?? (a.role === "main" ? "🧭" : "🤖")}  ${displayName(a)}` })));
const displayName = (a: AgentListItemDto) => (a.role === "main" && a.name === a.id ? t("agents.main") : a.name);

const approvals = useApprovalsStore();
// Commands this agent is waiting on, answered right here in the chat.
const waiting = computed(() =>
  approvals.pending.filter((p) => p.sessionKey === `agent:${agentId.value}:main` || (!p.sessionKey && p.agentId === agentId.value)),
);

const messages = ref<ChatMessageDto[]>([]);
const loading = ref(true);
const draft = ref("");
const sending = ref(false);

// The turn in progress.
const running = ref(false);
const phase = ref<ChatRunPhase>("preparing");
const liveText = ref("");
const liveTools = ref<string[]>([]);
const startedAt = ref<number | null>(null);
/** Why the last turn failed, from its error event (the transcript keeps only a placeholder). */
const lastFailure = ref<string | null>(null);
const lastErrorId = computed(() => {
  const last = messages.value.findLast((m) => m.role === "assistant");
  return last?.status === "error" ? last.id : null;
});
const now = ref(Date.now());
const slow = computed(() => running.value && !liveText.value && startedAt.value !== null && now.value - startedAt.value > 20_000);

const scroller = ref<HTMLElement | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);
const picker = ref<HTMLInputElement | null>(null);

// Files staged for the next message: read in the browser, sent with chat.send, never stored by the panel.
type StagedFile = ChatAttachmentInput & { id: string };
const staged = ref<StagedFile[]>([]);
const limits = ref<ChatAttachmentLimitsDto | null>(null);
const stagedBytes = computed(() => staged.value.reduce((sum, file) => sum + file.sizeBytes, 0));
const supported = CHAT_ATTACHMENT_ACCEPT.split(",");

const bytes = (value: number) => formatBytes(value, locale.value);

async function toBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // In chunks: one spread of a whole file would overflow the argument list.
  for (let i = 0; i < buffer.length; i += 8192) binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
  return btoa(binary);
}

async function pick(event: Event): Promise<void> {
  const target = event.target as HTMLInputElement;
  const files = [...(target.files ?? [])];
  target.value = ""; // picking the same file again must count as a new choice
  const max = limits.value;
  for (const file of files) {
    if (max && staged.value.length >= max.maxFiles) {
      message.error(t("chat.attach.tooMany", { count: max.maxFiles }));
      break;
    }
    const type = file.type as ChatAttachmentInput["mimeType"];
    if (!supported.includes(type)) {
      message.error(t("chat.attach.unsupported", { name: file.name }));
      continue;
    }
    const limit = max ? (type.startsWith("image/") ? max.maxImageBytes : max.maxFileBytes) : Infinity;
    if (file.size > limit) {
      message.error(t("chat.attach.tooLarge", { name: file.name, limit: bytes(limit) }));
      continue;
    }
    if (max && stagedBytes.value + file.size > max.maxTotalBytes) {
      message.error(t("chat.attach.tooMuch", { limit: bytes(max.maxTotalBytes) }));
      break;
    }
    try {
      const content = await toBase64(file);
      staged.value.push({ id: [file.name, file.size, Date.now()].join("-"), fileName: file.name, mimeType: type, sizeBytes: file.size, content });
    } catch {
      message.error(t("chat.attach.readFailed", { name: file.name }));
    }
  }
}

const unstage = (id: string) => (staged.value = staged.value.filter((file) => file.id !== id));

// A video link in the composer: the panel can study it instead of sending the link as text.
// Studying happens in a worker outside the panel, so a job has its own state and can be stopped.
const videoJobs = ref<VideoJobDto[]>([]);
const speechConfigured = ref(true);
const studying = ref(false);
const videoLink = computed(() => (isVideoUrl(draft.value.trim()) ? draft.value.trim() : null));
const agentVideoJobs = computed(() => videoJobs.value.filter((job) => job.agentId === agentId.value).slice(0, 5));

async function loadVideoJobs(): Promise<void> {
  try {
    const result = await api.video.jobs();
    videoJobs.value = result.jobs;
    speechConfigured.value = result.speechConfigured;
  } catch {
    // The list is a convenience; a failure here must not break the chat.
  }
}

async function studyVideo(): Promise<void> {
  const url = videoLink.value;
  if (!url || studying.value) return;
  studying.value = true;
  try {
    const job = await api.video.study(agentId.value, url);
    videoJobs.value = [job, ...videoJobs.value];
    draft.value = "";
  } catch (e) {
    message.error(e instanceof ApiError ? e.body.message : String(e));
  } finally {
    studying.value = false;
  }
}

async function cancelVideo(id: string): Promise<void> {
  try {
    const job = await api.video.cancel(id);
    videoJobs.value = videoJobs.value.map((item) => (item.id === job.id ? job : item));
  } catch (e) {
    message.error(e instanceof ApiError ? e.body.message : String(e));
  }
}

/** One line per job: its state, and for a failure the reason the worker reported. */
const videoLine = (job: VideoJobDto): string =>
  job.state === "failed" && job.error ? t("chat.video.error." + job.error) : t("chat.video.state." + job.state);

// What the panel itself read out of the files of the last message, shown under that turn.
const reads = ref<ChatAttachmentReadDto[]>([]);

/** One line per file: the state, and the numbers that state rests on. */
function readLine(read: ChatAttachmentReadDto): string {
  const facts = [
    read.pages !== null ? t("chat.read.pages", { pages: read.pages, read: read.readPages ?? read.pages }) : null,
    read.sheets !== null ? t("chat.read.sheets", { count: read.sheets }) : null,
    read.slides !== null ? t("chat.read.slides", { count: read.slides }) : null,
    read.encoding && read.encoding !== "utf-8" ? t("chat.read.encoding", { encoding: read.encoding }) : null,
  ].filter(Boolean);
  const state = t("chat.read.state." + read.state);
  return facts.length ? state + " · " + facts.join(" · ") : state;
}

function scrollDown(): void {
  void nextTick(() => scroller.value?.scrollTo({ top: scroller.value.scrollHeight }));
}

async function loadHistory(): Promise<void> {
  const before = messages.value.length;
  try {
    const h = await api.chat.history(agentId.value);
    messages.value = h.messages;
    limits.value = h.attachments;
    if (h.messages.length !== before) scrollDown();
    if (h.running && !running.value) startRun();
    // The Gateway does not always send a closing chat event (e.g. every model failed before replying);
    // the transcript is the source of truth once the turn has had a moment to register.
    if (!h.running && running.value && !sending.value && startedAt.value !== null && Date.now() - startedAt.value > 3_000) endRun();
  } catch (e) {
    message.error(e instanceof ApiError ? e.body.message : String(e));
  } finally {
    if (loading.value) scrollDown();
    loading.value = false;
  }
}

function startRun(): void {
  running.value = true;
  phase.value = "preparing";
  liveText.value = "";
  liveTools.value = [];
  startedAt.value = Date.now();
}

function endRun(): void {
  running.value = false;
  liveText.value = "";
  liveTools.value = [];
  startedAt.value = null;
}

let events: EventSource | null = null;
function connect(): void {
  events?.close();
  events = new EventSource(api.chat.eventsUrl(agentId.value));
  events.onmessage = (e) => onEvent(JSON.parse(e.data) as ChatStreamEvent);
}

async function onEvent(ev: ChatStreamEvent): Promise<void> {
  if (!running.value && ev.type !== "final" && ev.type !== "error" && ev.type !== "aborted") startRun();
  switch (ev.type) {
    case "status":
      phase.value = ev.phase;
      break;
    case "tool":
      phase.value = "tool";
      liveTools.value.push(ev.name);
      break;
    case "delta":
      phase.value = "writing";
      liveText.value = ev.replace ? ev.text : liveText.value + ev.text;
      break;
    case "error":
      lastFailure.value = ev.message;
      await loadHistory();
      endRun();
      break;
    case "final":
    case "aborted":
      await loadHistory();
      endRun();
      break;
  }
  scrollDown();
}

/** A rejected file comes back as a reason code; the panel writes that reason in the owner's language. */
function attachmentError(error: ApiError): string {
  const details = error.body.details as { code?: string; fileName?: string; limit?: number } | undefined;
  if (error.body.error !== "attachment_rejected" || !details?.code) return error.body.message;
  const name = details.fileName ?? "";
  const limit = details.limit ? bytes(details.limit) : "";
  switch (details.code) {
    case "too_many_files":
      return t("chat.attach.tooMany", { count: details.limit ?? 0 });
    case "unsupported_type":
      return t("chat.attach.unsupported", { name });
    case "file_too_large":
    case "image_too_large":
      return t("chat.attach.tooLarge", { name, limit });
    case "request_too_large":
      return t("chat.attach.tooMuch", { limit });
    default:
      return t("chat.attach.rejected", { name });
  }
}

async function send(text = draft.value): Promise<void> {
  const body = text.trim();
  const files = staged.value;
  if ((!body && !files.length) || sending.value) return;
  sending.value = true;
  draft.value = "";
  staged.value = [];
  lastFailure.value = null;
  const localId = "local-" + Date.now();
  messages.value.push({
    id: localId,
    role: "user",
    text: body,
    tools: [],
    attachments: files.map(({ fileName, mimeType, sizeBytes }) => ({ fileName, mimeType, sizeBytes })),
    at: Date.now(),
    status: "ok",
  });
  reads.value = [];
  startRun();
  scrollDown();
  try {
    const result = await api.chat.send(
      agentId.value,
      body,
      files.map(({ id: _id, ...file }) => file),
    );
    reads.value = result.reads;
    scrollDown();
  } catch (e) {
    endRun();
    message.error(e instanceof ApiError ? attachmentError(e) : String(e));
    // Nothing was sent: the draft and its files go back to the composer.
    draft.value = body;
    staged.value = files;
    messages.value = messages.value.filter((m) => m.id !== localId);
  } finally {
    sending.value = false;
    void nextTick(() => input.value?.focus());
  }
}

async function stop(): Promise<void> {
  try {
    await api.chat.abort(agentId.value);
  } catch (e) {
    message.error(e instanceof ApiError ? e.body.message : String(e));
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send();
  }
}

// Textarea grows with its text, up to a limit.
watch(draft, () =>
  nextTick(() => {
    const el = input.value;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }),
);

const suggestions = computed(() => [t("chat.suggest.what"), t("chat.suggest.files"), t("chat.suggest.plan")]);
const time = (ms: number | null) => (ms ? new Intl.DateTimeFormat(intlLocale(locale.value), { hour: "2-digit", minute: "2-digit" }).format(ms) : "");

let clock: ReturnType<typeof setInterval> | undefined;
let poll: ReturnType<typeof setInterval> | undefined;
async function open(): Promise<void> {
  loading.value = true;
  messages.value = [];
  endRun();
  connect();
  await loadHistory();
}

onMounted(async () => {
  clock = setInterval(() => (now.value = Date.now()), 1000);
  poll = setInterval(() => {
    if (running.value) void loadHistory();
    // A video is studied outside the panel: its state changes without any chat event.
    if (videoJobs.value.some((job) => job.state === "queued" || job.state === "running")) void loadVideoJobs();
  }, 4_000);
  void loadVideoJobs();
  try {
    agents.value = (await api.agents()).agents;
  } catch {
    // the picker stays empty; the chat itself still works for main
  }
  await open();
});
onBeforeUnmount(() => {
  events?.close();
  clearInterval(clock);
  clearInterval(poll);
});
watch(agentId, () => void open());
</script>

<template>
  <div class="chat">
    <header class="bar">
      <n-select
        :value="agentId"
        :options="agentOptions"
        size="small"
        class="picker"
        :consistent-menu-width="false"
        @update:value="(id: string) => router.push({ name: 'chat', params: { agentId: id === 'main' ? undefined : id } })"
      />
      <span v-if="agent?.model" class="model">{{ agent.model }}</span>
    </header>

    <div ref="scroller" class="scroll">
      <div class="thread">
        <n-spin v-if="loading" class="center" />

        <div v-else-if="!messages.length && !running" class="empty">
          <div class="empty-avatar">{{ agent?.emoji ?? "🧭" }}</div>
          <h2>{{ t("chat.emptyTitle", { name: agent ? displayName(agent) : t("agents.main") }) }}</h2>
          <p>{{ t("chat.emptyLead") }}</p>
          <div class="chips">
            <button v-for="s in suggestions" :key="s" class="chip" type="button" @click="send(s)">{{ s }}</button>
          </div>
        </div>

        <template v-for="m in messages" :key="m.id">
          <div v-if="m.role === 'user'" class="row user">
            <div class="bubble">
              <span v-if="m.text">{{ m.text }}</span>
              <div v-if="m.attachments.length" class="files">
                <span v-for="file in m.attachments" :key="file.fileName" class="file">
                  <paperclip :size="12" /> {{ file.fileName }}<template v-if="file.sizeBytes"> · {{ bytes(file.sizeBytes) }}</template>
                </span>
              </div>
            </div>
          </div>
          <div v-else class="row assistant">
            <div class="avatar">{{ agent?.emoji ?? "🧭" }}</div>
            <div class="body">
              <div v-if="m.tools.length" class="tools">
                <span v-for="(tool, i) in m.tools" :key="i" class="tool"><wrench :size="12" /> {{ tool }}</span>
              </div>
              <div v-if="m.status === 'error'" class="notice error">
                <alert-circle :size="15" />
                <span>{{ t("chat.failed") }}<template v-if="m.id === lastErrorId && lastFailure"> {{ modelErrorHint(t, lastFailure) }}</template></span>
              </div>
              <div v-else-if="m.status === 'aborted' && !m.text" class="notice"><circle-slash :size="15" /> {{ t("chat.stopped") }}</div>
              <!-- eslint-disable-next-line vue/no-v-html -- rendered with html disabled -->
              <div v-if="m.text" class="md" v-html="md.render(m.text)" />
              <div class="meta">{{ time(m.at) }}</div>
            </div>
          </div>
        </template>

        <div v-if="running || waiting.length" class="row assistant">
          <div class="avatar">{{ agent?.emoji ?? "🧭" }}</div>
          <div class="body">
            <div v-if="liveTools.length" class="tools">
              <span v-for="(tool, i) in liveTools" :key="i" class="tool"><wrench :size="12" /> {{ tool }}</span>
            </div>
            <!-- eslint-disable-next-line vue/no-v-html -- rendered with html disabled -->
            <div v-if="liveText" class="md" v-html="md.render(liveText)" />
            <div v-else-if="!waiting.length" class="typing">
              <span class="dots"><i /><i /><i /></span>
              {{ t(`chat.phase.${phase}`) }}
            </div>
            <div v-if="waiting.length" class="approvals">
              <approval-card v-for="a in waiting" :key="a.id" :approval="a" :agent-name="agent ? displayName(agent) : undefined" compact />
            </div>
            <div v-if="reads.length" class="notice files-read">
              <paperclip :size="14" />
              <span>
                <template v-for="read in reads" :key="read.fileName">
                  <b>{{ read.fileName }}</b> — {{ readLine(read) }}<br />
                </template>
              </span>
            </div>
            <div v-if="slow && !waiting.length" class="slow">{{ t("chat.slow") }}</div>
          </div>
        </div>
      </div>
    </div>

    <footer class="composer">
      <div v-if="agentVideoJobs.length" class="videos">
        <span v-for="job in agentVideoJobs" :key="job.id" class="file staged-file">
          <film :size="12" /> {{ job.title ?? job.url }} — {{ videoLine(job) }}
          <button v-if="job.state === 'queued' || job.state === 'running'" type="button" :aria-label="t('chat.video.cancel')" @click="cancelVideo(job.id)"><x :size="12" /></button>
        </span>
      </div>
      <div v-if="videoLink" class="videos">
        <n-button size="tiny" secondary :loading="studying" @click="studyVideo">
          <film :size="12" /> &nbsp;{{ t("chat.video.study") }}
        </n-button>
        <span class="hint-inline">{{ speechConfigured ? t("chat.video.how") : t("chat.video.howNoSpeech") }}</span>
      </div>
      <div v-if="staged.length" class="staged">
        <span v-for="file in staged" :key="file.id" class="file staged-file">
          <paperclip :size="12" /> {{ file.fileName }} · {{ bytes(file.sizeBytes) }}
          <button type="button" :aria-label="t('chat.attach.remove')" @click="unstage(file.id)"><x :size="12" /></button>
        </span>
      </div>
      <div class="box">
        <input ref="picker" type="file" multiple hidden :accept="CHAT_ATTACHMENT_ACCEPT" @change="pick" />
        <n-button
          circle
          size="small"
          quaternary
          :disabled="sending || (limits !== null && staged.length >= limits.maxFiles)"
          :aria-label="t('chat.attach.add')"
          @click="picker?.click()"
        >
          <paperclip :size="16" />
        </n-button>
        <textarea
          ref="input"
          v-model="draft"
          rows="1"
          :placeholder="t('chat.placeholder')"
          :aria-label="t('chat.placeholder')"
          @keydown="onKeydown"
        />
        <n-button v-if="running" circle size="small" secondary :aria-label="t('chat.stop')" @click="stop">
          <square :size="12" fill="currentColor" />
        </n-button>
        <n-button v-else circle size="small" type="primary" :disabled="!draft.trim() && !staged.length" :loading="sending" :aria-label="t('chat.send')" @click="send()">
          <arrow-up :size="16" />
        </n-button>
      </div>
      <p class="hint">{{ t("chat.hint") }}</p>
    </footer>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  /* page padding: 28px top + 48px bottom on desktop */
  height: calc(100dvh - 76px);
  margin: -8px 0 -28px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.picker {
  width: 260px;
  max-width: 60vw;
}
.model {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.thread {
  max-width: 760px;
  margin: 0 auto;
  padding: 24px 4px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.center {
  margin: 60px auto;
}
.empty {
  text-align: center;
  margin: 8vh auto 0;
  max-width: 480px;
}
.empty-avatar {
  width: 56px;
  height: 56px;
  margin: 0 auto 14px;
  border-radius: 16px;
  display: grid;
  place-items: center;
  font-size: 28px;
  background: var(--surface-2);
}
.empty h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.empty p {
  margin: 8px 0 20px;
  color: var(--text-2);
  font-size: 14px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}
.chip {
  font: inherit;
  font-size: 13px;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 7px 14px;
  cursor: pointer;
}
.chip:hover {
  background: var(--surface-2);
}
.row {
  display: flex;
  gap: 12px;
}
.row.user {
  justify-content: flex-end;
}
.bubble {
  max-width: 80%;
  background: var(--accent-soft);
  border: 1px solid var(--border);
  padding: 9px 14px;
  border-radius: 16px 16px 4px 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 1.55;
}
.avatar {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  background: var(--surface-2);
  font-size: 16px;
  flex: none;
}
.body {
  min-width: 0;
  flex: 1;
  padding-top: 4px;
}
.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.tool {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--surface-2);
  color: var(--text-2);
  font-family: "JetBrains Mono", ui-monospace, Consolas, monospace;
}
.notice {
  display: inline-flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--muted);
}
.notice svg {
  flex: none;
  margin-top: 2px;
}
.notice.error {
  color: var(--critical);
}
.md {
  font-size: 14px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.md :deep(p) {
  margin: 0 0 8px;
}
.md :deep(p:last-child) {
  margin-bottom: 0;
}
.md :deep(ul),
.md :deep(ol) {
  margin: 4px 0 8px;
  padding-left: 22px;
}
.md :deep(pre) {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
}
.md :deep(pre code) {
  background: none;
  padding: 0;
}
.md :deep(a) {
  color: var(--accent);
}
.meta {
  margin-top: 6px;
  font-size: 11px;
  color: var(--muted);
}
.typing {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
}
.dots {
  display: inline-flex;
  gap: 3px;
}
.dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
  animation: blink 1.2s infinite ease-in-out;
}
.dots i:nth-child(2) {
  animation-delay: 0.15s;
}
.dots i:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes blink {
  0%,
  80%,
  100% {
    opacity: 0.25;
  }
  40% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .dots i {
    animation: none;
    opacity: 0.7;
  }
}
.approvals {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
}
.slow {
  margin-top: 8px;
  font-size: 12px;
  color: var(--muted);
}
.files-read {
  align-items: flex-start;
  line-height: 1.5;
}
.videos {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 0 4px 8px;
}
.hint-inline {
  font-size: 12px;
  opacity: 0.7;
}
.staged {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 4px 8px;
}
.file {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  line-height: 1.4;
}
.files {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
  opacity: 0.85;
}
.staged-file {
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
}
.staged-file button {
  display: inline-flex;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
  opacity: 0.6;
}
.staged-file button:hover {
  opacity: 1;
}
.composer {
  padding-top: 12px;
}
.box {
  max-width: 760px;
  margin: 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 8px 8px 8px 14px;
}
.box:focus-within {
  border-color: var(--accent);
}
textarea {
  flex: 1;
  resize: none;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 14px;
  line-height: 1.5;
  padding: 4px 0;
  max-height: 200px;
}
textarea::placeholder {
  color: var(--muted);
}
.hint {
  max-width: 760px;
  margin: 6px auto 0;
  font-size: 11px;
  color: var(--muted);
  text-align: center;
}
@media (max-width: 768px) {
  .chat {
    /* phone: 52px top bar + 20px/40px page padding */
    height: calc(100dvh - 112px);
    margin: -4px 0 -24px;
  }
  .bubble {
    max-width: 88%;
  }
}
</style>
