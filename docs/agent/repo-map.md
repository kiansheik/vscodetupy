# Repo Map

- `package.json`: VS Code extension manifest, activation events, contributed language, views, commands, settings, and npm scripts.
- `src/extension.ts`: activation, command registration, completion provider, hover provider, sidebar webview provider, inline search behavior, and definition-moving command.
- `src/indexer.ts`: workspace `.tu.py` lexicon indexing, runtime/static entry merging, search ranking.
- `src/parser.ts`: static extraction of lexicon entries from `.tu.py` source.
- `src/runtimePython.ts`: optional trusted Python evaluation for complex lexicon expressions.
- `src/expressionHints.ts`: expression evaluation hints and related code lenses.
- `src/groundTruthStatus.ts`: light per-line ground-truth status decorations (verified/mismatch/unaccounted) for historic `.tu.py` sources, plus two CodeLens/right-click actions: "Correct ground truth…" copies a fix-it prompt for AI chat to the clipboard, and "✓ Commit ground truth" approves the current rendering as that one line's ground truth. Calls the sibling `oldtupicorpus` checkout via `scripts/ground_truth_status.py` and `scripts/commit_ground_truth.py`; never edits `.tu.py` source itself.
- `src/text.ts`: text normalization, snippet escaping, and identifier suggestion helpers.
- `src/types.ts`: shared lexicon entry types.
- `media/view.js` and `media/view.css`: sidebar lexicon search webview behavior and styling.
- `syntaxes/tupy.tmGrammar.json`: TextMate grammar.
- `examples/example.tu.py`: example Tupy source used for manual behavior checks.
- `dist/`: generated build output, ignored by Git.

Useful commands:

```sh
npm run compile
```

