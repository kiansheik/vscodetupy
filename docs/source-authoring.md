# Human-led source authoring in VS Code

Use `Tupy: Start Human-Led Source Authoring` from the Command Palette while a `.tu.py` source is open.

The command asks for the historic source name and source-record id or ordinal. It then opens VS Code chat with a task prompt that requires the agent to:

1. retrieve source context and precedents through the local `oldtupi-authoring` MCP server;
2. propose a candidate Pydicate expression and alternatives;
3. render the candidate before making any edit;
4. keep historical analysis and target approval with the human editor.

The extension does not store source truth. The sibling `../oldtupicorpus` checkout owns records, rendering, verification, and the MCP server.

The first integration is intentionally prompt-oriented. It does not apply edits, replace targets, or request morphology-engine changes automatically. Future work can display the same structured context in a dedicated Source Authoring sidebar.
