# Current State

VSCode Tupy is a VS Code extension for `.tu.py` files. The extension registers language support, lexicon indexing, autocomplete, hover details, expression hints, and a webview sidebar search.

Inline lexicon search uses completion items in `src/extension.ts`: typing `var.<query>` in a Tupy document searches indexed lexicon entries and accepting an item replaces the whole `var...` query with the canonical variable name.

As of 2026-06-12, Tupy contributes a language-specific default that keeps the suggest widget visible when inline suggestions are present:

```json
"[tupy]": {
  "editor.inlineSuggest.suppressSuggestions": false
}
```

The extension also re-triggers VS Code's suggest widget while the active caret remains inside a `var.` inline query, which helps keep the inline search completion UI visible when Copilot ghost text appears.

