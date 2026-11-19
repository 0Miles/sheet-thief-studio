# Repository guidance

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `0Miles/sheet-thief-studio`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-role triage vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

## Conventions

- The interface is Traditional Chinese only; every text lives in `apps/web/src/strings.ts`.
- Exception: part base names the server writes into a score live in score-model's `PRESET_BASE_NAMES` (`docs/spec/commands.md`, section 10).
- Exception: the texts Discord shows for the karyl-chan plugin (the `/studio` command and its answer) live in `DISCORD_TEXT` in `apps/server/src/karylPlugin.ts` (`docs/spec/karyl-login.md`).
- `packages/score-model` has no DOM and no alphaTab: the server and the web app share it.
- `packages/score-editor` has no DOM, no renderer and no co-editing transport (no Hocuspocus, no y-protocols): it works on any `Y.Doc`. The Vue shell turns clicks into cursors and writes the presence to the awareness (`docs/spec/testing.md`).
- alphaTab is imported only inside `packages/score-render` (`docs/adr/0003-renderer-behind-an-interface.md`).
- The spec appendices live in `docs/spec/` (index and change rules: `docs/spec/README.md`); read the ones your ticket touches before writing code.
- Checks before a pull request: `pnpm lint && pnpm typecheck && pnpm test`.
