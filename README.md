# vscodetupy

`vscodetupy` is a VS Code extension workspace for transcribing the Tupi corpus in files that end with `.tu.py`.

The first scaffold in this repository does five things:

- registers `*.tu.py` as a dedicated VS Code language named `tupy`
- applies a lightweight Python-like TextMate grammar so the files are readable immediately
- indexes top-level lexical definitions such as `kunumim = Noun("kunumĩ", definition="young boy")`
- optionally executes trusted `.tu.py` files with Python so composed expressions such as `jatf = cop() * (...)` can also be indexed by their resolved orthographic form
- exposes those indexed entries through autocomplete and a searchable side panel

This is the base layer for the more ambitious workflow you described: reusing previously defined lexical variables, finding existing orthographic forms before redefining them, and drafting new entries directly from the editor UI.

## Current behavior

### File association

Any file ending in `.tu.py` is opened as the `tupy` language.

### Syntax highlighting

The grammar is intentionally lightweight for now. It highlights:

- comments
- strings
- numbers
- Python control keywords
- common Tupi constructors such as `Noun`, `Verb`, `ProperNoun`, `Adverb`, `Interjection`, `Postposition`, and `Conjunction`
- assignment targets and function-style calls

This is not a full Python parser yet. It is the minimum useful layer for corpus transcription files.

### Lexicon indexing

The extension scans workspace `.tu.py` files and indexes assignments shaped like:

```python
kunumim = Noun("kunumĩ", definition="young boy")
ikó = Verb("ikó", definition="to live")
pindo = ProperNoun("Pindoba Mirĩ")
```

For each indexed entry it stores:

- variable name
- constructor kind
- orthographic form
- definition, when present
- file and line number

The parser currently focuses on constructor-style top-level assignments because that is the core pattern needed for reuse and search.

### Runtime-enriched indexing

When the workspace is trusted, the extension also runs saved `.tu.py` files through Python and inspects top-level assignments whose resulting values expose an `.eval()` method.

That means expressions like this can appear in search results even though they are not simple constructor calls:

```python
jatf = cop() * (jesus == (pyra * (mombeu / katu))) * (nde * membyra)
```

The runtime extractor resolves that value and indexes its evaluated surface form.

It also indexes imported `Predicate` instances that come from the `pydicate` package, so built-in globals such as `ixé`, `xe`, `saba`, and `supé` are available in both lexicon search and inline `var.` completion even when they are not assigned in the current `.tu.py` file.

This layer is controlled by three settings:

- `tupy.enablePythonEvaluation`
- `tupy.pythonInterpreter`
- `tupy.pythonEvaluationTimeoutMs`

While you are actively editing an unsaved file, new complex expressions wait until save to be resolved. The last successful runtime-derived entries stay in the index until the next save or manual refresh.

### Autocomplete

Inside `.tu.py` files the extension offers completion items for:

- known constructors like `Noun(...)` and `Verb(...)`
- previously indexed lexical variable names from the workspace
- inline lexicon search using `var.<free text query>`

The completion detail shows the constructor kind and orthographic form.

Hovering a known lexical variable also shows its kind, rendered form, definition, and source location.

The inline search syntax is meant to reduce sidebar dependence during transcription:

```python
var.jesus imombe
```

As you type after `var.`, the completion list searches the same indexed fields as the sidebar. Accepting a suggestion replaces the full `var....` block with the canonical variable name.

The sidebar search and the inline `var.` completion now share the same relevance order:

1. exact variable name
2. partial variable name
3. rendered orthographic form
4. definition/gloss text

### Expression hints

When the caret is on, or immediately after, a closing `)`, the extension attempts to evaluate the expression that ends at that scope and shows the result as a faint line above the current line.

This is meant for nested transcription expressions, so stepping across `)))` can show the resolved surface form at each level.

The hint always renders in a dedicated phantom line above the current line so it does not compete with the code layout on the active line.

Longer hints are wrapped into multiple lines rather than shortened aggressively, using an estimated width budget around half the editor width.

If the selected `)` is also the end of an assignment value such as `l += ...`, the hint prefers the full right-hand side even when there is no explicit outer wrapping parenthesis around the whole expression.

The hint is transient:

- it appears only while the caret is at that closing scope
- it disappears when the caret moves away
- it uses the current editor buffer, so saved and unsaved edits are both considered
- it only appears when the current buffer is valid Python and workspace trust is enabled
- it uses the editor CodeLens UI, so `editor.codeLens` must be enabled
- clicking the hint asks the evaluated object for `translation_prompt(...)`, opens VS Code chat, and submits that prompt automatically when the built-in chat commands are available

