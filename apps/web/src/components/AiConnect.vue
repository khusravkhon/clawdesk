<script setup lang="ts">
// Connects an AI model to ONE agent (prop agentId): by API key / token, or by
// subscription sign-in. Used by the first-run window (main agent) and by the
// junior-agent builder (each agent may get its own access).
import type { ActivateResultDto, AiCatalogDto, AiProvider, AiSignInOption } from "@clawdesk/shared";
import { NA, NAlert, NButton, NCollapse, NCollapseItem, NGrid, NGi, NInput, NRadio, NRadioButton, NRadioGroup, NSpace, NSpin, NText } from "naive-ui";
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api, ApiError } from "../api/client";
import SignInFlow from "./SignInFlow.vue";

const props = defineProps<{ agentId: string }>();
const emit = defineEmits<{ connected: [result: ActivateResultDto] }>();
const { t, te } = useI18n();

const catalog = ref<AiCatalogDto | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
const selectedId = ref<string | null>(null);
const mode = ref<"key" | "signin">("key");
const signInOption = ref<AiSignInOption | null>(null);
const authChoice = ref<string | null>(null);
const apiKey = ref("");
const installing = ref(false);
const activating = ref(false);
const result = ref<ActivateResultDto | null>(null);
const actionError = ref<string | null>(null);

const popular = computed(() => catalog.value?.providers.filter((p) => p.popular) ?? []);
const others = computed(() => catalog.value?.providers.filter((p) => !p.popular) ?? []);
const provider = computed<AiProvider | null>(() => catalog.value?.providers.find((p) => p.id === selectedId.value) ?? null);
const providerSignIn = computed(() => catalog.value?.signIn.filter((s) => s.providerId === selectedId.value) ?? []);
const method = computed(() => provider.value?.methods.find((m) => m.authChoice === authChoice.value) ?? null);
const needsInstall = computed(() => !!provider.value?.installPluginId && provider.value.methods.length === 0);

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    catalog.value = await api.ai.catalog(props.agentId);
  } catch (error) {
    loadError.value = errorText(error);
  } finally {
    loading.value = false;
  }
}

function select(id: string, option: AiSignInOption | null = null): void {
  selectedId.value = id;
  signInOption.value = option;
  result.value = null;
  actionError.value = null;
  apiKey.value = "";
  const p = catalog.value?.providers.find((x) => x.id === id);
  mode.value = option || !p?.methods.length && !p?.installPluginId ? "signin" : "key";
}

function back(): void {
  selectedId.value = null;
  signInOption.value = null;
}

// Default to the first way of connecting whenever the provider (or its methods after install) changes.
watch(provider, (p) => {
  authChoice.value = p?.methods[0]?.authChoice ?? null;
});

async function install(): Promise<void> {
  if (!provider.value?.installPluginId) return;
  installing.value = true;
  actionError.value = null;
  try {
    await api.ai.install(provider.value.installPluginId);
    await load();
  } catch (error) {
    actionError.value = errorText(error);
  } finally {
    installing.value = false;
  }
}

async function activate(): Promise<void> {
  if (!authChoice.value) return;
  activating.value = true;
  actionError.value = null;
  result.value = null;
  try {
    const res = await api.ai.activate({ agentId: props.agentId, authChoice: authChoice.value, apiKey: apiKey.value });
    result.value = res;
    if (res.ok) {
      apiKey.value = "";
      emit("connected", res);
    }
  } catch (error) {
    actionError.value = errorText(error);
  } finally {
    activating.value = false;
  }
}

function onSignedIn(modelRef: string | null): void {
  emit("connected", { ok: true, status: "ok", modelRef, latencyMs: null, error: null, switchedModel: false });
}

function failureText(res: ActivateResultDto): string {
  const known = ["auth", "billing", "rate_limit", "timeout", "unavailable", "format"];
  return known.includes(res.status) ? t(`ai.fail.${res.status}`) : t("ai.fail.unknown", { error: res.error ?? res.status });
}

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.body.message : String(error);
}

onMounted(load);
</script>

