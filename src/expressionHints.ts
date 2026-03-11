import * as vscode from 'vscode';
import { isTupyDocument } from './indexer';
import { PythonLexiconEvaluator } from './runtimePython';

const HINT_DEBOUNCE_MS = 150;
const HINT_NOOP_COMMAND = 'tupy.expressionHintNoop';

interface ActiveHint {
  documentUri: string;
  line: number;
  text: string;
}

export class ExpressionHintController
  implements vscode.CodeLensProvider, vscode.Disposable
{
  readonly onDidChangeCodeLenses: vscode.Event<void>;

  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  private pendingTimer?: NodeJS.Timeout;
  private requestId = 0;
  private activeHint?: ActiveHint;

  constructor(private readonly evaluator: PythonLexiconEvaluator) {
    this.onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;
  }

  schedule(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
    }

    this.pendingTimer = setTimeout(() => {
      void this.render(editor);
    }, HINT_DEBOUNCE_MS);
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.activeHint || document.uri.toString() !== this.activeHint.documentUri || !this.isEnabled()) {
      return [];
    }

    const line = document.lineAt(this.activeHint.line);
    return [
      new vscode.CodeLens(line.range, {
        title: this.activeHint.text,
        command: HINT_NOOP_COMMAND,
        tooltip: 'Evaluated surface form'
      })
    ];
  }

  dispose(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
    }
    this.updateHint(undefined);
    this.onDidChangeCodeLensesEmitter.dispose();
  }

  private async render(editor: vscode.TextEditor | undefined): Promise<void> {
    const requestId = ++this.requestId;

    if (!editor || !isTupyDocument(editor.document) || !this.isEnabled()) {
      this.updateHint(undefined);
      return;
    }

    const context = closingParenContext(editor.document, editor.selection.active);
    if (!context) {
      this.updateHint(undefined);
      return;
    }

    const hint = await this.evaluator.evaluateExpressionHint(editor.document, context.closePosition);
    if (requestId !== this.requestId || vscode.window.activeTextEditor !== editor) {
      return;
    }

    const refreshedContext = closingParenContext(editor.document, editor.selection.active);
    if (
      !hint ||
      !refreshedContext ||
      !refreshedContext.closePosition.isEqual(context.closePosition)
    ) {
      this.updateHint(undefined);
      return;
    }

    this.updateHint({
      documentUri: editor.document.uri.toString(),
      line: context.closePosition.line,
      text: formatHint(editor, hint)
    });
  }

  private updateHint(nextHint: ActiveHint | undefined): void {
    const changed =
      !sameHint(this.activeHint, nextHint);

    this.activeHint = nextHint;

    if (changed) {
      this.onDidChangeCodeLensesEmitter.fire();
    }
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration('tupy').get<boolean>('enableExpressionHints', true);
  }

  static readonly noopCommand = HINT_NOOP_COMMAND;
}

function closingParenContext(
  document: vscode.TextDocument,
  position: vscode.Position
): { closePosition: vscode.Position } | undefined {
  const line = document.lineAt(position.line).text;

  if (position.character < line.length && line[position.character] === ')') {
    return { closePosition: position };
  }

  if (position.character > 0 && line[position.character - 1] === ')') {
    return { closePosition: position.translate(0, -1) };
  }

  return undefined;
}

function formatHint(editor: vscode.TextEditor, hint: string): string {
  const compact = hint.replace(/\s+/g, ' ').trim();
  const maxLength = Math.max(
    60,
    vscode.workspace.getConfiguration('tupy').get<number>('expressionHintMaxLength', 240) ?? 240
  );
  const visible = compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1).trimEnd()}…`;
  return `=> ${wrapHint(visible, hintWrapColumns(editor))}`;
}

function hintWrapColumns(editor: vscode.TextEditor): number {
  const editorConfiguration = vscode.workspace.getConfiguration('editor', editor.document.uri);
  const wrapColumn = editorConfiguration.get<number>('wordWrapColumn', 100) ?? 100;
  return Math.max(30, Math.floor(Math.max(60, wrapColumn) / 2));
}

function wrapHint(text: string, columns: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
      continue;
    }

    if (currentLine.length + 1 + word.length <= columns) {
      currentLine += ` ${word}`;
      continue;
    }

    lines.push(currentLine);
    currentLine = word;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines.join('\n');
}

function sameHint(left: ActiveHint | undefined, right: ActiveHint | undefined): boolean {
  if (!left || !right) {
    return left === right;
  }

  return left.documentUri === right.documentUri && left.line === right.line && left.text === right.text;
}
