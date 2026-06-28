import * as vscode from 'vscode';
import { ExpressionHintController } from './expressionHints';
import { WorkspaceLexicon, isTupyDocument } from './indexer';
import { PythonLexiconEvaluator } from './runtimePython';
import { escapeSnippet, normalizeForSearch, suggestIdentifier } from './text';
import { LexiconEntry } from './types';

const CONSTRUCTOR_CHOICES = ['Noun', 'Verb', 'ProperNoun', 'Adverb', 'Interjection', 'Postposition', 'Conjunction'];
const IDENTIFIER_PATTERN = /[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*/u;
const TOP_LEVEL_ASSIGNMENT_PATTERN =
  /^([$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*)\s*(?::[^=]+)?=\s*/u;
const COMPLETION_TRIGGERS = [
  ...new Set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_áéíóúãẽĩõũâêîôûçÁÉÍÓÚÃẼĨÕŨÂÊÎÔÛÇ.-' ".split('')
  )
];
const BUILTIN_CHAT_OPEN_COMMAND = 'workbench.action.chat.open';
const BUILTIN_CHAT_SUBMIT_COMMAND = 'workbench.action.chat.submit';
const CHAT_OPEN_FALLBACK_COMMANDS = ['chatgpt.newCodexPanel', 'chatgpt.openSidebar', 'chatgpt.newChat'];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('VSCode Tupy');
  const pythonEvaluator = new PythonLexiconEvaluator(context.extensionUri, output);
  const lexicon = new WorkspaceLexicon(pythonEvaluator);
  const expressionHints = new ExpressionHintController(pythonEvaluator);
  await lexicon.initialize();

  const viewProvider = new TupyLexiconViewProvider(context.extensionUri, lexicon);
  let inlineQuerySuggestTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleInlineQuerySuggest = (editor = vscode.window.activeTextEditor): void => {
    if (!editor || !isTupyDocument(editor.document)) {
      return;
    }

    if (!varQueryContext(editor.document, editor.selection.active)) {
      return;
    }

    if (inlineQuerySuggestTimer) {
      clearTimeout(inlineQuerySuggestTimer);
    }

    inlineQuerySuggestTimer = setTimeout(() => {
      inlineQuerySuggestTimer = undefined;
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor || !isTupyDocument(activeEditor.document)) {
        return;
      }

      if (varQueryContext(activeEditor.document, activeEditor.selection.active)) {
        void vscode.commands.executeCommand('editor.action.triggerSuggest');
      }
    }, 25);
  };

  context.subscriptions.push(
    output,
    new vscode.Disposable(() => {
      if (inlineQuerySuggestTimer) {
        clearTimeout(inlineQuerySuggestTimer);
      }
    }),
    expressionHints,
    vscode.languages.registerCodeLensProvider({ language: 'tupy' }, expressionHints),
    vscode.languages.registerHoverProvider({ language: 'tupy' }, new TupyHoverProvider(lexicon)),
    vscode.window.registerWebviewViewProvider('tupy.lexiconView', viewProvider),
    vscode.languages.registerCompletionItemProvider(
      { language: 'tupy' },
      new TupyCompletionProvider(lexicon),
      ...COMPLETION_TRIGGERS
    ),
    vscode.commands.registerCommand('tupy.refreshIndex', async () => {
      await lexicon.initialize();
      vscode.window.setStatusBarMessage('Tupy lexicon index refreshed.', 2500);
    }),
    vscode.commands.registerCommand('tupy.insertDefinitionSkeleton', async (seed?: string) => {
      await insertDefinitionSkeleton(seed);
    }),
    vscode.commands.registerCommand('tupy.moveStandaloneDefinitionsToLexicon', async () => {
      await moveStandaloneDefinitionsToLexicon(lexicon);
    }),
    vscode.commands.registerCommand(ExpressionHintController.actionCommand, async (request?: ExpressionTranslationRequest) => {
      await openExpressionTranslation(request);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('tupy')) {
        void lexicon.initialize();
        expressionHints.schedule();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void lexicon.initialize();
      expressionHints.schedule();
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      expressionHints.schedule(editor);
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      expressionHints.schedule(event.textEditor);
      scheduleInlineQuerySuggest(event.textEditor);
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (isTupyDocument(document)) {
        void lexicon.refreshDocument(document, {
          includeRuntime: !document.isDirty && document.uri.scheme === 'file'
        });
        if (vscode.window.activeTextEditor?.document === document) {
          expressionHints.schedule(vscode.window.activeTextEditor);
        }
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isTupyDocument(document)) {
        void lexicon.refreshDocument(document, { includeRuntime: document.uri.scheme === 'file' });
        if (vscode.window.activeTextEditor?.document === document) {
          expressionHints.schedule(vscode.window.activeTextEditor);
        }
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isTupyDocument(event.document)) {
        void lexicon.refreshDocument(event.document, { includeRuntime: false });
        if (vscode.window.activeTextEditor?.document === event.document) {
          expressionHints.schedule(vscode.window.activeTextEditor);
          scheduleInlineQuerySuggest(vscode.window.activeTextEditor);
        }
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      for (const uri of event.files) {
        lexicon.removeUri(uri);
      }
    }),
    lexicon.onDidChangeEntries(() => {
      viewProvider.refresh();
    })
  );

  expressionHints.schedule(vscode.window.activeTextEditor);
}

