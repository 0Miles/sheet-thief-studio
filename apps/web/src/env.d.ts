/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in the build the end-to-end tests run against: it exposes `window.__studioTest` (src/testHook.ts). */
  readonly VITE_E2E?: string;
}
