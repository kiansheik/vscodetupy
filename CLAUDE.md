# Claude Code instructions

Read `AGENTS.md` first. This repository provides the VS Code editing and review experience for Old Tupi source authoring.

The sibling `../oldtupicorpus` repository owns canonical source records, rendering, verification, and the local MCP server. Keep this extension focused on UI, prompt handoff, source navigation, and explicit user approval.

When changing authoring functionality:

- do not duplicate ground-truth or grammar logic in TypeScript;
- make agent proposals and approved changes visibly distinct;
- keep MCP-driven context and candidate rendering read-only until the human clicks an explicit apply action;
- never implement automatic target replacement or automatic `nhe-enga` edits.
