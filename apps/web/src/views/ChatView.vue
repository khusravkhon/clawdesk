<script setup lang="ts">
// Chat with an agent, with separate conversations in personal mode.
import type { AgentListItemDto, ChatAttachmentInput, ChatAttachmentLimitsDto, ChatAttachmentReadDto, ChatConversation, ChatMessageDto, ChatRunPhase, ChatStreamEvent } from "@clawdesk/shared";
import type { VideoJobDto, VideoJobMode } from "@clawdesk/shared";
import { CHAT_ATTACHMENT_ACCEPT, isVideoUrl, panelChatSessionKey } from "@clawdesk/shared";
import { AlertCircle, ArrowUp, CircleSlash, Download, Film, Images, Paperclip, Square, Wrench, X } from "@lucide/vue";
import MarkdownIt from "markdown-it";
import { NButton, NSelect, NSpin, useMessage } from "naive-ui";
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { api, ApiError } from "../api/client";
import ApprovalCard from "../components/ApprovalCard.vue";
import AutomaticWorkNotice from "../components/AutomaticWorkNotice.vue";
import LibrarySearch from "../components/LibrarySearch.vue";
import { formatBytes, intlLocale } from "../format";
import { modelErrorHint } from "../model-errors";
import { useApprovalsStore } from "../stores/approvals";
import { useSpaceStore } from "../stores/space";
import { PollBackoff } from "../chat-poll";

const { t, locale } = useI18n();
const message = useMessage();
const route = useRoute();
const router = useRouter();
const space = useSpaceStore();

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
const conversationId = computed(() => space.mode === "personal" && typeof route.query.conversation === "string" ? route.query.conversation : undefined);
const chatKey = computed(() => `${agentId.value}:${conversationId.value ?? "main"}`);
const sessionKey = computed(() => panelChatSessionKey(agentId.value, conversationId.value));
const conversations = ref<ChatConversation[]>([]);
const conversationOptions = computed(() => [
  { value: "main", label: t("chat.conversations.main") },
  ...conversations.value.map(({ id, title }) => ({ value: id, label: title })),
]);
const conversationForm = ref(false);
const conversationTitle = ref("");
const creatingConversation = ref(false);

function selectConversation(id: string): void {
  const query = { ...route.query };
  if (id === "main") delete query.conversation;
  else query.conversation = id;
  void router.push({ name: "chat", params: route.params, query });
}

let conversationListVersion = 0;
async function loadConversations(id: string): Promise<void> {
  const version = ++conversationListVersion;
  if (space.mode !== "personal") return;
  try {
    const result = await api.chat.conversations(id);
    if (alive && version === conversationListVersion) conversations.value = result.conversations;
  } catch (error) {
    if (alive && version === conversationListVersion) message.error(error instanceof ApiError ? error.body.message : String(error));
  }
}

async function createConversation(): Promise<void> {
  const title = conversationTitle.value.trim();
  if (!title || creatingConversation.value) return;
  const id = agentId.value;
  const key = chatKey.value;
  creatingConversation.value = true;
  try {
    const created = await api.chat.createConversation(id, title);
    if (!alive || id !== agentId.value) return;
    conversations.value = [created, ...conversations.value];
    void loadConversations(id);
    if (key === chatKey.value) {
      conversationForm.value = false;
      conversationTitle.value = "";
      selectConversation(created.id);
    }
  } catch (error) {
    if (alive && key === chatKey.value) message.error(error instanceof ApiError ? error.body.message : String(error));
  } finally {
    if (alive) creatingConversation.value = false;
  }
}
const agent = computed(() => agents.value.find((a) => a.id === agentId.value) ?? null);
const agentOptions = computed(() => agents.value.map((a) => ({ value: a.id, label: `${a.emoji ?? (a.role === "main" ? "🧭" : "🤖")}  ${displayName(a)}` })));
const displayName = (a: AgentListItemDto) => (a.role === "main" && a.name === a.id ? t("agents.main") : a.name);

const approvals = useApprovalsStore();
// Commands this agent is waiting on, answered right here in the chat.
const waiting = computed(() =>
  approvals.pending.filter((p) => p.sessionKey === sessionKey.value || (!conversationId.value && !p.sessionKey && p.agentId === agentId.value)),
);

