import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/status" },
    { path: "/status", name: "status", component: () => import("./views/StatusView.vue") },
  ],
});
