/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

interface Window {
  /** Present only inside the Tauri desktop shell. */
  __TAURI__?: unknown;
}
