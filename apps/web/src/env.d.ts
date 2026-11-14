/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in the build the end-to-end tests run against: it exposes `window.__studioTest` (src/testHook.ts). */
  readonly VITE_E2E?: string;
  /** "1" in the build the measure suite runs against: it exposes `window.__studioMeasure` (src/measureHook.ts). */
  readonly VITE_MEASURE?: string;
}
