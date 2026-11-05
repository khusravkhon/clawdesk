<script setup lang="ts">
// P6.2: work on an approved rule by the project's executors. QA writes tests that must fail on the current
// code, the developer makes them pass without touching tests, the owner reviews and accepts into the app.
// Every stage ends with the owner's button; the panel checks the work and explains a refusal.
// P6.3: a task on a newer version of an implemented rule is a change — the card shows what it touches
// before the task starts, test-by-test changes, asks the owner about existing data and offers a rollback.
// Review: the reviewer agent's verdict (from its REVIEW.md) sits next to the changes; accepting over
// "changes" needs a tick. Each check says whether the app ran apart from the tests.
import type { BusinessRuleDto, BusinessRuleFields, ProjectCheckTestDto, ProjectExecutorsDto, ProjectTaskDto, ProjectTaskStatus, ProjectTestChangeDto, RuleChangeImpactDto } from "@clawdesk/shared";
import { NAlert, NButton, NCard, NCheckbox, NEmpty, NFormItem, NInput, NPopconfirm, NSelect, NSpace, NSteps, NStep, NTag } from "naive-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";

const props = defineProps<{ projectId: string; disabled: boolean; refreshToken?: number }>();
const emit = defineEmits<{ changed: [] }>();
const { t, te } = useI18n();
const executors = ref<ProjectExecutorsDto | null>(null);
const tasks = ref<ProjectTaskDto[]>([]);
const rules = ref<BusinessRuleDto[]>([]);
const impact = ref<RuleChangeImpactDto | null>(null);
const loading = ref(false), busy = ref(false), error = ref<string | null>(null);
const ruleId = ref<string | null>(null), note = ref(""), comment = ref(""), confirmData = ref(false), overrideReview = ref(false);
let pending: { key: string; requestId: string } | null = null, generation = 0, impactGeneration = 0, disposed = false;

