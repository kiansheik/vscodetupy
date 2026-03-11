import * as vscode from 'vscode';
import { ExpressionHintController } from './expressionHints';
import { WorkspaceLexicon, isTupyDocument } from './indexer';
import { PythonLexiconEvaluator } from './runtimePython';
import { escapeSnippet, normalizeForSearch, suggestIdentifier } from './text';
import { LexiconEntry } from './types';

const CONSTRUCTOR_CHOICES = ['Noun', 'Verb', 'ProperNoun', 'Adverb', 'Interjection', 'Postposition', 'Conjunction'];
const COMPLETION_TRIGGERS = [
  ...new Set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_áéíóúãẽĩõũâêîôûçÁÉÍÓÚÃẼĨÕŨÂÊÎÔÛÇ.-' ".split('')
  )
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('VSCode Tupy');
  const pythonEvaluator = new PythonLexiconEvaluator(context.extensionUri, output);
  const lexicon = new WorkspaceLexicon(pythonEvaluator);
  const expressionHints = new ExpressionHintController(pythonEvaluator);
  await lexicon.initialize();

  const viewProvider = new TupyLexiconViewProvider(context.extensionUri, lexicon);

  context.subscriptions.push(
    output,
    expressionHints,
    vscode.languages.registerCodeLensProvider({ language: 'tupy' }, expressionHints),
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
    vscode.commands.registerCommand(ExpressionHintController.noopCommand, () => {
      // Keeps the transient CodeLens hint non-actionable while satisfying the API contract.
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