This layer is controlled by:

- `tupy.enableExpressionHints`
- `tupy.expressionHintMaxLength`
- `tupy.translationPromptLanguage`

If the built-in VS Code chat commands are unavailable, the extension falls back to opening the OpenAI sidebar and copying the translation prompt to the clipboard.

### Move Definitions

When you define new lexicon items inline while drafting a text, you can move them into the canonical lexicon with:

- `Tupy: Move Standalone Definitions To Lexicon`

The command:

- finds top-level `name = ...` definitions in the current `.tu.py` file
- skips transcription lines such as `l += ...`
- appends the definitions to the lexicon file before `__all__`
- removes those definitions from the current file
- saves both files and refreshes the lexicon index

The target lexicon file is inferred from `from ...lexicon import load_lexicon` when possible. You can also set it explicitly with:

- `tupy.lexiconFile`

### Side panel search

The custom `Tupy` sidebar contains a `Lexicon Search` view.

It lets you:

- search by variable name
- search by orthographic form
- search by definition/gloss text
- jump directly to the defining file and line
- insert an existing variable name into the current editor
- insert a draft definition skeleton when the search has no matches

The draft insertion command generates a starter line like this, with a constructor choice snippet:

```python
new_entry = Noun("orthography", definition="")
```

## Repository structure

```text
.
├── .vscode/
│   ├── launch.json          # Launch configuration for Extension Development Host
│   └── tasks.json           # Compile/watch tasks for VS Code
├── examples/
│   └── example.tu.py        # Reference transcription/example format
├── media/
│   ├── tupy.svg             # Sidebar icon
│   ├── view.css             # Lexicon sidebar styling
│   └── view.js              # Lexicon sidebar client script
├── scripts/
│   ├── evaluate_expression_hint.py # Python helper for scoped eval hints and translation prompts
│   └── extract_runtime_lexicon.py  # Python helper for runtime surface-form extraction
├── src/
│   ├── extension.ts         # Activation, commands, completions, webview wiring
│   ├── expressionHints.ts   # Transient scoped eval hints above the active line
│   ├── indexer.ts           # Workspace lexicon indexing and search
│   ├── parser.ts            # Parser for constructor-style assignments
│   ├── runtimePython.ts     # Python subprocess bridge for runtime enrichment
│   ├── text.ts              # Search normalization and identifier helpers
│   └── types.ts             # Shared extension types
├── syntaxes/
│   └── tupy.tmGrammar.json  # Minimal TextMate grammar for `.tu.py`
├── language-configuration.json
├── Makefile
├── package.json
├── tsconfig.json
└── README.md
```

## Development workflow

### 1. Install dependencies

```sh
make install
```

### 2. Compile the extension

```sh
make build
```

### 3. Launch it in VS Code

Option A, from the command line:

```sh
make dev
```

This opens an Extension Development Host using the current workspace as the extension under development.

Option B, from VS Code itself:

1. Open this repository in VS Code.
2. Run the `Run vscodetupy` launch configuration.
3. In the Extension Development Host, open a folder containing `.tu.py` files.

### 4. Package a VSIX

```sh
make package
```

## Make targets

- `make install`: install npm dependencies
- `make build`: compile TypeScript into `dist/`
- `make watch`: run TypeScript in watch mode
- `make dev`: compile and open an Extension Development Host
- `make package`: create a `.vsix` package
- `make clean`: remove build artifacts

## How to use the first scaffold

1. Open a workspace with `.tu.py` files.
2. Open the `Tupy` activity bar icon.
3. Search for an orthographic form before creating a new lexical entry.
4. If an entry already exists, use `Insert name` or jump to it with `Open`.
5. If it does not exist, use `Insert draft definition` and fill out the generated constructor snippet.
6. Save the file. The index refreshes automatically on edit and save.
7. If the file is valid Python and workspace trust is enabled, complex composed assignments are added to search after save as well.

## Example

The repository includes `examples/example.tu.py`, which demonstrates the current `.tu.py` style and gives the parser enough real data to exercise indexing and search.

## Next practical steps

The current scaffold is intentionally narrow. The next high-value improvements are:

1. replace the regex parser with a proper Python AST or tree-sitter based parser so nested and non-trivial constructs are handled safely
2. track lexical scope and local redefinitions so completion ranking is context-aware
3. add a richer entry creation flow in the sidebar with editable fields instead of only snippet insertion
4. persist a dedicated lexicon cache or export format for reuse across projects
5. add integration tests using VS Code extension test tooling
