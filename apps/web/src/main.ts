import "@fontsource-variable/inter";
import "./styles.css";
import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { i18n } from "./i18n";
import { router } from "./router";

const app = createApp(App).use(createPinia()).use(router).use(i18n);
// After the first navigation (sign-in check included): no flash of the panel before the sign-in screen.
void router.isReady().then(() => app.mount("#app"));