const messages = ref<ChatMessageDto[]>([]);
const loading = ref(true);
type StagedFile = ChatAttachmentInput & { id: string };
type PendingSend = { id: string; text: string; files: StagedFile[]; state: "sending" | "unknown" | "rejected"; statusOnly?: boolean; conflict?: boolean };
type Composer = { text: string; files: StagedFile[]; pending: PendingSend | null; restored?: PendingSend };
const composers = reactive(new Map<string, Composer>());
const composer = computed(() => composers.get(chatKey.value));
const draft = computed({
  get: () => composer.value?.text ?? "",
  set: (text) => { if (composer.value) composer.value.text = text; },
});
const staged = computed(() => composer.value?.files ?? []);
const pendingSend = computed(() => composer.value?.pending ?? null);
const sending = computed(() => pendingSend.value?.state === "sending");
const sendStorageKey = (key: string) => `clawdesk.chat.pending.${key}`;

function rememberSend(key: string, id: string): void {
  try { sessionStorage.setItem(sendStorageKey(key), id); } catch { /* Storage can be disabled. */ }
}

function forgetSend(key: string, id: string): void {
  try {
    if (sessionStorage.getItem(sendStorageKey(key)) === id) sessionStorage.removeItem(sendStorageKey(key));
  } catch { /* Storage can be disabled. */ }
}

function recoverSend(key: string): PendingSend | null {
  try {
    const id = sessionStorage.getItem(sendStorageKey(key));
    if (id && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) {
      return { id, text: "", files: [], state: "unknown", statusOnly: true };
    }
  } catch { /* Storage can be disabled. */ }
  return null;
}

// The turn in progress.
const running = ref(false);
const phase = ref<ChatRunPhase>("preparing");
const liveText = ref("");
const liveTools = ref<string[]>([]);
const startedAt = ref<number | null>(null);
let runId: string | null = null;
let runVersion = 0;
let settledRunId: string | null = null;
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
const attachButton = ref<InstanceType<typeof NButton> | null>(null);

// Files staged for the next message: read in the browser, sent with chat.send, never stored by the panel.
const limits = ref<ChatAttachmentLimitsDto | null>(null);
const supported = CHAT_ATTACHMENT_ACCEPT.split(",");

const bytes = (value: number) => formatBytes(value, locale.value);

function newSendId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const data = crypto.getRandomValues(new Uint8Array(16));
  data[6] = (data[6]! & 0x0f) | 0x40;
  data[8] = (data[8]! & 0x3f) | 0x80;
  const hex = Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
}

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
  const origin = composer.value;
  const key = chatKey.value;
  if (!origin) return;
  for (const file of files) {
    if (!alive) return;
    if (max && origin.files.length >= max.maxFiles) {
      if (key !== chatKey.value) return;
      message.error(t("chat.attach.tooMany", { count: max.maxFiles }));
      break;
    }
    const type = file.type as ChatAttachmentInput["mimeType"];
    if (!supported.includes(type)) {
      if (key === chatKey.value) message.error(t("chat.attach.unsupported", { name: file.name }));
      continue;
    }
    const limit = max ? (type.startsWith("image/") ? max.maxImageBytes : max.maxFileBytes) : Infinity;
    if (file.size > limit) {
      if (key === chatKey.value) message.error(t("chat.attach.tooLarge", { name: file.name, limit: bytes(limit) }));
      continue;
    }
    if (max && origin.files.reduce((sum, stagedFile) => sum + stagedFile.sizeBytes, 0) + file.size > max.maxTotalBytes) {
      if (key === chatKey.value) message.error(t("chat.attach.tooMuch", { limit: bytes(max.maxTotalBytes) }));
      break;
    }
    try {
      const content = await toBase64(file);
      if (alive) origin.files.push({ id: newSendId(), fileName: file.name, mimeType: type, sizeBytes: file.size, content });
    } catch {
      if (alive && key === chatKey.value) message.error(t("chat.attach.readFailed", { name: file.name }));
    }
  }
}

function unstage(id: string): void {
  if (composer.value) composer.value.files = composer.value.files.filter((file) => file.id !== id);
}

