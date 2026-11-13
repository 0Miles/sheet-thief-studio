// Who is logged in in this browser: the account `GET /api/me` answers with, or nobody.
import { type LoginRequest, type Me, me as meShape } from "@studio/contracts";
import { defineStore } from "pinia";
import { ref } from "vue";

import { ApiError, get, post } from "../api";

export const useSessionStore = defineStore("session", () => {
  const me = ref<Me | null>(null);
  let asked: Promise<void> | null = null;

  /** Ask the server once per page load; later calls wait for that answer. */
  function load(): Promise<void> {
    asked ??= get("/api/me", meShape).then(
      (account) => {
        me.value = account;
      },
      (error: unknown) => {
        if (!(error instanceof ApiError && error.status === 401)) throw error;
        me.value = null;
      },
    );
    return asked;
  }

  async function login(credentials: LoginRequest): Promise<void> {
    await post("/api/auth/login", credentials);
    me.value = await get("/api/me", meShape);
    asked = Promise.resolve();
  }

  async function logout(): Promise<void> {
    await post("/api/auth/logout");
    me.value = null;
    asked = Promise.resolve();
  }

  return { me, load, login, logout };
});
