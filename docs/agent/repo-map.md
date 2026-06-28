# Repo Map

- `package.json`: VS Code extension manifest, activation events, contributed language, views, commands, settings, and npm scripts.
- `src/extension.ts`: activation, command registration, completion provider, hover provider, sidebar webview provider, inline search behavior, and definition-moving command.
- `src/indexer.ts`: workspace `.tu.py` lexicon indexing, runtime/static entry merging, search ranking.
- `src/parser.ts`: static extraction of lexicon entries from `.tu.py` source.
- `src/runtimePython.ts`: optional trusted Python evaluation for complex lexicon expressions.
- `src/expressionHints.ts`: expression evaluation hints and related code lenses.
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