export function deactivate(): void {
  // No cleanup required beyond the registered subscriptions.
}

class TupyCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly lexicon: WorkspaceLexicon) {}

  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const inlineQuery = varQueryContext(document, position);
    if (inlineQuery) {
      return this.provideInlineQueryItems(inlineQuery);
    }

    const prefix = identifierPrefix(document.lineAt(position).text, position.character);
    const query = normalizeForSearch(prefix);
    const items: vscode.CompletionItem[] = [];

    for (const constructor of CONSTRUCTOR_CHOICES) {
      if (query && !normalizeForSearch(constructor).startsWith(query)) {
        continue;
      }
      const item = new vscode.CompletionItem(constructor, vscode.CompletionItemKind.Class);
      item.insertText = new vscode.SnippetString(`${constructor}("\${1:orthography}", definition="\${2:definition}")`);
      item.detail = 'Tupy constructor';
      item.sortText = `0_${constructor}`;
      items.push(item);
    }

    for (const entry of this.lexicon.getAllEntries()) {
      if (query && !normalizeForSearch(entry.name).startsWith(query) && !normalizeForSearch(entry.orthography).startsWith(query)) {
        continue;
      }
      const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.Variable);
      item.insertText = entry.name;
      item.detail = `${entry.kind} - ${entry.orthography}`;
      item.documentation = entry.definition;
      item.sortText = `1_${entry.name}`;
      items.push(item);
    }

    return items;
  }

  private provideInlineQueryItems(context: VarQueryContext): vscode.CompletionItem[] {
    const matches = this.lexicon.search(context.query, 100);

    return matches.map((entry, index) => {
      const item = new vscode.CompletionItem(
        {
          label: entry.name,
          description: entry.orthography
        },
        vscode.CompletionItemKind.Reference
      );

      item.range = context.range;
      item.insertText = entry.name;
      item.filterText = context.filterText;
      item.detail = `${entry.kind} - ${entry.orthography}`;
      item.documentation = entry.definition;
      item.sortText = `0_${index.toString().padStart(4, '0')}`;
      item.preselect = index === 0;
      return item;
    });
  }
}

class TupyLexiconViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private query = '';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly lexicon: WorkspaceLexicon
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
        case 'search':
          this.query = typeof message.query === 'string' ? message.query : '';
          this.postResults();
          return;
        case 'openEntry': {
          const entry = this.lexicon.getEntry(String(message.id));
          if (entry) {
            await openEntry(entry);
          }
          return;
        }
        case 'insertText': {
          if (typeof message.text === 'string') {
            await insertText(message.text);
          }
          return;
        }
        case 'insertDefinition': {
          await insertDefinitionSkeleton(typeof message.query === 'string' ? message.query : '');
          return;
        }
        default:
          return;
      }
    });

    this.postResults();
  }

  refresh(): void {
    this.postResults();
  }

  private postResults(): void {
    if (!this.view) {
      return;
    }

    const allMatches = this.lexicon.search(this.query, Number.MAX_SAFE_INTEGER);
    const items = allMatches.slice(0, 100).map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      orthography: entry.orthography,
      definition: entry.definition,
      location: `${vscode.workspace.asRelativePath(entry.uri, false)}:${entry.line}`
    }));

    this.view.webview.postMessage({
      type: 'results',
      query: this.query,
      items,
      total: allMatches.length
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'view.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'view.css'));
    const nonce = createNonce();

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Tupy Lexicon</title>
  </head>
  <body>
    <main>
      <div class="header">
        <div class="title">Lexicon Search</div>
        <div class="subtitle">Search indexed orthographic forms and jump to their definitions while you transcribe.</div>
      </div>
      <input id="search" class="search" type="search" placeholder="Search orthography, variable, or gloss" />
      <div id="meta" class="meta"></div>
      <section id="results" class="results"></section>
    </main>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

class TupyHoverProvider implements vscode.HoverProvider {
  constructor(private readonly lexicon: WorkspaceLexicon) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const range = document.getWordRangeAtPosition(position, IDENTIFIER_PATTERN);
    if (!range) {
      return undefined;
    }

    const identifier = document.getText(range);
    const entry = bestHoverEntry(this.lexicon.getAllEntries(), identifier, document.uri, position.line + 1);
    if (!entry) {
      return undefined;
    }

    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`**${escapeMarkdown(entry.name)}**  \n`);
    markdown.appendMarkdown(`${escapeMarkdown(entry.kind)} - ${escapeMarkdown(entry.orthography)}  \n`);
    if (entry.definition) {
      markdown.appendMarkdown(`${escapeMarkdown(entry.definition)}  \n`);
    }
    markdown.appendMarkdown(`${escapeMarkdown(vscode.workspace.asRelativePath(entry.uri, false))}:${entry.line}`);
    return new vscode.Hover(markdown, range);
  }
}

function identifierPrefix(line: string, position: number): string {
  let start = position;
  while (start > 0 && /[$_\u200C\u200D\p{ID_Continue}]/u.test(line[start - 1])) {
    start -= 1;
  }
  return line.slice(start, position);
}

function varQueryContext(document: vscode.TextDocument, position: vscode.Position): VarQueryContext | undefined {
  const linePrefix = document.lineAt(position).text.slice(0, position.character);
  const markerIndex = linePrefix.lastIndexOf('var.');
  if (markerIndex === -1) {
    return undefined;
  }

  if (markerIndex > 0 && /[$_\u200C\u200D\p{ID_Continue}.]/u.test(linePrefix[markerIndex - 1])) {
    return undefined;
  }

  const range = new vscode.Range(position.line, markerIndex, position.line, position.character);
  return {
    filterText: linePrefix.slice(markerIndex),
    query: linePrefix.slice(markerIndex + 4),
    range
  };
}

async function insertDefinitionSkeleton(seed?: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Open a .tu.py file to insert a Tupy definition.');
    return;
  }

  const orthography = (seed ?? '').trim();
  const identifier = suggestIdentifier(orthography || 'entry');
  const defaultOrthography = escapeSnippet(orthography);
  const snippet = new vscode.SnippetString(
    `${identifier} = \${1|${CONSTRUCTOR_CHOICES.join(',')}|}("${defaultOrthography}", definition="\${2}")$0`
  );

  await editor.insertSnippet(snippet, editor.selection.active);
}

async function insertText(text: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  await editor.insertSnippet(new vscode.SnippetString(escapeSnippet(text)), editor.selection.active);
}

