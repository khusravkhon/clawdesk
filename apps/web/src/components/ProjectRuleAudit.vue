<script setup lang="ts">
// P3: contradictions between the project's rules (the main agent's model reads them; the owner decides)
// and finding a rule by the owner's own phrase. An open contradiction blocks a task on its rules.
import type { BusinessRuleDto, RuleAuditDto, RuleMatchDto } from "@clawdesk/shared";
import { NAlert, NButton, NInput, NSpace, NSpin, NTag } from "naive-ui";
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ projectId: string; disabled: boolean; rules: BusinessRuleDto[] }>();
const emit = defineEmits<{ open: [ruleId: string] }>();
const { t, te } = useI18n();
const audit = ref<RuleAuditDto | null>(null), busy = ref(false), error = ref<string | null>(null);
const notes = reactive<Record<string, string>>({});
const phrase = ref(""), matches = ref<RuleMatchDto[] | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null, pending: { key: string; requestId: string } | null = null, disposed = false;

const open = computed(() => audit.value?.conflicts.filter((item) => item.status === "open") ?? []);
const decided = computed(() => audit.value?.conflicts.filter((item) => item.status === "dismissed") ?? []);
const explain = (e: unknown) => e instanceof ApiError && te(`ruleAudit.errors.${e.body.error}`) ? t(`ruleAudit.errors.${e.body.error}`) : t("ruleAudit.failed");
function requestId(key: string): string {
  if (pending?.key !== key) pending = { key, requestId: crypto.randomUUID() };
  return pending.requestId;
}
function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = !disposed && audit.value?.status === "checking" ? setTimeout(() => void load(), 2000) : null;
}
async function load(): Promise<void> {
  try { audit.value = await api.company.rulesAudit(props.projectId); error.value = null; }
  catch (e) { error.value = explain(e); }
  schedule();
}
async function run(call: () => Promise<RuleAuditDto>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try { audit.value = await call(); pending = null; error.value = null; }
  catch (e) { if (e instanceof ApiError) pending = null; error.value = explain(e); await load(); }
  finally { busy.value = false; schedule(); }
}
const check = () => run(() => api.company.rulesAuditCheck(props.projectId, { requestId: requestId(`check:${audit.value?.revision}`), revision: audit.value?.revision ?? 0 }));
const dismiss = (id: string) => notes[id]?.trim() && run(() => api.company.dismissRuleConflict(props.projectId, id, { note: notes[id]!.trim() }));
async function search(): Promise<void> {
  if (phrase.value.trim().length < 2) return;
  try { matches.value = (await api.company.rulesSearch(props.projectId, phrase.value.trim())).matches; error.value = null; }
  catch (e) { error.value = explain(e); }
}
watch(() => props.projectId, () => { matches.value = null; void load(); }, { immediate: true });
// A rule saved in the card changes what the last check read.
watch(() => props.rules.map((rule) => `${rule.id}:${rule.version}`).join(","), () => { if (!busy.value) void load(); });
onBeforeUnmount(() => { disposed = true; if (timer) clearTimeout(timer); });
</script>

<template>
  <section class="audit">
    <h3>{{ t("ruleAudit.title") }}</h3>
    <n-alert v-if="error" type="error" class="block">{{ error }}</n-alert>
    <template v-if="audit">
      <n-space align="center" class="block">
        <n-button :loading="busy || audit.status === 'checking'" :disabled="disabled || rules.length < 2 || audit.status === 'checking'" @click="check">{{ t("ruleAudit.check") }}</n-button>
        <span v-if="audit.status === 'checking'" class="hint"><n-spin size="small" /> {{ t("ruleAudit.checking") }}</span>
        <span v-else-if="rules.length < 2" class="hint">{{ t("ruleAudit.needTwo") }}</span>
        <span v-else-if="audit.stale" class="hint">{{ t(audit.checkedAt ? "ruleAudit.stale" : "ruleAudit.never") }}</span>
        <span v-else-if="audit.checkedAt" class="hint">{{ t("ruleAudit.checkedAt", { at: new Date(audit.checkedAt).toLocaleString() }) }}</span>
      </n-space>
      <n-alert v-if="audit.status === 'failed'" type="warning" class="block">{{ t(`ruleAudit.failure.${audit.failure ?? 'model_unavailable'}`) }}</n-alert>
      <n-alert v-if="audit.status === 'checked' && !audit.stale && !open.length" type="success" class="block">{{ t("ruleAudit.none") }}</n-alert>

      <div v-for="item in open" :key="item.id" class="conflict">
        <n-space align="center" size="small">
          <n-tag :type="item.outdated ? 'default' : 'error'" size="small">{{ t(item.outdated ? "ruleAudit.outdated" : "ruleAudit.open") }}</n-tag>
          <n-button v-for="rule in item.rules" :key="rule.ruleId" text type="primary" @click="emit('open', rule.ruleId)">{{ rule.code }} v{{ rule.version }}</n-button>
        </n-space>
        <p>{{ item.explanation }}</p>
        <p v-if="item.example" class="hint">{{ t("ruleAudit.example") }}: {{ item.example }}</p>
        <p v-if="item.question"><strong>{{ t("ruleAudit.question") }}:</strong> {{ item.question }}</p>
        <p v-if="!item.outdated" class="hint">{{ t("ruleAudit.blocks") }}</p>
        <n-space v-if="!item.outdated" align="center" class="block">
          <n-input v-model:value="notes[item.id]" size="small" maxlength="1000" :placeholder="t('ruleAudit.note')" :aria-label="t('ruleAudit.note')" :disabled="disabled || busy" class="note" />
          <n-button size="small" :disabled="disabled || busy || !notes[item.id]?.trim()" @click="dismiss(item.id)">{{ t("ruleAudit.dismiss") }}</n-button>
        </n-space>
      </div>
      <details v-if="decided.length" class="block">
        <summary>{{ t("ruleAudit.decided", { count: decided.length }) }}</summary>
        <p v-for="item in decided" :key="item.id" class="hint">{{ item.rules.map((rule) => rule.code).join(" + ") }}: {{ item.explanation }} — {{ item.note }}</p>
      </details>
    </template>

    <h3 class="block">{{ t("ruleAudit.searchTitle") }}</h3>
    <n-space align="center">
      <n-input v-model:value="phrase" maxlength="500" :placeholder="t('ruleAudit.searchPlaceholder')" :aria-label="t('ruleAudit.searchTitle')" class="phrase" @keyup.enter="search" />
      <n-button :disabled="phrase.trim().length < 2" @click="search">{{ t("ruleAudit.search") }}</n-button>
    </n-space>
    <p v-if="matches && !matches.length" class="hint block">{{ t("ruleAudit.noMatch") }}</p>
    <div v-for="match in matches ?? []" :key="match.ruleId" class="match">
      <span><strong>{{ match.code }}</strong> · {{ match.title }} <span class="hint">({{ match.matched.join(", ") }})</span></span>
      <n-button size="small" :disabled="disabled" @click="emit('open', match.ruleId)">{{ t("ruleAudit.openRule") }}</n-button>
    </div>
  </section>
</template>

<style scoped>
.audit { margin: 8px 0 16px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; }
.audit h3 { margin: 0 0 4px; font-size: 1em; }
.block { margin-top: 10px; }
.hint { font-size: 0.92em; opacity: 0.75; line-height: 1.6; }
.conflict { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); overflow-wrap: anywhere; }
.conflict p { margin: 6px 0 0; }
.note, .phrase { min-width: min(360px, 70vw); }
.match { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px; margin-top: 8px; overflow-wrap: anywhere; }
</style>
