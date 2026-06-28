# Agent Log

## 2026-06-12

- Added missing `docs/agent` notes required by the repo instructions.
- Investigated inline `var.` search in `src/extension.ts`.
- Added a Tupy-specific `editor.inlineSuggest.suppressSuggestions = false` default in `package.json`.
- Added a narrow `var.`-context suggest re-trigger in `src/extension.ts` so Copilot inline suggestions are less likely to hide the search completion UI while typing.
- Ran `npm run compile` successfully.