// A video link in the composer: the panel can study it instead of sending the link as text.
// Studying happens in a worker outside the panel, so a job has its own state and can be stopped.
const videoJobs = ref<VideoJobDto[]>([]);
const speechConfigured = ref(true);
const downloadsAvailable = ref(false);
const studying = ref(false);
const videoLink = computed(() => (isVideoUrl(draft.value.trim()) ? draft.value.trim() : null));
const agentVideoJobs = computed(() => videoJobs.value.filter((job) => job.agentId === agentId.value).slice(0, 5));
let loadingVideos = false;
let videoVersion = 0;
const videoPoll = new PollBackoff();
const historyPoll = new PollBackoff();

async function loadVideoJobs(): Promise<void> {
  if (loadingVideos) return;
  loadingVideos = true;
  const version = videoVersion;
  try {
    const result = await api.video.jobs();
    if (!alive || version !== videoVersion) return;
    videoPoll.success();
    videoJobs.value = result.jobs;
    speechConfigured.value = result.speechConfigured;
    downloadsAvailable.value = result.downloadsAvailable;
  } catch {
    if (alive) videoPoll.failure();
  } finally {
    loadingVideos = false;
  }
}

async function studyVideo(mode: VideoJobMode = "study"): Promise<void> {
  const url = videoLink.value;
  if (!url || studying.value) return;
  const origin = composer.value;
  const key = chatKey.value;
  studying.value = true;
  try {
    const job = await api.video.study(agentId.value, url, mode);
    if (!alive) return;
    ++videoVersion;
    videoJobs.value = [job, ...videoJobs.value];
    if (origin?.text.trim() === url) origin.text = "";
  } catch (e) {
    if (!alive || key !== chatKey.value) return;
    if (e instanceof ApiError && e.body.error === "budget_usage_unavailable") {
      message.error(t("budget.unavailable"));
    } else if (e instanceof ApiError && e.body.error === "budget_exceeded") {
      message.error(t("budget.exceeded." + e.body.message));
    } else {
      message.error(e instanceof ApiError ? e.body.message : String(e));
    }
  } finally {
    if (alive) studying.value = false;
  }
}

async function cancelVideo(id: string): Promise<void> {
  const key = chatKey.value;
  try {
    const job = await api.video.cancel(id);
    if (!alive) return;
    ++videoVersion;
    videoJobs.value = videoJobs.value.map((item) => (item.id === job.id ? job : item));
  } catch (e) {
    if (alive && key === chatKey.value) message.error(e instanceof ApiError ? e.body.message : String(e));
  }
}

/** One line per job: what was asked, its state, and for a failure the reason the worker reported. */
function videoLine(job: VideoJobDto): string {
  if (job.state === "failed" && job.error) return t("chat.video.error." + job.error);
  const state = t("chat.video.state." + job.state);
  const mode = t("chat.video.mode." + job.mode);
  if (job.state === "running" && job.progress !== null) return `${mode}: ${state} ${job.progress}%`;
  if (job.state === "ready" && job.mode === "frames" && job.frames) return `${mode}: ${t("chat.video.framesSent", { count: job.frames })}`;
  if (job.state === "ready" && job.mode === "download" && job.fileBytes) return `${mode}: ${bytes(job.fileBytes)}`;
  return `${mode}: ${state}`;
}

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
  const version = viewVersion;
  void nextTick(() => {
    if (isCurrent(version)) scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
  });
}

let alive = true;
let viewVersion = 0;
const isCurrent = (version: number) => alive && version === viewVersion;
let historyRequest: { version: number; work: Promise<void> } | undefined;
const historyError = ref<string | null>(null);

function loadHistory(): Promise<void> {
  const version = viewVersion;
  if (historyRequest?.version === version) return historyRequest.work;
  const work = readHistory(version).finally(() => {
    if (historyRequest?.version === version) historyRequest = undefined;
  });
  historyRequest = { version, work };
  return work;
}

