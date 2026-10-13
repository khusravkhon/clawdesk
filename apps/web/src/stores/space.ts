import type { SpaceDto, SpaceMode } from "@clawdesk/shared";
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { api } from "../api/client";

/** Screen 2: the install's mode. Personal until chosen (installs from before the choice existed). */
export const useSpaceStore = defineStore("space", () => {
  const space = ref<SpaceDto | null>(null);
  const loaded = ref(false);
  const mode = computed<SpaceMode>(() => space.value?.mode ?? "personal");

  async function load(): Promise<void> {
    space.value = (await api.space.get()).space;
    loaded.value = true;
  }

  function set(value: SpaceDto): void {
    space.value = value;
    loaded.value = true;
  }

  return { space, loaded, mode, load, set };
});