async function openEntry(entry: LexiconEntry): Promise<void> {
  const document = await vscode.workspace.openTextDocument(entry.uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const position = new vscode.Position(Math.max(0, entry.line - 1), 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

async function openExpressionTranslation(request?: ExpressionTranslationRequest): Promise<void> {
  if (!request?.prompt) {
    vscode.window.showInformationMessage(
      `${request?.title ?? 'This expression'} does not expose translation_prompt(...).`
    );
    return;
  }

  const commands = new Set(await vscode.commands.getCommands(true));
  if (commands.has(BUILTIN_CHAT_OPEN_COMMAND)) {
    try {
      await vscode.commands.executeCommand(BUILTIN_CHAT_OPEN_COMMAND, {
        mode: 'agent',
        query: request.prompt,
        isPartialQuery: true
      });

      if (commands.has(BUILTIN_CHAT_SUBMIT_COMMAND)) {
        await delay(75);
        await vscode.commands.executeCommand(BUILTIN_CHAT_SUBMIT_COMMAND);
      }

      return;
    } catch {
      // Fall through to the clipboard-backed handoff below.
    }
  }

  await vscode.env.clipboard.writeText(request.prompt);
  for (const command of CHAT_OPEN_FALLBACK_COMMANDS) {
    if (!commands.has(command)) {
      continue;
    }

    try {
      await vscode.commands.executeCommand(command);
      vscode.window.showInformationMessage('Translation prompt copied to the clipboard and AI chat opened.');
      return;
    } catch {
      // Try the next available chat surface.
    }
  }

  const choice = await vscode.window.showInformationMessage(
    'Translation prompt copied to the clipboard. No AI chat command was available to open automatically.',
    'Open Command Palette'
  );
  if (choice) {
    await vscode.commands.executeCommand('workbench.action.showCommands');
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function moveStandaloneDefinitionsToLexicon(lexicon: WorkspaceLexicon): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isTupyDocument(editor.document)) {
    vscode.window.showInformationMessage('Open a .tu.py file to move standalone definitions into the lexicon.');
    return;
  }

  const document = editor.document;
  const definitions = extractStandaloneDefinitions(document);
  if (!definitions.length) {
    vscode.window.showInformationMessage('No standalone top-level definitions were found to move into the lexicon.');
    return;
  }

  const lexiconUri = await resolveLexiconUri(document);
  if (!lexiconUri) {
    vscode.window.showErrorMessage('Unable to determine which lexicon file should receive these definitions.');
    return;
  }

  const lexiconDocument = await vscode.workspace.openTextDocument(lexiconUri);
  const lexiconText = lexiconDocument.getText();
  const insertionOffset = findLexiconInsertionOffset(lexiconText);
  const insertionPosition = lexiconDocument.positionAt(insertionOffset);
  const insertionText = buildLexiconInsertion(lexiconText, insertionOffset, definitions);

  const edit = new vscode.WorkspaceEdit();
  edit.insert(lexiconUri, insertionPosition, insertionText);
  for (const definition of [...definitions].reverse()) {
    edit.delete(document.uri, definition.range);
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    vscode.window.showErrorMessage('VS Code rejected the lexicon update edit.');
    return;
  }

  await lexiconDocument.save();
  await document.save();
  await lexicon.initialize();

  vscode.window.showInformationMessage(
    `Moved ${definitions.length} standalone definition${definitions.length === 1 ? '' : 's'} into ${vscode.workspace.asRelativePath(lexiconUri, false)}.`
  );
}

function createNonce(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let value = '';
  for (let index = 0; index < 32; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

interface VarQueryContext {
  filterText: string;
  query: string;
  range: vscode.Range;
}

interface DefinitionBlock {
  name: string;
  text: string;
  range: vscode.Range;
}

interface ExpressionTranslationRequest {
  prompt?: string;
  title?: string;
}

function bestHoverEntry(
  entries: LexiconEntry[],
  identifier: string,
  documentUri: vscode.Uri,
  line: number
): LexiconEntry | undefined {
  const needle = normalizeForSearch(identifier);
  const matches = entries.filter((entry) => normalizeForSearch(entry.name) === needle);
  if (!matches.length) {
    return undefined;
  }

  return matches.sort((left, right) => compareHoverEntries(left, right, documentUri, line))[0];
}

function compareHoverEntries(
  left: LexiconEntry,
  right: LexiconEntry,
  documentUri: vscode.Uri,
  line: number
): number {
  const leftLocal = left.uri.toString() === documentUri.toString();
  const rightLocal = right.uri.toString() === documentUri.toString();
  if (leftLocal !== rightLocal) {
    return leftLocal ? -1 : 1;
  }

  const leftDistance = Math.abs(left.line - line);
  const rightDistance = Math.abs(right.line - line);
  if (leftDistance !== rightDistance) {
    return leftDistance - rightDistance;
  }

  return left.name.localeCompare(right.name);
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}

function extractStandaloneDefinitions(document: vscode.TextDocument): DefinitionBlock[] {
  const text = document.getText();
  const blocks: DefinitionBlock[] = [];

  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber += 1) {
    const line = document.lineAt(lineNumber);
    if (line.firstNonWhitespaceCharacterIndex !== 0) {
      continue;
    }

    const match = line.text.match(TOP_LEVEL_ASSIGNMENT_PATTERN);
    if (!match || line.text.includes('+=')) {
      continue;
    }

    const [matchedText, name] = match;
    const statementStart = line.range.start;
    const statementEndOffset = findStatementEndOffset(text, document.offsetAt(statementStart));
    const statementEnd = document.positionAt(statementEndOffset);
    const lastStatementLine = document.positionAt(Math.max(statementEndOffset - 1, document.offsetAt(statementStart))).line;
    const statementRange = new vscode.Range(statementStart, statementEnd);
    const statementText = text.slice(document.offsetAt(statementStart), statementEndOffset);
    const rhsPreview = statementText.slice(matchedText.length).trim();

    if (
      name === 'l' ||
      name.startsWith('__') ||
      rhsPreview === 'l' ||
      rhsPreview.startsWith('[')
    ) {
      lineNumber = Math.max(lineNumber, lastStatementLine);
      continue;
    }

    blocks.push({
      name,
      text: statementText.trimEnd(),
      range: statementRange
    });
    lineNumber = Math.max(lineNumber, lastStatementLine);
  }

  return blocks;
}

function findStatementEndOffset(text: string, startOffset: number): number {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: '"' | '\'' | null = null;
  let triple = false;
  let inComment = false;

  for (let index = startOffset; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    const next2 = text[index + 2];

    if (inComment) {
      if (char === '\n' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        return index + 1;
      }
      if (char === '\n') {
        inComment = false;
      }
      continue;
    }

    if (quote) {
      if (char === '\\') {
        index += 1;
        continue;
      }

      if (triple) {
        if (char === quote && next === quote && next2 === quote) {
          quote = null;
          triple = false;
          index += 2;
        }
        continue;
      }

      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '#') {
      inComment = true;
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      triple = next === char && next2 === char;
      if (triple) {
        index += 2;
      }
      continue;
    }

    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === '[') {
      bracketDepth += 1;
      continue;
    }
    if (char === '{') {
      braceDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (char === '\n' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      return index + 1;
    }
  }

  return text.length;
}

async function resolveLexiconUri(document: vscode.TextDocument): Promise<vscode.Uri | undefined> {
  const configuration = vscode.workspace.getConfiguration('tupy', document.uri);
  const configuredPath = configuration.get<string>('lexiconFile', '').trim();
  if (configuredPath) {
    const configuredUri = resolveConfiguredLexiconUri(document, configuredPath);
    if (configuredUri) {
      return configuredUri;
    }
  }

  const importMatch = document.getText().match(/from\s+([A-Za-z_][A-Za-z0-9_\.]*)\.lexicon\s+import\s+load_lexicon/u);
  if (importMatch) {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (workspaceFolder) {
      const candidate = vscode.Uri.joinPath(
        workspaceFolder.uri,
        ...importMatch[1].split('.'),
        'lexicon.tu.py'
      );
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  const candidates = await vscode.workspace.findFiles('**/lexicon.tu.py', '**/{.git,dist,node_modules}/**', 2);
  if (candidates.length === 1) {
    return candidates[0];
  }

  return undefined;
}

function resolveConfiguredLexiconUri(
  document: vscode.TextDocument,
  configuredPath: string
): vscode.Uri | undefined {
  if (configuredPath.startsWith('/')) {
    return vscode.Uri.file(configuredPath);
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return undefined;
  }

  return vscode.Uri.joinPath(workspaceFolder.uri, ...configuredPath.split(/[\\/]+/u));
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function findLexiconInsertionOffset(text: string): number {
  const allMatch = text.match(/^__all__\s*=/mu);
  return allMatch?.index ?? text.length;
}

function buildLexiconInsertion(
  lexiconText: string,
  insertionOffset: number,
  definitions: DefinitionBlock[]
): string {
  const body = definitions.map((definition) => definition.text).join('\n');
  const needsLeadingNewline =
    insertionOffset > 0 &&
    !lexiconText.slice(0, insertionOffset).endsWith('\n\n');
  const suffix = insertionOffset < lexiconText.length ? '\n\n' : '\n';
  return `${needsLeadingNewline ? '\n' : ''}${body}${suffix}`;
}
