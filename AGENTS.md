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
- `packages/score-model` has no DOM and no alphaTab: the server and the web app share it.
- alphaTab is imported only inside `packages/score-render` (`docs/adr/0003-renderer-behind-an-interface.md`).
- Checks before a pull request: `pnpm lint && pnpm typecheck && pnpm test`.
