<script setup lang="ts">
// P6.2: work on an approved rule by the project's executors. QA writes tests that must fail on the current
// code, the developer makes them pass without touching tests, the owner reviews and accepts into the app.
// Every stage ends with the owner's button; the panel checks the work and explains a refusal.
import type { BusinessRuleDto, ProjectCheckTestDto, ProjectExecutorsDto, ProjectTaskDto, ProjectTaskStatus } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NEmpty, NFormItem, NInput, NPopconfirm, NSelect, NSpace, NSteps, NStep, NTag } from "naive-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ projectId: string; disabled: boolean; refreshToken?: number }>();
const emit = defineEmits<{ changed: [] }>();
const { t, te } = useI18n();
const executors = ref<ProjectExecutorsDto | null>(null);
const tasks = ref<ProjectTaskDto[]>([]);
const rules = ref<BusinessRuleDto[]>([]);
const loading = ref(false), busy = ref(false), error = ref<string | null>(null);
const ruleId = ref<string | null>(null), note = ref(""), comment = ref("");
let pending: { key: string; requestId: string } | null = null, generation = 0, disposed = false;

const ready = computed(() => (executors.value?.executors.length ?? 0) === 2);
const active = computed(() => tasks.value.find(task => ["qa", "dev", "review"].includes(task.status)) ?? null);
const past = computed(() => tasks.value.filter(task => task !== active.value));
const approved = computed(() => rules.value.filter(rule => rule.approvedAt !== null).map(rule => ({ value: rule.id, label: `${rule.code} · ${rule.fields.title} (${t('projectRules.version', { version: rule.version })})` })));
const stepOf = (status: ProjectTaskStatus) => ({ qa: 1, dev: 2, review: 3, done: 4, cancelled: 1 })[status];
const executor = (role: "qa" | "developer") => executors.value?.executors.find(item => item.role === role) ?? null;
const testType = (test: ProjectCheckTestDto) => test.status === "passed" ? "success" : test.status === "failed" ? "error" : "warning";
const explain = (e: unknown) => e instanceof ApiError && te(`projectTasks.errors.${e.body.error}`) ? t(`projectTasks.errors.${e.body.error}`) : e instanceof ApiError && te(`projectChecks.errors.${e.body.error}`) ? t(`projectChecks.errors.${e.body.error}`) : e instanceof ApiError && te(`company.errors.${e.body.error}`) ? t(`company.errors.${e.body.error}`) : t("projectTasks.failed");
/** One request ID per intended action until an answer arrives, so a retry after a lost response is not repeated. */
function requestId(key: string): string {
  if (pending?.key !== key) pending = { key, requestId: crypto.randomUUID() };
  return pending.requestId;
}

async function load(): Promise<void> {
  const sequence = ++generation, id = props.projectId;
  loading.value = true;
  try {
    const [people, list, ruleList] = await Promise.all([api.company.projectExecutors(id), api.company.projectTasks(id), api.company.rules(id)]);
    if (disposed || sequence !== generation || id !== props.projectId) return;
    executors.value = people; tasks.value = list.tasks; rules.value = ruleList.rules; error.value = null;
  } catch (e) { if (!disposed && sequence === generation) error.value = explain(e); }
  finally { if (!disposed && sequence === generation) loading.value = false; }
}
async function run(key: string, call: (requestId: string) => Promise<unknown>): Promise<void> {
  if (props.disabled || busy.value) return;
  busy.value = true; error.value = null;
  try { await call(requestId(key)); pending = null; await load(); emit("changed"); }
  catch (e) { if (e instanceof ApiError) pending = null; error.value = explain(e); await load(); }
  finally { busy.value = false; }
}
const assign = () => run("assign", requestId => api.company.assignExecutors(props.projectId, { requestId, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }));
function create(): void {
  const rule = rules.value.find(item => item.id === ruleId.value);
  if (!rule) return;
  void run(`create:${rule.id}:${note.value}`, requestId => api.company.createProjectTask(props.projectId, { requestId, ruleId: rule.id, ruleVersion: rule.version, note: note.value.trim() })).then(() => { if (!error.value) { ruleId.value = null; note.value = ""; } });
}
const action = (task: ProjectTaskDto, name: "check" | "resend" | "accept" | "cancel") => run(`${name}:${task.id}:${task.revision}`, requestId => api.company.projectTaskAction(props.projectId, task.id, name, { requestId, revision: task.revision }));
function returnTask(task: ProjectTaskDto): void {
  if (!comment.value.trim()) return;
  void run(`return:${task.id}:${task.revision}`, requestId => api.company.returnProjectTask(props.projectId, task.id, { requestId, revision: task.revision, comment: comment.value.trim() })).then(() => { if (!error.value) comment.value = ""; });
}
watch(() => [props.projectId, props.refreshToken], () => { pending = null; void load(); }, { immediate: true });
onBeforeUnmount(() => { disposed = true; generation++; });
</script>

