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
    { path: "/scores/:id", name: "score", component: () => import("./views/ScoreView.vue"), props: true },
    { path: "/scores/:id/settings", name: "score-settings", component: () => import("./views/SettingsView.vue"), props: true },
    // A guest's score, by its read-only link: no login, and the address stays the link's.
    { path: "/s/:token", name: "guest", component: () => import("./views/ScoreView.vue"), props: true, meta: { public: true } },
    // M0 spike: a score co-edited by its id, or one that lives in the page only. The page stays
    // open to anyone until the real editor replaces it (#37); co-editing takes a member's ticket.
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
