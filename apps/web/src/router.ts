import { createRouter, createWebHistory } from "vue-router";

import { useSessionStore } from "./stores/session";
import HomeView from "./views/HomeView.vue";

declare module "vue-router" {
  interface RouteMeta {
    /** Open without logging in; every other page sends anyone not logged in to /login first. */
    public?: boolean;
    /** For admins only: to anyone else there is no such page. */
    admin?: boolean;
  }
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: () => import("./views/LoginView.vue"), meta: { public: true } },
    // Where an account with a temporary password is held until it has chosen its own.
    { path: "/account/password", name: "account-password", component: () => import("./views/AccountPasswordView.vue") },
    { path: "/account", name: "account", component: () => import("./views/AccountView.vue") },
    { path: "/admin", name: "admin", component: () => import("./views/AdminView.vue"), meta: { admin: true } },
    { path: "/", name: "home", component: HomeView },
    { path: "/phrases", name: "phrases", component: () => import("./views/PhrasesView.vue") },
    { path: "/phrases/:id", name: "phrase", component: () => import("./views/PhrasePage.vue"), props: true },
    // The score's page holds the score open (its document and connection) under its versions
    // page too, which restores a version in that document (docs/spec/collab.md, 8.5).
    {
      path: "/scores/:id",
      component: () => import("./views/ScorePage.vue"),
      props: true,
      children: [
        { path: "", name: "score", component: { render: () => null } },
        { path: "versions", name: "score-versions", component: () => import("./views/VersionsView.vue"), props: true },
      ],
    },
    { path: "/scores/:id/settings", name: "score-settings", component: () => import("./views/SettingsView.vue"), props: true },
    // A guest's score, by its read-only link: no login, and the address stays the link's.
    { path: "/s/:token", name: "guest", component: () => import("./views/ScorePage.vue"), props: true, meta: { public: true } },
    { path: "/:unknown(.*)*", name: "not-found", component: () => import("./views/NotFoundView.vue") },
  ],
});

router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  const session = useSessionStore();
  await session.load();
  // The page they were going to comes after logging in, and after the password is changed.
  const query = to.fullPath === "/" ? {} : { redirect: to.fullPath };
  if (!session.me) return { name: "login", query };
  const gate = to.name === "account-password";
  if (session.me.mustChangePassword) return gate ? true : { name: "account-password", query };
  // Nothing to change: the password is changed on /account, which asks for the current one.
  if (gate) return { name: "account" };
  // The page that says there is nothing here, under the address they asked for.
  if (to.meta.admin && !session.me.isAdmin) return { name: "not-found", params: { unknown: to.path.slice(1).split("/") }, query: to.query, hash: to.hash };
  return true;
});

/** Where to go after logging in: the page that sent them to /login, if it is one of ours. */
export function afterLogin(redirect: unknown): string {
  return typeof redirect === "string" && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/";
}