<template>
  <n-card :title="t('projectTasks.title')" class="block">
    <template #header-extra><n-button text :loading="loading" :disabled="busy" @click="load">{{ t('company.refresh') }}</n-button></template>
    <p>{{ t('projectTasks.intro') }}</p>
    <n-alert v-if="error" type="error" class="tasks-block">{{ error }}</n-alert>

    <section class="tasks-block">
      <h3>{{ t('projectTasks.executors') }}</h3>
      <template v-if="ready">
        <n-space>
          <router-link v-for="item in executors?.executors" :key="item.agentId" :to="`/chat/${item.agentId}`"><n-tag>{{ item.emoji }} {{ item.name }} · {{ t(`projectTasks.roles.${item.role}`) }}</n-tag></router-link>
        </n-space>
        <p class="tasks-meta">{{ t('projectTasks.executorsHint') }}</p>
      </template>
      <template v-else>
        <p>{{ t('projectTasks.noExecutors') }}</p>
        <n-button type="primary" :loading="busy" :disabled="disabled || loading" @click="assign">{{ t('projectTasks.assign') }}</n-button>
      </template>
    </section>

    <section v-if="ready && !active" class="tasks-block">
      <h3>{{ t('projectTasks.newTask') }}</h3>
      <p v-if="!approved.length">{{ t('projectTasks.noApprovedRules') }}</p>
      <template v-else>
        <n-form-item :label="t('projectTasks.rule')"><n-select v-model:value="ruleId" :options="approved" :aria-label="t('projectTasks.rule')" :disabled="busy" /></n-form-item>
        <n-form-item :label="t('projectTasks.note')"><n-input v-model:value="note" type="textarea" :maxlength="2000" :autosize="{ minRows: 2, maxRows: 5 }" :aria-label="t('projectTasks.note')" :disabled="busy" /></n-form-item>
        <n-button type="primary" :loading="busy" :disabled="disabled || !ruleId" @click="create">{{ t('projectTasks.create') }}</n-button>
      </template>
    </section>

    <section v-if="active" class="tasks-block">
      <h3>{{ active.code }} · {{ active.ruleCode }} · {{ active.title }}</h3>
      <n-steps :current="stepOf(active.status)" size="small" class="tasks-block">
        <n-step :title="t('projectTasks.steps.qa')" /><n-step :title="t('projectTasks.steps.dev')" /><n-step :title="t('projectTasks.steps.review')" /><n-step :title="t('projectTasks.steps.done')" />
      </n-steps>
      <p v-if="active.note" class="tasks-text">{{ t('projectTasks.note') }}: {{ active.note }}</p>
      <p>{{ t(`projectTasks.now.${active.status}`, { name: (active.status === 'qa' ? executor('qa') : executor('developer'))?.name ?? '' }) }}</p>
      <n-alert v-if="active.status === 'dev' && active.returnComment" type="info" class="tasks-block">{{ t('projectTasks.returned') }}: {{ active.returnComment }}</n-alert>

      <template v-if="active.lastCheck">
        <n-alert :type="active.lastCheck.ok ? 'success' : 'warning'" class="tasks-block" :title="t(active.lastCheck.ok ? `projectTasks.checkOk.${active.lastCheck.stage}` : 'projectTasks.checkRefused')">
          <ul v-if="!active.lastCheck.ok"><li v-for="reason in active.lastCheck.reasons" :key="reason">{{ t(`projectTasks.reasons.${reason}`) }}</li></ul>
          <p v-if="active.lastCheck.ignored.length">{{ t('projectTasks.ignored') }}: {{ active.lastCheck.ignored.join(', ') }}</p>
        </n-alert>
        <section v-for="test in [...active.lastCheck.ruleTests, ...active.lastCheck.otherProblems]" :key="test.id" class="tasks-row">
          <n-space align="center"><n-tag size="small" :type="testType(test)">{{ t(`projectChecks.status.${test.status}`) }}</n-tag><strong>{{ test.name }}</strong></n-space>
          <p v-if="test.message" class="tasks-code">{{ test.message }}</p>
        </section>
      </template>

      <template v-if="active.status === 'review' && active.review">
        <h4 class="tasks-block">{{ t('projectTasks.changes') }}</h4>
        <details v-for="change in active.review" :key="change.name" class="tasks-row" open>
          <summary><n-tag size="small">{{ t(`projectTasks.change.${change.change}`) }}</n-tag> {{ change.name }}</summary>
          <pre v-if="change.diff !== null" class="tasks-diff">{{ change.diff }}</pre>
          <p v-else-if="change.change !== 'removed'" class="tasks-meta">{{ t('projectTasks.diffTooLarge') }}</p>
        </details>
        <n-form-item :label="t('projectTasks.returnComment')" class="tasks-block"><n-input v-model:value="comment" type="textarea" :maxlength="2000" :autosize="{ minRows: 2, maxRows: 5 }" :aria-label="t('projectTasks.returnComment')" :disabled="busy" /></n-form-item>
      </template>

      <n-space class="tasks-block">
        <n-button v-if="active.status === 'qa' || active.status === 'dev'" type="primary" :loading="busy" :disabled="disabled" @click="action(active, 'check')">{{ t(`projectTasks.check.${active.status}`) }}</n-button>
        <n-button v-if="active.status === 'qa' || active.status === 'dev'" :disabled="disabled || busy" @click="action(active, 'resend')">{{ t(active.lastCheck && !active.lastCheck.ok ? 'projectTasks.sendFindings' : 'projectTasks.remind') }}</n-button>
        <n-popconfirm v-if="active.status === 'review'" @positive-click="action(active, 'accept')"><template #trigger><n-button type="primary" :loading="busy" :disabled="disabled">{{ t('projectTasks.accept') }}</n-button></template>{{ t('projectTasks.acceptConfirm') }}</n-popconfirm>
        <n-button v-if="active.status === 'review'" :disabled="disabled || busy || !comment.trim()" @click="returnTask(active)">{{ t('projectTasks.return') }}</n-button>
        <n-popconfirm @positive-click="action(active, 'cancel')"><template #trigger><n-button :disabled="busy">{{ t('projectTasks.cancel') }}</n-button></template>{{ t('projectTasks.cancelConfirm') }}</n-popconfirm>
      </n-space>
    </section>

    <n-empty v-if="ready && !tasks.length" :description="t('projectTasks.empty')" class="tasks-block" />
    <details v-if="past.length" class="tasks-block">
      <summary>{{ t('projectTasks.history') }}</summary>
      <p v-for="task in past" :key="task.id">{{ task.code }} · {{ task.ruleCode }} · {{ task.title }} · {{ t(`projectTasks.status.${task.status}`) }} · {{ new Date(task.updatedAt).toLocaleString() }}</p>
    </details>
    <p class="tasks-meta tasks-block">{{ t('projectTasks.limits') }}</p>
  </n-card>
</template>

<style scoped>
.tasks-block { margin-top: 12px; }
.tasks-row { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
.tasks-meta { opacity: 0.7; font-size: 0.92em; }
.tasks-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.tasks-code { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, monospace; font-size: 0.9em; }
.tasks-diff { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, monospace; font-size: 0.85em; max-height: 360px; overflow: auto; padding: 8px; border: 1px solid var(--border); border-radius: 6px; }
h3, h4 { margin: 0 0 8px; }
p { line-height: 1.6; }
</style>
