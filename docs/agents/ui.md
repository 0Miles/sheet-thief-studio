# UI

## Component library

- Package and version: `@karyl-chan/ui@0.5.0`
- Loading: everything is imported from the package root `@karyl-chan/ui`; `apps/web/src/main.ts` imports `@karyl-chan/ui/tokens.css` and then `./styles/app.css`, and calls `useColorScheme()` before the app mounts. The package's `reset.css`, `use-drawer.css` and `use-popover.css` are not loaded.
- Bundled skill: none

## Tokens

- Location: `@karyl-chan/ui/tokens.css` (the base set, light and dark), overridden and extended by `apps/web/src/styles/app.css` (the studio's `--accent*` and `--font-sans`)
- Naming rule: color tokens carry their role in the name — `--bg-*` backgrounds, `--text-*` text, `--border*` borders, `--accent*` the brand accent, `--danger` errors, `--success-*` / `--warn-*` status (e.g. `--text-muted` is secondary text); `--space-0` … `--space-8` and `--radius-sm` … `--radius-pill` are scale steps with no role.

## Shared components

| Component | Location | Use when | Instead | Wraps |
| --- | --- | --- | --- | --- |
| `AppHeader` | `apps/web/src/components/AppHeader.vue` | The top bar of every page: the app name linking home, the admin and account links, and logout | — | — |
| `DrawFailed` | `apps/web/src/components/DrawFailed.vue` | A score could not be drawn (music font or layout worker failed) and the page offers to try again | A plain error text for failures that are not about drawing | — |
| `PasswordForm` | `apps/web/src/components/PasswordForm.vue` | Choosing a new password, typed twice, after the current one when asked for | `AppTextField` for any other single field | — |
| `PhraseEditor` | `apps/web/src/components/PhraseEditor.vue` | Showing and editing a phrase's notes as a one-part score, with the page's own toolbar and side content in its slots | The score view for a whole score | — |
| `PlayerControls` | `apps/web/src/components/PlayerControls.vue` | Play / pause / stop of a drawn score, and where playback is | — | — |

## Conventions

- Wrappers: none; pages and components use `@karyl-chan/ui` components directly, with no wrapper layer
- New shared components: go in `apps/web/src/components/`; come with typed `defineProps` / `defineEmits` in `<script setup lang="ts">`, every text from `apps/web/src/strings.ts`; no barrel export, no story
- Duplicates: none

## Mechanical checks

- lint: `pnpm lint`
- typecheck: `pnpm typecheck`
- test: `pnpm test`
- e2e: `pnpm --filter @studio/web test:e2e`
