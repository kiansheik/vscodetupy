# VSCode Tupy Agent Rules

This extension is the editor and review surface for Old Tupi corpus work. It must not become the authoritative store for historical targets or grammatical decisions.

## Architecture

- Canonical source records, rendering, verification, and MCP tools belong in the sibling `../oldtupicorpus` repository.
- This extension may display those results, launch commands, compose prompts, and apply user-approved edits.
- Do not duplicate morphology rules, target records, or source-line metadata in TypeScript.

## Source authoring UX

- Keep the human approval boundary visible. An agent proposal or a rendered match must never look like an approved historical analysis.
- Prefer read-only context, candidate rendering, target/output comparisons, and explicit approve/apply commands.
- Prompt handoffs must tell agents to use `oldtupi-authoring` MCP tools before proposing edits.
- Do not add automatic target replacement or automatic `nhe-enga` edits.

## Safety

- Python evaluation is only for trusted workspaces.
- Keep candidate evaluation separate from applied source edits.
- Preserve the existing lightweight, responsive editor behavior. Do not make indexing or cursor hints wait on an AI request.
