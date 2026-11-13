import { createRouter, createWebHistory } from "vue-router";

import { useSessionStore } from "./stores/session";
import HomeView from "./views/HomeView.vue";

declare module "vue-router" {
  interface RouteMeta {
    /** Open without logging in; every other page sends anyone not logged in to /login first. */
    public?: boolean;
  }
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: () => import("./views/LoginView.vue"), meta: { public: true } },
    { path: "/", name: "home", component: HomeView },
    // M0 spike: a score co-edited under a name, or one that lives in the page only. It stays
    // open to anyone, as in M0, until the real editor replaces it (#37).
    { path: "/spike/:name", name: "spike", component: () => import("./views/SpikeView.vue"), meta: { public: true } },
    { path: "/local", name: "local", component: () => import("./views/SpikeView.vue"), meta: { public: true } },
    { path: "/:unknown(.*)*", name: "not-found", component: () => import("./views/NotFoundView.vue") },
  ],
});

router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  const session = useSessionStore();
  await session.load();
  if (session.me) return true;
  return { name: "login", query: to.fullPath === "/" ? {} : { redirect: to.fullPath } };
});

/** Where to go after logging in: the page that sent them to /login, if it is one of ours. */
export function afterLogin(redirect: unknown): string {
  return typeof redirect === "string" && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/";
}