<template>
  <n-spin :show="loading || installing">
    <n-alert v-if="loadError" type="error" :title="t('ai.loadFailed')">
      <p class="hint">{{ loadError }}</p>
      <n-button size="small" @click="load">{{ t("common.retry") }}</n-button>
    </n-alert>

    <!-- Step 1: pick a provider (or a subscription sign-in directly) -->
    <template v-else-if="catalog && !provider">
      <n-grid cols="2 s:3 m:4" responsive="screen" :x-gap="12" :y-gap="12">
        <n-gi v-for="p in popular" :key="p.id">
          <button class="provider" type="button" @click="select(p.id)">
            <span class="logo">{{ p.label.slice(0, 1) }}</span>
            <span class="name">{{ p.label }}</span>
          </button>
        </n-gi>
      </n-grid>

      <n-collapse v-if="others.length" class="mt">
        <n-collapse-item :title="t('ai.moreProviders', { n: others.length })" name="more">
          <n-space>
            <n-button v-for="p in others" :key="p.id" size="small" @click="select(p.id)">{{ p.label }}</n-button>
          </n-space>
        </n-collapse-item>
      </n-collapse>

      <div v-if="catalog.signIn.length" class="mt">
        <n-text depth="3">{{ t("ai.subscriptionTitle") }}</n-text>
        <n-space size="small" class="mt-s">
          <n-button v-for="s in catalog.signIn" :key="s.id" size="small" secondary @click="select(s.providerId ?? s.id, s)">{{ s.label }}</n-button>
        </n-space>
      </div>
    </template>

    <!-- Step 2: connect the chosen provider -->
    <template v-else-if="provider">
      <n-button text @click="back">← {{ t("ai.chooseOther") }}</n-button>
      <h2 class="provider-title">{{ provider.label }}</h2>

      <n-radio-group v-if="providerSignIn.length && (provider.methods.length || provider.installPluginId)" v-model:value="mode" class="block">
        <n-radio-button value="key">{{ t("ai.modeKey") }}</n-radio-button>
        <n-radio-button value="signin">{{ t("ai.modeSignIn") }}</n-radio-button>
      </n-radio-group>

      <!-- subscription sign-in -->
      <template v-if="mode === 'signin'">
        <SignInFlow
          v-if="signInOption"
          :key="signInOption.id"
          :agent-id="agentId"
          :option="signInOption"
          @connected="onSignedIn"
          @cancel="signInOption = null"
        />
        <n-space v-else vertical>
          <n-button v-for="s in providerSignIn" :key="s.id" @click="signInOption = s">
            {{ s.label }}<n-text v-if="s.hint" depth="3">&nbsp;— {{ s.hint }}</n-text>
          </n-button>
        </n-space>
      </template>

      <!-- API key / token -->
      <template v-else-if="needsInstall">
        <p>{{ t("ai.installExplain", { name: provider.label }) }}</p>
        <n-button type="primary" :loading="installing" @click="install">{{ t("ai.install", { name: provider.label }) }}</n-button>
      </template>

      <template v-else>
        <n-radio-group v-if="provider.methods.length > 1" v-model:value="authChoice" class="block">
          <n-space vertical>
            <n-radio v-for="m in provider.methods" :key="m.authChoice" :value="m.authChoice">
              {{ m.label }}<n-text v-if="m.hint" depth="3"> — {{ m.hint }}</n-text>
            </n-radio>
          </n-space>
        </n-radio-group>

        <n-input
          v-model:value="apiKey"
          type="password"
          show-password-on="click"
          :placeholder="method?.input === 'token' ? t('ai.tokenPlaceholder') : t('ai.keyPlaceholder')"
          :input-props="{ autocomplete: 'off', spellcheck: false }"
          class="block"
          @keyup.enter="apiKey.length >= 8 && activate()"
        />
        <p v-if="provider.website" class="hint">
          <n-a :href="provider.website" target="_blank" rel="noopener noreferrer">{{ t("ai.whereKey", { name: provider.label }) }}</n-a>
        </p>
        <p v-if="te(`ai.keySteps.${provider.id}`)" class="hint">{{ t(`ai.keySteps.${provider.id}`) }}</p>
        <p class="hint">{{ t("ai.privacy") }}</p>

        <n-button type="primary" :loading="activating" :disabled="apiKey.trim().length < 8 || !authChoice" @click="activate">
          {{ t("ai.checkAndConnect") }}
        </n-button>

        <n-alert v-if="result?.ok" type="success" class="mt" :title="t('ai.connected')">
          {{ t("ai.connectedDetail", { model: result.modelRef ?? "—", ms: result.latencyMs ?? "—" }) }}
          <template v-if="result.switchedModel"><br />{{ t("ai.switchedModel") }}</template>
        </n-alert>
        <n-alert v-else-if="result" type="error" class="mt">{{ failureText(result) }}</n-alert>
      </template>

      <n-alert v-if="actionError" type="error" class="mt">{{ actionError }}</n-alert>
    </template>
  </n-spin>
</template>

<style scoped>
.provider {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--n-border-color, rgba(128, 128, 128, 0.3));
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.provider:hover,
.provider:focus-visible {
  border-color: #18a058;
  outline: none;
}
.logo {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-weight: 700;
  background: rgba(24, 160, 88, 0.15);
  color: #18a058;
  flex: none;
}
.name {
  font-weight: 500;
}
.provider-title {
  margin: 8px 0 16px;
}
.block {
  display: block;
  margin-bottom: 12px;
}
.hint {
  margin: 0 0 12px;
  font-size: 13px;
  opacity: 0.75;
}
.mt {
  margin-top: 16px;
}
.mt-s {
  margin-top: 8px;
}
</style>
