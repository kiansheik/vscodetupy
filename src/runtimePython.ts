import * as childProcess from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { LexiconEntry } from './types';

interface RuntimeLexiconPayload {
  entries: RuntimeLexiconEntry[];
  error?: string;
}

interface ExpressionHintPayload {
  hint?: string;
  translationPrompt?: string;
  error?: string;
}

export interface ExpressionHintResult {
  hint: string;
  translationPrompt?: string;
}

interface RuntimeLexiconEntry {
  name: string;
  kind: string;
  orthography: string;
  definition?: string;
  line: number;
  source_path?: string;
}

export class PythonLexiconEvaluator {
  private readonly lexiconHelperPath: string;
  private readonly hintHelperPath: string;

  constructor(
    extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel
  ) {
    this.lexiconHelperPath = vscode.Uri.joinPath(extensionUri, 'scripts', 'extract_runtime_lexicon.py').fsPath;
    this.hintHelperPath = vscode.Uri.joinPath(extensionUri, 'scripts', 'evaluate_expression_hint.py').fsPath;
  }

  isEnabled(): boolean {
    return (
      vscode.workspace.isTrusted &&
      vscode.workspace.getConfiguration('tupy').get<boolean>('enablePythonEvaluation', true)
    );
  }

  async evaluate(uri: vscode.Uri): Promise<LexiconEntry[]> {
    if (!this.isEnabled() || uri.scheme !== 'file') {
      return [];
    }

    const configuration = vscode.workspace.getConfiguration('tupy');
    const interpreter = configuration.get<string>('pythonInterpreter', 'python3').trim() || 'python3';
    const timeout = Math.max(500, configuration.get<number>('pythonEvaluationTimeoutMs', 5000) ?? 5000);

    try {
      const stdout = await execFile(interpreter, [this.lexiconHelperPath, uri.fsPath], {
        cwd: path.dirname(uri.fsPath),
        timeout
      });
      const payload = JSON.parse(stdout) as RuntimeLexiconPayload;

      if (payload.error) {
        this.output.appendLine(`[runtime] ${uri.fsPath}: ${payload.error}`);
        return [];
      }

      return payload.entries.map((entry) => ({
        id: `${(entry.source_path ? vscode.Uri.file(entry.source_path) : uri).toString()}::${entry.name}::${entry.line}`,
        name: entry.name,
        kind: entry.kind,
        orthography: entry.orthography,
        definition: entry.definition,
        uri: entry.source_path ? vscode.Uri.file(entry.source_path) : uri,
        line: entry.line
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[runtime] ${uri.fsPath}: ${message}`);
      return [];
    }
  }

  async evaluateExpressionHint(
    document: vscode.TextDocument,
    closePosition: vscode.Position
  ): Promise<ExpressionHintResult | undefined> {
    if (!this.isEnabled() || document.uri.scheme !== 'file') {
      return undefined;
    }

    const configuration = vscode.workspace.getConfiguration('tupy');
    if (!configuration.get<boolean>('enableExpressionHints', true)) {
      return undefined;
    }

    const interpreter = configuration.get<string>('pythonInterpreter', 'python3').trim() || 'python3';
    const timeout = Math.max(500, configuration.get<number>('pythonEvaluationTimeoutMs', 5000) ?? 5000);
    const translationLanguage =
      configuration.get<string>('translationPromptLanguage', 'English')?.trim() || 'English';

    try {
      const stdout = await execFile(
        interpreter,
        [
          this.hintHelperPath,
          document.uri.fsPath,
          String(closePosition.line + 1),
          String(closePosition.character),
          translationLanguage
        ],
        {
          cwd: path.dirname(document.uri.fsPath),
          timeout,
          input: document.getText()
        }
      );
      const payload = JSON.parse(stdout) as ExpressionHintPayload;
      const hint = payload.hint?.trim();
      if (!hint) {
        return undefined;
      }

      return {
        hint,
        translationPrompt: payload.translationPrompt?.trim() || undefined
      };
    } catch {
      return undefined;
    }
  }
}

function execFile(
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; input?: string }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = childProcess.execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8'
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new Error(detail));
          return;
        }

        resolve(stdout);
      }
    );

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}