async function readHistory(version: number): Promise<void> {
  const before = messages.value.length;
  const lastRunVersion = runVersion;
  const pending = pendingSend.value?.state === "unknown" ? pendingSend.value : null;
  try {
    const h = await api.chat.history(agentId.value, conversationId.value, pending?.id);
    if (!isCurrent(version)) return;
    historyPoll.success();
    messages.value = h.messages;
    limits.value = h.attachments;
    historyError.value = null;
    if (h.acceptedSend && pending && composer.value?.pending?.id === pending.id && composer.value.pending.state === "unknown") {
      composer.value.pending = null;
      forgetSend(chatKey.value, pending.id);
    }
    if (h.messages.length !== before) scrollDown();
    if (runVersion !== lastRunVersion) return;
    if (h.running && !running.value) startRun(h.runId ?? null);
    if (h.running && running.value && !runId) runId = h.runId ?? null;
    // The Gateway does not always send a closing chat event (e.g. every model failed before replying);
    // the transcript is the source of truth once the turn has had a moment to register.
    if (!h.running && running.value && !sending.value && startedAt.value !== null && Date.now() - startedAt.value > 3_000) endRun();
  } catch (e) {
    if (isCurrent(version)) {
      historyPoll.failure();
      historyError.value = e instanceof ApiError ? e.body.message : String(e);
    }
  } finally {
    if (isCurrent(version)) {
      if (loading.value) scrollDown();
      loading.value = false;
    }
  }
}

function startRun(id: string | null = null): void {
  ++runVersion;
  runId = id;
  running.value = true;
  phase.value = "preparing";
  liveText.value = "";
  liveTools.value = [];
  startedAt.value = Date.now();
}

function endRun(): void {
  ++runVersion;
  runId = null;
  running.value = false;
  liveText.value = "";
  liveTools.value = [];
  startedAt.value = null;
}

let events: EventSource | null = null;
function connect(): void {
  events?.close();
  const version = viewVersion;
  events = new EventSource(api.chat.eventsUrl(agentId.value, conversationId.value));
  events.onopen = () => { if (isCurrent(version)) void loadHistory(); };
  events.onmessage = (e) => {
    if (isCurrent(version)) onEvent(JSON.parse(e.data) as ChatStreamEvent, version);
  };
}

function onEvent(ev: ChatStreamEvent, version: number): void {
  if (ev.runId === settledRunId || (runId && runId !== ev.runId)) return;
  if (!running.value) startRun(ev.runId);
  else runId = ev.runId;
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
      // falls through
    case "final":
    case "aborted":
      settledRunId = ev.runId;
      endRun();
      // A poll started before the terminal event can still have the old transcript.
      void (historyRequest?.version === version ? historyRequest.work : Promise.resolve()).then(() => {
        if (isCurrent(version)) void loadHistory();
      });
      break;
  }
  scrollDown();
}

/** A rejected file comes back as a reason code; the panel writes that reason in the owner's language. */
function attachmentError(error: ApiError): string {
  if (error.body.error === "document_queue_full") return t("chat.documentErrors.document_queue_full");
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
  const origin = composer.value;
  const body = text.trim();
  if (!origin || (!body && !origin.files.length) || origin.pending || running.value) return;
  const previous = origin.restored;
  const same = previous?.text === body && previous.files.length === origin.files.length && previous.files.every((file, index) => file.id === origin.files[index]?.id);
  const attempt: PendingSend = { id: same ? previous.id : newSendId(), text: body, files: origin.files, state: "sending" };
  origin.restored = undefined;
  if (text === origin.text) origin.text = "";
  origin.files = [];
  lastFailure.value = null;
  const localId = `local-${attempt.id}`;
  messages.value.push({
    id: localId,
    role: "user",
    text: body,
    tools: [],
    attachments: attempt.files.map(({ fileName, mimeType, sizeBytes }) => ({ fileName, mimeType, sizeBytes })),
    at: Date.now(),
    status: "ok",
  });
  reads.value = [];
  startRun(attempt.id);
  scrollDown();
  await submit(origin, attempt);
}

async function submit(origin: Composer, attempt: PendingSend): Promise<void> {
  const key = chatKey.value;
  origin.pending = { ...attempt, state: "sending" };
  rememberSend(key, attempt.id);
  try {
    const result = await api.chat.send(
      agentId.value,
      attempt.text,
      attempt.files.map(({ id: _id, ...file }) => file),
      attempt.id,
      conversationId.value,
    );
    if (!Array.isArray(result.reads)) throw new Error("invalid send response");
    forgetSend(key, attempt.id);
    if (!alive) return;
    origin.pending = null;
    if (key !== chatKey.value) return;
    reads.value = result.reads;
    void loadHistory();
    scrollDown();
  } catch (e) {
    const rejected = e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408;
    if (rejected) forgetSend(key, attempt.id);
    if (!alive) return;
    origin.pending = { ...attempt, state: rejected ? "rejected" : "unknown", conflict: e instanceof ApiError && e.body.error === "send_conflict" };
    if (rejected && !origin.text && !origin.files.length) restoreRejected(origin);
    if (key !== chatKey.value) return;
    if (runId === attempt.id) endRun();
    if (rejected) message.error(attachmentError(e));
    messages.value = messages.value.filter((m) => m.id !== `local-${attempt.id}`);
    if (!rejected) void loadHistory();
  } finally {
    const version = viewVersion;
    if (alive && key === chatKey.value) void nextTick(() => { if (isCurrent(version)) input.value?.focus(); });
  }
}

