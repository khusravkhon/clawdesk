<script setup lang="ts">
// Frame of the sign-in screens: brand on top, one narrow card.
import { NCard } from "naive-ui";
import { useI18n } from "vue-i18n";

defineProps<{ title: string; lead?: string }>();
const { t } = useI18n();
</script>

<template>
  <div class="auth">
    <div class="brand">
      <div class="logo">C</div>
      <span>{{ t("app.title") }}</span>
    </div>
    <n-card>
      <h1>{{ title }}</h1>
      <p v-if="lead" class="lead">{{ lead }}</p>
      <slot />
    </n-card>
  </div>
</template>

<style scoped>
.auth {
  max-width: 420px;
  margin: 6vh auto 0;
}
.brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-bottom: 20px;
  font-weight: 600;
  font-size: 16px;
}
.logo {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: grid;
  place-items: center;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, #8f85f3, #5b4fd9);
}
h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.lead {
  margin: 6px 0 18px;
  color: var(--text-2);
  font-size: 14px;
  line-height: 1.5;
}
</style>

<style>
/* For the screens' own content inside the card (not scoped: it is theirs, nested at any depth). */
.auth form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.auth .hint {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
}
.auth .command {
  display: block;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--surface-2);
  font-size: 12px;
  word-break: break-all;
  user-select: all;
}
</style>
