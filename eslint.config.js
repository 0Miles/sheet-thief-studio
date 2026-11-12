// ESLint flat config for the whole workspace: JavaScript, TypeScript and Vue single-file
// components. Formatting is not linted here; only correctness rules.
import js from "@eslint/js";
import { defineConfigWithVueTs, vueTsConfigs } from "@vue/eslint-config-typescript";
import pluginVue from "eslint-plugin-vue";
import globals from "globals";

export default defineConfigWithVueTs(
  { ignores: ["**/dist/", "**/node_modules/", "apps/web/public/", "**/playwright-report/", "**/test-results/"] },
  js.configs.recommended,
  pluginVue.configs["flat/essential"],
  vueTsConfigs.recommended,
  // The server, config files and scripts run in Node.
  { files: ["apps/server/**/*.ts", "**/*.config.{js,ts}", "scripts/**/*.mjs"], languageOptions: { globals: globals.node } },
  // alphaTab stays behind the renderer's interface (docs/adr/0003). The Vite plugin that
  // bundles its workers is a different package and is not concerned.
  {
    files: ["apps/**/*.{ts,vue}", "packages/contracts/**/*.ts", "packages/score-model/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "@coderline/alphatab", message: "alphaTab is imported only inside packages/score-render (docs/adr/0003)." }] }],
    },
  },
);
