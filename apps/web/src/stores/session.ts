// Who is logged in in this browser: the account `GET /api/me` answers with, or nobody.
import { type ChangePasswordRequest, type LoginRequest, type Me, me as meShape } from "@studio/contracts";
import { defineStore } from "pinia";
import { ref } from "vue";

import { ApiError, get, patchFor, post } from "../api";

export const useSessionStore = defineStore("session", () => {
  const me = ref<Me | null>(null);
  /** A page found the session ended while it was open: /login says so until someone logs in. */
  const expired = ref(false);
  let asked: Promise<void> | null = null;

  /** The server no longer knows this session (logged out elsewhere, a new password, the account disabled): nobody is logged in here. */
  function expire(): void {
    me.value = null;
    expired.value = true;
    asked = Promise.resolve();
  }

  /** Ask the server once per page load; later calls wait for that answer. A failure is asked again. */
  function load(): Promise<void> {
    asked ??= get("/api/me", meShape).then(
      (account) => {
        me.value = account;
      },
      (error: unknown) => {
        if (!(error instanceof ApiError && error.status === 401)) {
          asked = null;
          throw error;
        }
        me.value = null;
      },
    );
    return asked;
  }

  async function login(credentials: LoginRequest): Promise<void> {
    await post("/api/auth/login", credentials);
    me.value = await get("/api/me", meShape);
    expired.value = false;
    asked = Promise.resolve();
  }

  async function logout(): Promise<void> {
    await post("/api/auth/logout");
    me.value = null;
    asked = Promise.resolve();
  }

  /** Every device, this one included: nobody is logged in here afterwards. */
  async function logoutAll(): Promise<void> {
    await post("/api/auth/logout-all");
    me.value = null;
    asked = Promise.resolve();
  }

  async function rename(displayName: string): Promise<void> {
    me.value = await patchFor("/api/me", { displayName }, meShape);
  }

  /** This session stays logged in; the account then no longer has to change its password. */
  async function changePassword(passwords: ChangePasswordRequest): Promise<void> {
    await post("/api/me/password", passwords);
    me.value = await get("/api/me", meShape);
  }

  return { me, expired, expire, load, login, logout, logoutAll, rename, changePassword };
});
