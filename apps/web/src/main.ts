import "@fontsource-variable/inter";
import "./styles.css";
import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { i18n, i18nReady } from "./i18n";
import { router } from "./router";

// The language first: the router's sign-in check and the first screen already need translations.
void i18nReady.then(() => {
  const app = createApp(App).use(createPinia()).use(router).use(i18n);
  // After the first navigation (sign-in check included): no flash of the panel before the sign-in screen.
  return router.isReady().then(() => app.mount("#app"));
});