const ready = computed(() => !!executor("qa") && !!executor("developer"));
/** Projects assigned before the reviewer existed: it can be added without touching QA and the developer. */
const noReviewer = computed(() => ready.value && !executor("reviewer"));
const verdictType = (verdict: "approve" | "changes" | "unclear") => verdict === "approve" ? "success" : verdict === "changes" ? "warning" : "info";
const active = computed(() => tasks.value.find(task => ["qa", "dev", "review"].includes(task.status)) ?? null);
const past = computed(() => tasks.value.filter(task => task !== active.value));
const approved = computed(() => rules.value.filter(rule => rule.approvedAt !== null).map(rule => ({ value: rule.id, label: `${rule.code} · ${rule.fields.title} (${t('projectRules.version', { version: rule.version })})` })));
const stepOf = (status: ProjectTaskStatus) => ({ qa: 1, dev: 2, review: 3, done: 4, cancelled: 1 })[status];
const executor = (role: "qa" | "developer" | "reviewer") => executors.value?.executors.find(item => item.role === role) ?? null;
const testType = (test: Pick<ProjectCheckTestDto, "status">) => test.status === "passed" ? "success" : test.status === "failed" ? "error" : "warning";
const changeType = (change: ProjectTestChangeDto) => change.rule ? "info" : "error";
const fieldValue = (fields: BusinessRuleFields | null, field: keyof BusinessRuleFields) => fields?.[field]?.trim() || t("projectRules.notSpecified");
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
async function loadImpact(): Promise<void> {
  const sequence = ++impactGeneration, rule = rules.value.find(item => item.id === ruleId.value);
  if (!rule) { impact.value = null; return; }
  try {
    const result = await api.company.ruleImpact(props.projectId, rule.id, rule.version);
    if (!disposed && sequence === impactGeneration) impact.value = result;
  } catch (e) { if (!disposed && sequence === impactGeneration) { impact.value = null; error.value = explain(e); } }
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
const action = (task: ProjectTaskDto, name: "check" | "resend" | "cancel" | "rollback" | "review" | "review-collect") => run(`${name}:${task.id}:${task.revision}`, requestId => api.company.projectTaskAction(props.projectId, task.id, name, { requestId, revision: task.revision }));
const accept = (task: ProjectTaskDto) => run(`accept:${task.id}:${task.revision}:${confirmData.value}:${overrideReview.value}`, requestId => api.company.acceptProjectTask(props.projectId, task.id, { requestId, revision: task.revision, ...(task.previousVersion !== null ? { confirmData: confirmData.value } : {}), ...(task.reviewer?.verdict === "changes" ? { overrideReview: overrideReview.value } : {}) }));
/** The reviewer's remarks as the start of the comment for the developer. */
function useReviewComment(task: ProjectTaskDto): void { if (task.reviewer?.comment) comment.value = task.reviewer.comment.slice(0, 2000); }
function returnTask(task: ProjectTaskDto): void {
  if (!comment.value.trim()) return;
  void run(`return:${task.id}:${task.revision}`, requestId => api.company.returnProjectTask(props.projectId, task.id, { requestId, revision: task.revision, comment: comment.value.trim() })).then(() => { if (!error.value) comment.value = ""; });
}
watch(() => [props.projectId, props.refreshToken], () => { pending = null; void load(); }, { immediate: true });
watch(() => [ruleId.value, rules.value], () => { void loadImpact(); });
watch(() => active.value?.id, () => { confirmData.value = false; overrideReview.value = false; });
watch(() => active.value?.reviewer?.at, () => { overrideReview.value = false; });
onBeforeUnmount(() => { disposed = true; generation++; impactGeneration++; });
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
        <template v-if="noReviewer">
          <p>{{ t('projectTasks.noReviewer') }}</p>
          <n-button :loading="busy" :disabled="disabled || loading" @click="assign">{{ t('projectTasks.addReviewer') }}</n-button>
        </template>
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

        <template v-if="impact && impact.ruleId === ruleId">
          <n-alert v-if="impact.previousVersion !== null" type="info" class="tasks-block" :title="t('projectTasks.impact.title', { code: impact.code, from: impact.previousVersion, to: impact.version })">
            <p>{{ t('projectTasks.impact.intro', { task: impact.implementedBy }) }}</p>
            <div v-for="field in impact.changedFields" :key="field" class="tasks-row">
              <strong>{{ t(`projectRules.fields.${field}`) }}</strong>
              <p class="tasks-text"><n-tag size="small">{{ t('projectTasks.impact.before') }}</n-tag> {{ fieldValue(impact.previousFields, field) }}</p>
              <p class="tasks-text"><n-tag size="small" type="info">{{ t('projectTasks.impact.after') }}</n-tag> {{ fieldValue(impact.fields, field) }}</p>
            </div>
            <p v-if="!impact.changedFields.length">{{ t('projectTasks.impact.sameText') }}</p>
            <h4 class="tasks-block">{{ t('projectTasks.impact.tests') }}</h4>
            <p v-if="!impact.tests.length" class="tasks-meta">{{ t('projectTasks.impact.noTests') }}</p>
            <p v-for="test in impact.tests" :key="test.id"><n-tag size="small" :type="testType(test)">{{ t(`projectChecks.status.${test.status}`) }}</n-tag> {{ test.name }}</p>
            <h4 class="tasks-block">{{ t('projectTasks.impact.scenarios', { version: impact.previousVersion }) }}</h4>
            <p v-if="!impact.scenarios.length" class="tasks-meta">{{ t('projectTasks.impact.noScenarios') }}</p>
            <p v-for="item in impact.scenarios" :key="item.code">
              <n-tag v-if="item.status" size="small">{{ t(`projectAcceptance.automated.${item.status}`) }}</n-tag> {{ item.code }} · {{ item.title }}<span v-if="item.testRef" class="tasks-meta"> — {{ item.testRef }}</span>
            </p>
            <p v-if="impact.files.length" class="tasks-block">{{ t('projectTasks.impact.files', { task: impact.implementedBy, files: impact.files.join(', ') }) }}</p>
            <p class="tasks-block">{{ t('projectTasks.impact.newScenarios', { count: impact.newScenarios }) }}</p>
            <p class="tasks-block">{{ t('projectTasks.impact.data') }}</p>
          </n-alert>
          <p v-else-if="impact.implementedBy" class="tasks-meta">{{ t('projectTasks.impact.implemented', { task: impact.implementedBy }) }}</p>
          <p v-else class="tasks-meta">{{ t('projectTasks.impact.newRule') }}</p>
        </template>

        <n-form-item :label="t('projectTasks.note')"><n-input v-model:value="note" type="textarea" :maxlength="2000" :autosize="{ minRows: 2, maxRows: 5 }" :aria-label="t('projectTasks.note')" :disabled="busy" /></n-form-item>
        <n-button type="primary" :loading="busy" :disabled="disabled || !ruleId" @click="create">{{ t(impact?.previousVersion != null && impact.ruleId === ruleId ? 'projectTasks.createChange' : 'projectTasks.create') }}</n-button>
      </template>
    </section>

    <section v-if="active" class="tasks-block">
      <h3>{{ active.code }} · {{ active.ruleCode }} · {{ active.title }}</h3>
      <n-tag v-if="active.previousVersion !== null" size="small" type="info">{{ t('projectTasks.changeTag', { from: active.previousVersion, to: active.ruleVersion }) }}</n-tag>
      <n-steps :current="stepOf(active.status)" size="small" class="tasks-block">
        <n-step :title="t('projectTasks.steps.qa')" /><n-step :title="t('projectTasks.steps.dev')" /><n-step :title="t('projectTasks.steps.review')" /><n-step :title="t('projectTasks.steps.done')" />
      </n-steps>
      <n-alert v-if="active.outdated" type="warning" class="tasks-block">{{ t('projectTasks.outdated') }}</n-alert>
      <p v-if="active.note" class="tasks-text">{{ t('projectTasks.note') }}: {{ active.note }}</p>
      <p>{{ t(`projectTasks.now.${active.status}`, { name: (active.status === 'qa' ? executor('qa') : executor('developer'))?.name ?? '' }) }}</p>
      <n-alert v-if="active.status === 'dev' && active.returnComment" type="info" class="tasks-block">{{ t('projectTasks.returned') }}: {{ active.returnComment }}</n-alert>

      <template v-if="active.lastCheck">
        <n-alert :type="active.lastCheck.ok ? 'success' : 'warning'" class="tasks-block" :title="t(active.lastCheck.ok ? `projectTasks.checkOk.${active.lastCheck.stage}` : 'projectTasks.checkRefused')">
          <ul v-if="!active.lastCheck.ok"><li v-for="reason in active.lastCheck.reasons" :key="reason">{{ t(`projectTasks.reasons.${reason}`) }}</li></ul>
          <p v-for="warning in active.lastCheck.warnings" :key="warning">{{ t(`projectTasks.warnings.${warning}`) }}</p>
          <p v-if="active.lastCheck.ignored.length">{{ t('projectTasks.ignored') }}: {{ active.lastCheck.ignored.join(', ') }}</p>
          <p v-if="active.lastCheck.run?.isolation" class="tasks-meta">{{ t(`projectChecks.isolation.${active.lastCheck.run.isolation}`) }}</p>
        </n-alert>
        <template v-if="active.lastCheck.testChanges.length">
          <h4 class="tasks-block">{{ t('projectTasks.testChanges') }}</h4>
          <p v-for="change in active.lastCheck.testChanges" :key="change.id"><n-tag size="small" :type="changeType(change)">{{ t(`projectTasks.testChange.${change.change}`) }} · {{ t(change.rule ? 'projectTasks.ruleTest' : 'projectTasks.otherTest') }}</n-tag> {{ change.name }}</p>
        </template>
        <section v-for="test in [...active.lastCheck.ruleTests, ...active.lastCheck.otherProblems]" :key="test.id" class="tasks-row">
          <n-space align="center"><n-tag size="small" :type="testType(test)">{{ t(`projectChecks.status.${test.status}`) }}</n-tag><strong>{{ test.name }}</strong></n-space>
          <p v-if="test.message" class="tasks-code">{{ test.message }}</p>
        </section>
      </template>

      <template v-if="active.status === 'review' && active.review">
        <template v-if="active.reviewTests?.length">
          <h4 class="tasks-block">{{ t('projectTasks.testChanges') }}</h4>
          <p v-for="change in active.reviewTests" :key="change.id"><n-tag size="small" :type="changeType(change)">{{ t(`projectTasks.testChange.${change.change}`) }} · {{ t(change.rule ? 'projectTasks.ruleTest' : 'projectTasks.otherTest') }}</n-tag> {{ change.name }}</p>
        </template>
        <n-alert v-for="warning in active.reviewWarnings" :key="warning" type="warning" class="tasks-block">{{ t(`projectTasks.warnings.${warning}`) }}</n-alert>
        <h4 class="tasks-block">{{ t('projectTasks.changes') }}</h4>
        <details v-for="change in active.review" :key="change.name" class="tasks-row" open>
          <summary><n-tag size="small">{{ t(`projectTasks.change.${change.change}`) }}</n-tag> {{ change.name }}</summary>
          <pre v-if="change.diff !== null" class="tasks-diff">{{ change.diff }}</pre>
          <p v-else-if="change.change !== 'removed'" class="tasks-meta">{{ t('projectTasks.diffTooLarge') }}</p>
        </details>
        <section v-if="executor('reviewer')" class="tasks-row">
          <h4>{{ t('projectTasks.reviewer.title', { name: executor('reviewer')?.name ?? '' }) }}</h4>
          <p v-if="!active.reviewRequestedAt">{{ t('projectTasks.reviewer.notAsked') }}</p>
          <p v-else-if="!active.reviewer">{{ t('projectTasks.reviewer.waiting', { name: executor('reviewer')?.name ?? '' }) }}</p>
          <n-alert v-if="active.reviewer" :type="verdictType(active.reviewer.verdict)" :title="t(`projectTasks.reviewer.verdict.${active.reviewer.verdict}`)" class="tasks-block">
            <p v-if="active.reviewer.comment" class="tasks-text">{{ active.reviewer.comment }}</p>
            <p v-if="active.reviewer.changedFiles.length">{{ t('projectTasks.reviewer.changedFiles', { files: active.reviewer.changedFiles.join(', ') }) }}</p>
          </n-alert>
          <n-space class="tasks-block">
            <n-button v-if="active.reviewRequestedAt" :type="active.reviewer ? 'default' : 'primary'" :loading="busy" :disabled="disabled" @click="action(active, 'review-collect')">{{ t('projectTasks.reviewer.collect') }}</n-button>
            <n-button :disabled="disabled || busy" @click="action(active, 'review')">{{ t(active.reviewRequestedAt ? 'projectTasks.reviewer.askAgain' : 'projectTasks.reviewer.ask') }}</n-button>
            <n-button v-if="active.reviewer?.comment" :disabled="busy" @click="useReviewComment(active)">{{ t('projectTasks.reviewer.useComment') }}</n-button>
          </n-space>
        </section>
        <n-checkbox v-if="active.reviewer?.verdict === 'changes'" v-model:checked="overrideReview" class="tasks-block" :disabled="busy">{{ t('projectTasks.reviewer.override') }}</n-checkbox>
        <n-checkbox v-if="active.previousVersion !== null" v-model:checked="confirmData" class="tasks-block" :disabled="busy">{{ t('projectTasks.confirmData') }}</n-checkbox>
        <n-form-item :label="t('projectTasks.returnComment')" class="tasks-block"><n-input v-model:value="comment" type="textarea" :maxlength="2000" :autosize="{ minRows: 2, maxRows: 5 }" :aria-label="t('projectTasks.returnComment')" :disabled="busy" /></n-form-item>
      </template>

      <!-- Keys: NSpace wraps children by index, so without them a stage change could leave a stale button behind. -->
      <n-space :key="active.status" class="tasks-block">
        <n-button v-if="active.status === 'qa' || active.status === 'dev'" type="primary" :loading="busy" :disabled="disabled" @click="action(active, 'check')">{{ t(`projectTasks.check.${active.status}`) }}</n-button>
        <n-button v-if="active.status === 'qa' || active.status === 'dev'" :disabled="disabled || busy" @click="action(active, 'resend')">{{ t(active.lastCheck && !active.lastCheck.ok ? 'projectTasks.sendFindings' : 'projectTasks.remind') }}</n-button>
        <n-popconfirm v-if="active.status === 'review'" @positive-click="accept(active)"><template #trigger><n-button type="primary" :loading="busy" :disabled="disabled || active.outdated || (active.previousVersion !== null && !confirmData) || (active.reviewer?.verdict === 'changes' && !overrideReview)">{{ t('projectTasks.accept') }}</n-button></template><span class="tasks-confirm">{{ t('projectTasks.acceptConfirm') }}</span></n-popconfirm>
        <n-button v-if="active.status === 'review'" :disabled="disabled || busy || !comment.trim()" @click="returnTask(active)">{{ t('projectTasks.return') }}</n-button>
        <n-popconfirm @positive-click="action(active, 'cancel')"><template #trigger><n-button :disabled="busy">{{ t('projectTasks.cancel') }}</n-button></template><span class="tasks-confirm">{{ t('projectTasks.cancelConfirm') }}</span></n-popconfirm>
      </n-space>
    </section>

    <n-empty v-if="ready && !tasks.length" :description="t('projectTasks.empty')" class="tasks-block" />
    <details v-if="past.length" class="tasks-block" :open="past.some(task => task.canRollback)">
      <summary>{{ t('projectTasks.history') }}</summary>
      <div v-for="task in past" :key="task.id" class="tasks-history">
        <span>{{ task.code }} · {{ task.ruleCode }} · {{ task.title }}<template v-if="task.previousVersion !== null"> · {{ t('projectTasks.changeTag', { from: task.previousVersion, to: task.ruleVersion }) }}</template> · {{ t(task.rolledBackAt ? 'projectTasks.status.rolled_back' : `projectTasks.status.${task.status}`) }} · {{ new Date(task.rolledBackAt ?? task.updatedAt).toLocaleString() }}</span>
        <n-popconfirm v-if="task.canRollback" @positive-click="action(task, 'rollback')">
          <template #trigger><n-button size="small" :disabled="disabled || busy">{{ t('projectTasks.rollback') }}</n-button></template><span class="tasks-confirm">{{ t('projectTasks.rollbackConfirm', { task: task.code }) }}</span>
        </n-popconfirm>
      </div>
    </details>
    <p class="tasks-meta tasks-block">{{ t('projectTasks.limits') }}</p>
  </n-card>
</template>

<style scoped>
.tasks-block { margin-top: 12px; }
.tasks-row { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); }
.tasks-history { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; }
.tasks-meta { opacity: 0.7; font-size: 0.92em; }
/* A popconfirm sizes to its text; long confirmations would run off a narrow page. */
.tasks-confirm { display: inline-block; max-width: min(340px, 75vw); white-space: normal; }
.tasks-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.tasks-code { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, monospace; font-size: 0.9em; }
.tasks-diff { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, monospace; font-size: 0.85em; max-height: 360px; overflow: auto; padding: 8px; border: 1px solid var(--border); border-radius: 6px; }
h3, h4 { margin: 0 0 8px; }
p { line-height: 1.6; }
</style>
