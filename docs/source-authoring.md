# Human-led source authoring in VS Code

Use `Tupy: Start Human-Led Source Authoring` from the Command Palette while a `.tu.py` source is open.

The command asks for the historic source name and source-record id or ordinal. It then opens VS Code chat with a task prompt that requires the agent to:

1. retrieve source context and precedents through the local `oldtupi-authoring` MCP server;
2. propose a candidate Pydicate expression and alternatives;
3. render the candidate before making any edit;
4. keep historical analysis and target approval with the human editor.

The extension does not store source truth. The sibling `../oldtupicorpus` checkout owns records, rendering, verification, and the MCP server.

The first integration is intentionally prompt-oriented. It does not apply edits, replace targets, or request morphology-engine changes automatically. Future work can display the same structured context in a dedicated Source Authoring sidebar.

## Ground-truth status markers

Open a `.tu.py` file that lives at `historic/<source>.tu.py` inside an `oldtupicorpus` checkout (a sibling `../oldtupicorpus`, or any ancestor folder containing `authoring/service.py`; override with `tupy.corpusPath`) and each source-list line gets a light background tint:

- **verified** (green) — an approved ground-truth record exists and the current rendering matches it.
- **not yet accounted for** (blue) — no ground-truth record exists yet at that position.
- **mismatch** (red) — an approved record exists but the current rendering no longer matches it.

Hovering a line shows the rendered/target detail. A multi-line expression (e.g. `l += (...)` spanning several lines) is tinted across its whole span, not just its first line.

This reads `authoring.service.line_status_for_text(...)` in the sibling repo against your live, unsaved buffer (piped over stdin to a throwaway temp file — the real file on disk is never written by this check) and does not duplicate ground-truth or grammar logic in this extension. It refreshes shortly after you stop typing (debounced, not on every keystroke) and immediately on editor switch. Toggle it off with `tupy.enableGroundTruthStatus`.

## Correcting a mismatched or unaccounted line

Placing the caret on a tracked line shows a `Correct ground truth…` CodeLens alongside the existing expression-hint lens; it's also on the editor right-click menu for `.tu.py` files (resolved from the caret line, so it works without a CodeLens click too). Selecting it asks for the surface form the line should have produced and an optional linguist explanation, then copies a task prompt to the clipboard — paste it into whichever AI chat you want. It never opens or submits a chat panel itself.

This is a bug-report flow against the sibling `../nhe-enga` grammar engine (pydicate/tupi), not a "make this line render some text" flow. The linguist's explanation describes a grammatical rule, so the prompt instructs the agent to:

1. inspect the record with the read-only `oldtupi-authoring` MCP tools first (`get_source_context`, `search_lexicon`, `search_rendered_expressions`, `render_candidate`, `line_status`, `verify_ground_truth`, `reload_engine`);
2. treat the Pydicate expression for this line as canonical and never edit it — in particular, never fabricate a new inline lexicon entry (a throwaway `Noun(...)`/`Verb(...)`) just because it happens to render the target text, since that discards the linguistic claim the expression was making. If the agent becomes convinced the expression itself is wrong, it's told to stop and say so rather than change it — that call belongs to the human;
3. read `../nhe-enga/docs/agent/grammar-navigation.md` first — a living, cross-session map from grammatical phenomenon to where it's implemented in pydicate/tupi — instead of searching blind;
4. find the actual rule in `../nhe-enga` responsible for the behavior, comparing renders to the corrected form with whitespace ignored (only the sequence of words matters, not the linguist's typed spacing);
5. **stop and wait for explicit human approval exactly once**: explain why the bug is happening and what it intends to change, and show the potential changelog (a diff preview), before writing anything. The prompt tells the agent to arrive at this checkpoint only once, with a diagnosis it's actually confident in, rather than using the review cycle to debug;
6. once approved, apply the fix and drive it to done without further check-ins — after every edit to `../nhe-enga`, call `reload_engine` before the next render or verification call. The authoring MCP server is a long-lived process that caches the engine modules in memory, so a bare re-render after an engine edit silently re-tests the *old* code; this was the main source of wasted iteration before `reload_engine` existed (see `oldtupicorpus`'s `docs/agent/session-handoffs/2026-09-16-og-pluriform-prefix.md`). A fix that still doesn't match after a reload means the rule lives somewhere else, not that the same spot needs another tweak;
7. once it matches, re-run `verify_ground_truth`/`line_status` across all sources (after another `reload_engine`) and keep fixing and re-checking until that full regression check is clean — an engine change can have wide blast radius, and the agent is told not to stop at a partially-passing state;
8. update `../nhe-enga/docs/agent/grammar-navigation.md` with what it found, so the next agent (on this bug or a related one) starts further ahead;
9. explain in plain terms why the original rendering was wrong and why the fix works, flagging it if the fix doesn't make obvious grammatical sense even though it renders correctly;
10. hand the line back for a human to click "Commit ground truth" (below) rather than approving it itself — that action is deliberately not exposed as an MCP tool.

This extension never applies the fix itself — it only composes the prompt and copies it to the clipboard. `nhe-enga/docs/agent/grammar-navigation.md` is a plain file in that sibling checkout; nothing in this extension reads or writes it directly.

## Committing an already-correct line

When a tracked line is **not yet accounted for**, or is a **mismatch** with no previously declared target (just a stale baked-in rendering), a second `✓ Commit ground truth` CodeLens/right-click action appears. It asks for a one-click confirmation showing the exact surface form, saves the document if needed, then calls `authoring.service.commit_ground_truth(source, ordinal)` in the sibling repo (via `scripts/commit_ground_truth.py`) to approve *only that line's* current rendering as its ground-truth record — never a whole-source regenerate, so it can't silently bless neighboring unreviewed lines. The line turns green immediately after.

This is a human-only action: it is never exposed as an MCP tool, so an agent working the correction flow above cannot approve its own fix — it can only get the line ready and tell you to click Commit. The sibling service also refuses the commit server-side if the line already declares a target (`normalized_target`) the current rendering doesn't match, so this can never silently overwrite a linguist's declared-correct form.
