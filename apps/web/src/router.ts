import { createRouter, createWebHistory } from "vue-router";

import HomeView from "./views/HomeView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: HomeView },
    // M0 spike: a score co-edited under a name, or one that lives in the page only.
    { path: "/spike/:name", name: "spike", component: () => import("./views/SpikeView.vue") },
    { path: "/local", name: "local", component: () => import("./views/SpikeView.vue") },
  ],
});
