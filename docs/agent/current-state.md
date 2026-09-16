# Current State

VSCode Tupy is a VS Code extension for `.tu.py` files. The extension registers language support, lexicon indexing, autocomplete, hover details, expression hints, ground-truth status markers, and a webview sidebar search.

As of 2026-09-16, `src/groundTruthStatus.ts` reads per-line ground-truth status (verified/mismatch/unaccounted, plus whether a target is declared) from the sibling `oldtupicorpus` checkout via `authoring.service.line_status(...)` (called through `scripts/ground_truth_status.py`, not duplicated in TypeScript) and paints a light background tint per line, refreshed on editor switch and save. Both actions below are on the CodeLens above the caret line and the editor right-click menu:

- `Correct ground truth…` collects a corrected surface form and optional linguist explanation, then copies a task prompt to the clipboard (never opens or submits a chat panel itself — the user pastes it wherever they want). The prompt treats this purely as a grammar-engine bug report against the sibling `../nhe-enga`: it never edits the Pydicate expression, requires exactly one human checkpoint (diagnosis + changelog preview, before any edit), then drives the fix, a `reload_engine` call, re-render, and a full cross-source regression check to completion without further check-ins. `reload_engine` is a new MCP tool that evicts cached `pydicate`/`tupi` modules from the long-lived authoring MCP server — skipping it after an engine edit silently re-tests stale code, which was the main source of wasted iteration in earlier sessions (see `oldtupicorpus`'s `2026-09-16-og-pluriform-prefix` session handoff).
- `✓ Commit ground truth` appears on an unaccounted line, or a mismatch with no previously declared target, and approves the current rendering as that line's ground truth via `authoring.service.commit_ground_truth(...)` (through `scripts/commit_ground_truth.py`) after a one-click confirmation. It only ever writes that one line's record, never a whole-source regenerate, and is a human-only action — it is deliberately not an MCP tool, so an agent can get a line ready but never approve it itself.

Inline lexicon search uses completion items in `src/extension.ts`: typing `var.<query>` in a Tupy document searches indexed lexicon entries and accepting an item replaces the whole `var...` query with the canonical variable name.

As of 2026-06-12, Tupy contributes a language-specific default that keeps the suggest widget visible when inline suggestions are present:

```json
"[tupy]": {
  "editor.inlineSuggest.suppressSuggestions": false
}
```

The extension also re-triggers VS Code's suggest widget while the active caret remains inside a `var.` inline query, which helps keep the inline search completion UI visible when Copilot ghost text appears.

