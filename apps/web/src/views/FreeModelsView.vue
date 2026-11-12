<script setup lang="ts">
// Free models for junior agents (personal mode): paste free keys from providers'
// free tiers; FreeLLMAPI on the server pools them behind one model.
import type { FreeModelsStatusDto, FreeProviderDto } from "@clawdesk/shared";
import { NA, NAlert, NButton, NCard, NCollapse, NCollapseItem, NInput, NPopconfirm, NSpace, NSpin, NTag, NText, useMessage } from "naive-ui";
import { computed, onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import PageHeader from "../components/ui/PageHeader.vue";
import { api, ApiError } from "../api/client";

const { t } = useI18n();
const message = useMessage();
const status = ref<FreeModelsStatusDto | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const keys = reactive<Record<string, string>>({});
const busy = ref<string | null>(null);

const recommended = computed(() => status.value?.providers.filter((p) => p.recommended) ?? []);
const others = computed(() => status.value?.providers.filter((p) => !p.recommended) ?? []);

async function load(): Promise<void> {
  loading.value = true;
  try {
    status.value = await api.freeModels.status();
    error.value = status.value.available ? null : codeText(status.value.errorCode, status.value.error);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    loading.value = false;
  }
}

async function add(p: FreeProviderDto): Promise<void> {
  busy.value = p.platform;
  try {
    status.value = await api.freeModels.addKey(p.platform, (keys[p.platform] ?? "").trim());
    keys[p.platform] = "";
    message.success(t("free.added", { name: p.name }));
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = null;
  }
}

async function remove(p: FreeProviderDto): Promise<void> {
  busy.value = p.platform;
  try {
    status.value = await api.freeModels.removeKeys(p.platform);
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = null;
  }
}

// The server's own words stay only where they carry a provider's reason (a rejected key).
function codeText(code: string | null | undefined, detail: string | null): string {
  if (code === "not_installed" || code === "unavailable") return t(`free.errors.${code}`);
  if (code === "rejected") return detail ? `${t("free.errors.rejected")} ${detail}` : t("free.errors.rejected");
  return detail ?? t("free.errors.unavailable");
}

function errorText(e: unknown): string {
  return e instanceof ApiError ? codeText(e.body.error.replace(/^free_models_/, ""), e.body.message) : String(e);
}

onMounted(load);
</script>

<template>
  <div>
    <page-header :title="t('free.title')" :subtitle="t('free.lead')" />
    <n-space vertical size="large">
      <n-alert type="warning" :title="t('free.warnTitle')">
        <ul class="warn">
          <li>{{ t("free.warn1") }}</li>
          <li>{{ t("free.warn2") }}</li>
          <li>{{ t("free.warn3") }}</li>
        </ul>
      </n-alert>

      <n-alert v-if="error" type="error">{{ error }}</n-alert>
      <n-alert v-if="status?.ready" type="success" :show-icon="false">{{ t("free.ready") }}</n-alert>

      <n-spin :show="loading">
        <n-card :title="t('free.recommended')">
          <p class="hint">{{ t("free.startWithGoogle") }}</p>
          <n-space vertical size="large">
            <div v-for="p in recommended" :key="p.platform" class="row">
              <n-space align="center" justify="space-between">
                <n-space align="center">
                  <strong>{{ p.name }}</strong>
                  <n-tag v-if="p.configured" type="success" size="small">{{ t("free.keyAdded", { n: p.keyCount }) }}</n-tag>
                </n-space>
                <n-a v-if="p.signupUrl" :href="p.signupUrl" target="_blank" rel="noopener noreferrer">{{ t("free.getKey") }}</n-a>
              </n-space>
              <n-space class="mt-s" align="center" :wrap="false">
                <n-input
                  v-model:value="keys[p.platform]"
                  type="password"
                  show-password-on="click"
                  :placeholder="t('free.keyPlaceholder')"
                  :input-props="{ autocomplete: 'off', spellcheck: false }"
                  style="min-width: 280px"
                />
                <n-button type="primary" :loading="busy === p.platform" :disabled="(keys[p.platform] ?? '').trim().length < 8" @click="add(p)">
                  {{ t("free.add") }}
                </n-button>
                <n-popconfirm v-if="p.configured" @positive-click="remove(p)">
                  <template #trigger>
                    <n-button quaternary type="error" :disabled="busy === p.platform">{{ t("free.remove") }}</n-button>
                  </template>
                  {{ t("free.removeConfirm", { name: p.name }) }}
                </n-popconfirm>
              </n-space>
            </div>
          </n-space>
        </n-card>

        <n-collapse v-if="others.length" class="mt">
          <n-collapse-item :title="t('free.others', { n: others.length })" name="others">
            <n-text depth="3">{{ t("free.othersHint") }}</n-text>
            <n-space vertical class="mt-s">
              <n-space v-for="p in others" :key="p.platform" align="center">
                <span class="other-name">{{ p.name }}</span>
                <n-tag v-if="p.configured" type="success" size="small">{{ t("free.keyAdded", { n: p.keyCount }) }}</n-tag>
                <n-input v-model:value="keys[p.platform]" type="password" size="small" :placeholder="t('free.keyPlaceholder')" style="width: 240px" />
                <n-button size="small" :loading="busy === p.platform" :disabled="(keys[p.platform] ?? '').trim().length < 8" @click="add(p)">{{ t("free.add") }}</n-button>
              </n-space>
            </n-space>
          </n-collapse-item>
        </n-collapse>
      </n-spin>
    </n-space>
  </div>
</template>

<style scoped>
.title {
  margin: 0 0 4px;
  font-size: 22px;
}
.warn {
  margin: 0;
  padding-left: 18px;
}
.row {
  padding: 12px;
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 10px;
}
.hint {
  font-size: 13px;
  opacity: 0.8;
  margin-top: 0;
}
.other-name {
  min-width: 180px;
  display: inline-block;
}
.mt {
  margin-top: 16px;
}
.mt-s {
  margin-top: 8px;
}
</style>
