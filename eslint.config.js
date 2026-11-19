// ESLint flat config for the whole workspace: JavaScript, TypeScript and Vue single-file
// components. Formatting is not linted here; only correctness rules.
import js from "@eslint/js";
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";

/** Any import of zod but "zod" itself (see the rule below). */
const ZOD_SUBPATHS = { group: ["zod/*"], message: 'Import "zod": the web build resolves only that name to zod without eval (packages/contracts/src/withoutEval.ts).' };

export default defineConfigWithVueTs(
  { ignores: ["**/dist/", "**/node_modules/", "apps/web/public/", "**/playwright-report/", "**/test-results/"] },
  js.configs.recommended,
  pluginVue.configs["flat/essential"],
  vueTsConfigs.recommended,
  // The server, config files and scripts run in Node.
  { files: ["apps/server/**/*.ts", "**/*.config.{js,ts}", "scripts/**/*.mjs"], languageOptions: { globals: globals.node } },
  // alphaTab stays behind the renderer's interface (docs/adr/0003). The Vite plugin that
  // bundles its workers is a different package and is not concerned. And zod is imported as
  // "zod" only: the web app's build resolves that one name to the zod set to parse without eval
  // (packages/contracts/src/withoutEval.ts, docs/spec/security.md section 7); a subpath would
  // reach zod without it. The module that sets it is the one that imports a subpath.
  {
    files: ["apps/**/*.{ts,vue}", "packages/contracts/**/*.ts", "packages/score-editor/**/*.ts", "packages/score-model/**/*.ts"],
    ignores: ["packages/contracts/src/withoutEval.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "@coderline/alphatab", message: "alphaTab is imported only inside packages/score-render (docs/adr/0003)." }], patterns: [ZOD_SUBPATHS] }],
    },
  },
  { files: ["packages/score-render/**/*.ts"], rules: { "no-restricted-imports": ["error", { patterns: [ZOD_SUBPATHS] }] } },
  // The platform is told in one place, detectKeyPlatform (docs/spec/keymap.md, 1.3).
  {
    files: ["apps/web/src/**/*.{ts,vue}", "packages/**/*.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        ...["platform", "userAgentData", "userAgent"].map((property) => ({
          object: "navigator",
          property,
          message: "The platform is told only by detectKeyPlatform, called once in apps/web/src/device.ts (docs/spec/keymap.md, 1.3).",
        })),
      ],
    },
  },
);