function restoreRejected(origin: Composer): void {
  const attempt = origin.pending;
  if (attempt?.state !== "rejected" || origin.text || origin.files.length) return;
  origin.text = attempt.text;
  origin.files = attempt.files;
  origin.pending = null;
  origin.restored = attempt.conflict ? undefined : attempt;
}

function retry(): void {
  const origin = composer.value;
  if (origin?.pending?.state !== "unknown") return;
  if (origin.pending.statusOnly) void loadHistory();
  else void submit(origin, origin.pending);
}

function dismissPending(): void {
  const origin = composer.value;
  if (!origin?.pending || sending.value) return;
  forgetSend(chatKey.value, origin.pending.id);
  origin.pending = null;
}

async function stop(): Promise<void> {
  const version = viewVersion;
  try {
    await api.chat.abort(agentId.value, conversationId.value);
  } catch (e) {
    if (isCurrent(version)) message.error(e instanceof ApiError ? e.body.message : String(e));
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
function open(): void {
  ++viewVersion;
  if (!composers.has(chatKey.value)) composers.set(chatKey.value, { text: "", files: [], pending: recoverSend(chatKey.value) });
  loading.value = true;
  messages.value = [];
  reads.value = [];
  limits.value = null;
  lastFailure.value = null;
  historyError.value = null;
  historyPoll.success();
  settledRunId = null;
  conversationForm.value = false;
  conversationTitle.value = "";
  endRun();
  connect();
  void loadHistory();
  const version = viewVersion;
  if (route.query.compose === "attachment") void nextTick(() => {
    if (isCurrent(version)) (attachButton.value?.$el as HTMLElement | undefined)?.focus();
  });
}

function onVisible(): void {
  if (document.hidden) return;
  void loadHistory();
  void loadVideoJobs();
}

onMounted(async () => {
  open();
  void loadConversations(agentId.value);
  document.addEventListener("visibilitychange", onVisible);
  clock = setInterval(() => (now.value = Date.now()), 1000);
  poll = setInterval(() => {
    if (document.hidden) return;
    if (historyPoll.due() && (running.value || pendingSend.value?.state === "unknown")) void loadHistory();
    // A video is studied outside the panel: its state changes without any chat event.
    if (videoPoll.due() && videoJobs.value.some((job) => job.state === "queued" || job.state === "running")) void loadVideoJobs();
  }, 4_000);
  void loadVideoJobs();
  try {
    const result = await api.agents();
    if (alive) agents.value = result.agents;
  } catch {
    // the picker stays empty; the chat itself still works for main
  }
});
onBeforeUnmount(() => {
  alive = false;
  events?.close();
  clearInterval(clock);
  clearInterval(poll);
  document.removeEventListener("visibilitychange", onVisible);
});
watch(chatKey, open, { flush: "sync" });
watch(agentId, (id) => {
  conversations.value = [];
  void loadConversations(id);
});
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
    <div v-if="space.mode === 'personal'" class="conversation-bar">
      <n-select
        :value="conversationId ?? 'main'"
        :options="conversationOptions"
        :aria-label="t('chat.conversations.label')"
        size="small"
        @update:value="selectConversation"
      />
      <n-button size="small" @click="conversationForm = !conversationForm">{{ t("chat.conversations.new") }}</n-button>
      <form v-if="conversationForm" class="conversation-form" @submit.prevent="createConversation">
        <input v-model="conversationTitle" :aria-label="t('chat.conversations.title')" :placeholder="t('chat.conversations.title')" maxlength="80" required />
        <n-button attr-type="submit" size="small" type="primary" :loading="creatingConversation" :disabled="!conversationTitle.trim()">
          {{ t("chat.conversations.create") }}
        </n-button>
      </form>
    </div>

    <div ref="scroller" class="scroll">
      <div class="thread">
        <n-spin v-if="loading" class="center" />
        <div v-if="historyError" class="notice" role="status">
          <alert-circle :size="14" />
          <span>{{ t("chat.historyUnavailable") }} {{ historyError }}</span>
          <n-button size="tiny" @click="loadHistory">{{ t("chat.sendRecovery.check") }}</n-button>
        </div>

        <div v-if="!loading && !historyError && !messages.length && !running" class="empty">
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

        <div v-if="reads.length" class="notice files-read" role="status">
          <paperclip :size="14" />
          <span>
            <template v-for="(read, index) in reads" :key="index">
              <b>{{ read.fileName }}</b> — {{ readLine(read) }}<br />
            </template>
          </span>
        </div>

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
            <div v-if="slow && !waiting.length" class="slow">{{ t("chat.slow") }}</div>
          </div>
        </div>
      </div>
    </div>

    <footer class="composer">
      <div v-if="pendingSend && pendingSend.state !== 'sending'" class="notice recovery" role="status">
        <span>{{ t(`chat.sendRecovery.${pendingSend.state}`) }}</span>
        <n-button v-if="pendingSend.state === 'unknown'" size="tiny" @click="retry">{{ t("chat.sendRecovery.check") }}</n-button>
        <n-button v-else size="tiny" :disabled="!!draft || !!staged.length" @click="composer && restoreRejected(composer)">{{ t("chat.sendRecovery.restore") }}</n-button>
        <n-button size="tiny" @click="dismissPending">{{ t("chat.sendRecovery.dismiss") }}</n-button>
      </div>
      <div id="library"><LibrarySearch :key="agentId" :agent-id="agentId" /></div>
      <div v-if="agentVideoJobs.length" class="videos">
        <span v-for="job in agentVideoJobs" :key="job.id" class="file staged-file">
          <film :size="12" /> {{ job.title ?? job.url }} — {{ videoLine(job) }}
          <a v-if="job.state === 'ready' && job.mode === 'download' && job.fileName" :href="api.video.fileUrl(job.id)" :title="t('chat.video.saveFile')" download>
            <download :size="12" />
          </a>
          <button v-if="job.state === 'queued' || job.state === 'running'" type="button" :aria-label="t('chat.video.cancel')" @click="cancelVideo(job.id)"><x :size="12" /></button>
        </span>
      </div>
      <div v-if="videoLink" class="videos">
        <n-button size="tiny" secondary :loading="studying" @click="studyVideo('study')">
          <film :size="12" /> &nbsp;{{ t("chat.video.study") }}
        </n-button>
        <n-button size="tiny" secondary :loading="studying" @click="studyVideo('frames')">
          <images :size="12" /> &nbsp;{{ t("chat.video.frames") }}
        </n-button>
        <n-button v-if="downloadsAvailable" size="tiny" secondary :loading="studying" @click="studyVideo('download')">
          <download :size="12" /> &nbsp;{{ t("chat.video.download") }}
        </n-button>
        <span class="hint-inline">{{ speechConfigured ? t("chat.video.how") : t("chat.video.howNoSpeech") }}</span>
      </div>
      <AutomaticWorkNotice v-if="videoLink && space.mode === 'personal'" kind="video" />
      <div v-if="staged.length" class="staged">
        <span v-for="file in staged" :key="file.id" class="file staged-file">
          <paperclip :size="12" /> {{ file.fileName }} · {{ bytes(file.sizeBytes) }}
          <button type="button" :aria-label="t('chat.attach.remove')" @click="unstage(file.id)"><x :size="12" /></button>
        </span>
      </div>
      <div class="box">
        <input ref="picker" type="file" multiple hidden :accept="CHAT_ATTACHMENT_ACCEPT" @change="pick" />
        <n-button
          ref="attachButton"
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
        <n-button v-else circle size="small" type="primary" :disabled="!!pendingSend || (!draft.trim() && !staged.length)" :loading="sending" :aria-label="t('chat.send')" @click="send()">
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
.conversation-bar, .conversation-form, .recovery {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.conversation-bar {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.conversation-bar > .n-select {
  width: 220px;
  max-width: 100%;
}
.conversation-form input {
  min-width: 0;
  padding: 4px 8px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
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
.staged-file button:hover,
.staged-file a:hover {
  opacity: 1;
}
.staged-file a {
  display: inline-flex;
  color: inherit;
  opacity: 0.6;
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
