import * as path from 'path';
import * as vscode from 'vscode';
import { isTupyDocument } from './indexer';
import { execFile } from './runtimePython';

const STATUS_REFRESH_DEBOUNCE_MS = 600;
const CORRECTION_COMMAND = 'tupy.correctGroundTruthLine';
const COMMIT_COMMAND = 'tupy.commitGroundTruthLine';

type GroundTruthLineStatus = 'verified' | 'mismatch' | 'unaccounted';

interface GroundTruthLine {
  ordinal: number;
  source_line: number;
  end_line: number;
  status: GroundTruthLineStatus;
  rendered: string | null;
  target: string | null;
  declared_target: string | null;
}

interface GroundTruthPayload {
  source?: string;
  lines?: GroundTruthLine[];
  error?: string;
}

interface DocumentStatus {
  source: string;
  lines: GroundTruthLine[];
}

interface CorrectionRequest {
  documentUri: string;
  source: string;
  ordinal: number;
  sourceLine: number;
  endLine: number;
  status: GroundTruthLineStatus;
  rendered: string | null;
  target: string | null;
  declaredTarget: string | null;
}

interface CommitPayload {
  ok: boolean;
  committed_surface?: string;
  error?: string;
}

export class GroundTruthStatusController implements vscode.CodeLensProvider, vscode.Disposable {
  readonly onDidChangeCodeLenses: vscode.Event<void>;

  private readonly scriptPath: string;
  private readonly commitScriptPath: string;
  private readonly verifiedDecoration: vscode.TextEditorDecorationType;
  private readonly mismatchDecoration: vscode.TextEditorDecorationType;
  private readonly unaccountedDecoration: vscode.TextEditorDecorationType;
  private readonly statusByDocument = new Map<string, DocumentStatus>();
  private readonly onDidChangeCodeLensesEmitter = new vscode.EventEmitter<void>();
  private pendingTimer?: NodeJS.Timeout;
  private requestId = 0;

  constructor(
    extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel
  ) {
    this.scriptPath = vscode.Uri.joinPath(extensionUri, 'scripts', 'ground_truth_status.py').fsPath;
    this.commitScriptPath = vscode.Uri.joinPath(extensionUri, 'scripts', 'commit_ground_truth.py').fsPath;
    this.onDidChangeCodeLenses = this.onDidChangeCodeLensesEmitter.event;

    this.verifiedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(90, 190, 120, 0.08)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      overviewRulerColor: 'rgba(90, 190, 120, 0.7)'
    });
    this.mismatchDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(224, 90, 90, 0.14)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      overviewRulerColor: 'rgba(224, 90, 90, 0.85)'
    });
    this.unaccountedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(100, 149, 237, 0.09)',
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      overviewRulerColor: 'rgba(100, 149, 237, 0.65)'
    });

    vscode.commands.registerCommand(CORRECTION_COMMAND, async (request?: CorrectionRequest) => {
      await this.startCorrection(request);
    });
    vscode.commands.registerCommand(COMMIT_COMMAND, async (request?: CorrectionRequest) => {
      await this.startCommit(request);
    });
  }

  schedule(editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
    }
    this.pendingTimer = setTimeout(() => {
      void this.render(editor);
    }, STATUS_REFRESH_DEBOUNCE_MS);
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== document || !this.isEnabled()) {
      return [];
    }

    const request = this.resolveActiveLineRequest();
    if (!request) {
      return [];
    }

    const range = document.lineAt(editor.selection.active.line).range;
    const lenses = [
      new vscode.CodeLens(range, {
        title: 'Correct ground truth…',
        command: CORRECTION_COMMAND,
        tooltip: 'Record the correct surface form for this line and hand off a fix-it prompt to an AI chat agent.',
        arguments: [request]
      })
    ];

    if (this.canCommit(request)) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: '✓ Commit ground truth',
          command: COMMIT_COMMAND,
          tooltip: 'Approve the current rendering as this line\'s ground truth.',
          arguments: [request]
        })
      );
    }

    return lenses;
  }

  private canCommit(request: CorrectionRequest): boolean {
    if (request.rendered === null) {
      return false;
    }
    if (request.status === 'unaccounted') {
      return true;
    }
    return request.status === 'mismatch' && !request.declaredTarget;
  }

  private resolveActiveLineRequest(): CorrectionRequest | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    const status = this.statusByDocument.get(editor.document.uri.toString());
    if (!status) {
      return undefined;
    }
    const activeLine = editor.selection.active.line;
    const line = status.lines.find(
      (candidate) => activeLine >= candidate.source_line - 1 && activeLine <= candidate.end_line - 1
    );
    if (!line) {
      return undefined;
    }
    return {
      documentUri: editor.document.uri.toString(),
      source: status.source,
      ordinal: line.ordinal,
      sourceLine: line.source_line,
      endLine: line.end_line,
      status: line.status,
      rendered: line.rendered,
      target: line.target,
      declaredTarget: line.declared_target
    };
  }

  dispose(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
    }
    this.verifiedDecoration.dispose();
    this.mismatchDecoration.dispose();
    this.unaccountedDecoration.dispose();
    this.onDidChangeCodeLensesEmitter.dispose();
  }

  refreshCodeLenses(): void {
    this.onDidChangeCodeLensesEmitter.fire();
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration('tupy').get<boolean>('enableGroundTruthStatus', true);
  }

  private async render(editor: vscode.TextEditor | undefined): Promise<void> {
    const requestId = ++this.requestId;

    if (!editor || !isTupyDocument(editor.document) || editor.document.uri.scheme !== 'file' || !this.isEnabled()) {
      if (editor) {
        this.clearDecorations(editor);
      }
      return;
    }

    const document = editor.document;
    const corpusRoot = await resolveCorpusRoot(document);
    const source = corpusRoot ? canonicalSourceName(corpusRoot, document.uri.fsPath) : undefined;
    if (!corpusRoot || !source) {
      this.statusByDocument.delete(document.uri.toString());
      this.clearDecorations(editor);
      this.refreshCodeLenses();
      return;
    }

    const configuration = vscode.workspace.getConfiguration('tupy');
    const interpreter = configuration.get<string>('pythonInterpreter', 'python3').trim() || 'python3';
    const timeout = Math.max(500, configuration.get<number>('pythonEvaluationTimeoutMs', 5000) ?? 5000);

    let payload: GroundTruthPayload;
    try {
      const stdout = await execFile(interpreter, [this.scriptPath, corpusRoot, document.uri.fsPath], {
        cwd: corpusRoot,
        timeout,
        input: document.getText()
      });
      payload = JSON.parse(stdout) as GroundTruthPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[ground-truth] ${document.uri.fsPath}: ${message}`);
      return;
    }

    if (requestId !== this.requestId || vscode.window.activeTextEditor !== editor) {
      return;
    }

    if (payload.error) {
      this.output.appendLine(`[ground-truth] ${document.uri.fsPath}: ${payload.error}`);
      return;
    }

    const lines = payload.lines ?? [];
    if (!lines.length) {
      this.statusByDocument.delete(document.uri.toString());
      this.clearDecorations(editor);
      this.refreshCodeLenses();
      return;
    }

    this.statusByDocument.set(document.uri.toString(), { source, lines });
    this.applyDecorations(editor, lines);
    this.refreshCodeLenses();
  }

  private applyDecorations(editor: vscode.TextEditor, lines: GroundTruthLine[]): void {
    const verified: vscode.DecorationOptions[] = [];
    const mismatch: vscode.DecorationOptions[] = [];
    const unaccounted: vscode.DecorationOptions[] = [];

    for (const line of lines) {
      const startLine = line.source_line - 1;
      if (startLine < 0 || startLine >= editor.document.lineCount) {
        continue;
      }
      const endLine = Math.min(Math.max(line.end_line - 1, startLine), editor.document.lineCount - 1);
      const option: vscode.DecorationOptions = {
        range: new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length),
        hoverMessage: hoverForLine(line)
      };
      if (line.status === 'verified') {
        verified.push(option);
      } else if (line.status === 'mismatch') {
        mismatch.push(option);
      } else {
        unaccounted.push(option);
      }
    }

    editor.setDecorations(this.verifiedDecoration, verified);
    editor.setDecorations(this.mismatchDecoration, mismatch);
    editor.setDecorations(this.unaccountedDecoration, unaccounted);
  }

  private clearDecorations(editor: vscode.TextEditor): void {
    editor.setDecorations(this.verifiedDecoration, []);
    editor.setDecorations(this.mismatchDecoration, []);
    editor.setDecorations(this.unaccountedDecoration, []);
  }

  private async startCorrection(request?: CorrectionRequest): Promise<void> {
    request = request ?? this.resolveActiveLineRequest();
    if (!request) {
      vscode.window.showInformationMessage(
        'Place the caret on a ground-truth-tracked line (its lens shows above the line) before correcting it.'
      );
      return;
    }

    const correctedTarget = await vscode.window.showInputBox({
      title: `Correct ground truth · ${request.source} #${request.ordinal}`,
      prompt: 'What should this line render as? (Esc or click away to cancel)',
      value: request.target ?? request.rendered ?? '',
      validateInput: (value) => (value.trim() ? undefined : 'Enter the corrected surface form.')
    });
    if (!correctedTarget?.trim()) {
      return;
    }

    const explanation = await vscode.window.showInputBox({
      title: `Correct ground truth · ${request.source} #${request.ordinal}`,
      prompt: 'Optional explanation for the linguist review (why is this the correct form?)'
    });

    const documentUri = vscode.Uri.parse(request.documentUri);
    const prompt = buildCorrectionPrompt(request, correctedTarget.trim(), explanation?.trim(), documentUri);
    await copyCorrectionPromptToClipboard(prompt);
  }

  private async startCommit(request?: CorrectionRequest): Promise<void> {
    request = request ?? this.resolveActiveLineRequest();
    if (!request) {
      vscode.window.showInformationMessage(
        'Place the caret on a ground-truth-tracked line (its lens shows above the line) before committing it.'
      );
      return;
    }
    if (!this.canCommit(request)) {
      vscode.window.showInformationMessage(
        'This line already has a declared target the current rendering does not match — fix the engine or use "Correct ground truth" instead.'
      );
      return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Approve "${request.rendered}" as ground truth for ${request.source} #${request.ordinal}?`,
      { modal: true },
      'Commit'
    );
    if (confirmed !== 'Commit') {
      return;
    }

    const documentUri = vscode.Uri.parse(request.documentUri);
    const document = await vscode.workspace.openTextDocument(documentUri);
    if (document.isDirty && !(await document.save())) {
      vscode.window.showErrorMessage('Could not save the document before committing ground truth.');
      return;
    }

    const corpusRoot = await resolveCorpusRoot(document);
    if (!corpusRoot) {
      vscode.window.showErrorMessage('Could not resolve the oldtupicorpus checkout for this document.');
      return;
    }

    const configuration = vscode.workspace.getConfiguration('tupy');
    const interpreter = configuration.get<string>('pythonInterpreter', 'python3').trim() || 'python3';
    const timeout = Math.max(500, configuration.get<number>('pythonEvaluationTimeoutMs', 5000) ?? 5000);

    let payload: CommitPayload;
    try {
      const stdout = await execFile(
        interpreter,
        [this.commitScriptPath, corpusRoot, document.uri.fsPath, String(request.ordinal)],
        { cwd: corpusRoot, timeout }
      );
      payload = JSON.parse(stdout) as CommitPayload;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Commit ground truth failed: ${message}`);
      return;
    }

    if (!payload.ok) {
      vscode.window.showErrorMessage(`Commit ground truth failed: ${payload.error ?? 'unknown error'}`);
      return;
    }

    vscode.window.showInformationMessage(`Committed ${request.source} #${request.ordinal}: "${payload.committed_surface}"`);
    await this.render(vscode.window.activeTextEditor);
  }
}

function hoverForLine(line: GroundTruthLine): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = false;
  if (line.status === 'verified') {
    markdown.appendMarkdown('Ground truth: **verified** — matches the approved target. Leave this line alone.');
  } else if (line.status === 'mismatch') {
    markdown.appendMarkdown(
      'Ground truth: **mismatch** — an approved target exists but the current rendering does not match it.\n\n'
    );
    markdown.appendMarkdown(`- Target: \`${line.target ?? ''}\`\n`);
    markdown.appendMarkdown(`- Rendered: \`${line.rendered ?? '(render failed)'}\``);
  } else {
    markdown.appendMarkdown(
      'Ground truth: **not yet accounted for** — no approved target exists at this position. Safe to keep editing.'
    );
  }
  return markdown;
}

function buildCorrectionPrompt(
  request: CorrectionRequest,
  correctedTarget: string,
  explanation: string | undefined,
  documentUri: vscode.Uri
): string {
  const file = vscode.workspace.asRelativePath(documentUri, false);
  const recordId = `${request.source}:${String(request.ordinal).padStart(4, '0')}`;
  const lineRange =
    request.endLine > request.sourceLine ? `lines ${request.sourceLine}-${request.endLine}` : `line ${request.sourceLine}`;

  return [
    'Work as a human-led Old Tupi corpus authoring assistant fixing a grammar-engine bug reported by a linguist.',
    'This is a bug report against the ../nhe-enga grammar engine (pydicate/tupi), not a request to make this one line render some text. The Pydicate expression below is canonical — it is how the linguist wrote this line — and the corrected surface form is what that exact, unmodified expression should already produce if pydicate/tupi implemented the described rule correctly.',
    `Active source file: ${file}`,
    `Historic source: ${request.source}`,
    `Ground-truth record: ${recordId} (source ${lineRange})`,
    `Current status: ${request.status}`,
    `Current rendered surface form: ${JSON.stringify(request.rendered ?? null)}`,
    `Previously recorded target (if any): ${JSON.stringify(request.target ?? null)}`,
    `Linguist-specified correct surface form: ${JSON.stringify(correctedTarget)}`,
    `Linguist explanation (this describes a grammatical rule, not a wording preference): ${explanation ? explanation : '(none provided)'}`,
    '',
    'Steps:',
    '1. Use the oldtupi-authoring MCP tools (get_source_context, search_lexicon, search_rendered_expressions, render_candidate, line_status, verify_ground_truth, reload_engine) to inspect this record\'s current expression, its rendering, and its neighbors before touching anything.',
    'IMPORTANT — this MCP server is a long-lived process and caches the ../nhe-enga engine modules in memory: call reload_engine immediately after ANY edit to ../nhe-enga, before the very next render_candidate, verify_ground_truth, or line_status call. Skipping this silently re-tests the OLD engine code, which looks exactly like "my fix did not work" and is the single biggest cause of wasted iteration in this workflow — if a change you are confident in does not seem to take effect, suspect a missing reload_engine call before anything else.',
    '2. Do NOT edit the Pydicate expression for this line. In particular, never introduce a new inline lexicon-like constructor (a fresh Noun(...)/Verb(...)/stem, or any other construct that exists only to bake in the desired surface) — that renders correctly while discarding the linguistic claim the expression was making, which is worse than leaving the bug unfixed. Do not swap in a different existing lexicon entry either. If, after investigating, you become convinced the expression itself (not the engine) is actually wrong, stop and explain that belief instead of changing it — that judgment belongs to the human editor, not this workflow.',
    '3. Before searching, read ../nhe-enga/docs/agent/grammar-navigation.md — a living map of where phenomena are implemented in pydicate/tupi, kept current by past fixes. Start there instead of grepping blind; it may already point at the exact function.',
    '4. Find the specific rule in ../nhe-enga (pydicate or tupi) responsible for the behavior the linguist described. When comparing a candidate render against the corrected surface form above, ignore whitespace differences — compare the sequence of words/elements only; the linguist\'s own spacing when typing the correction is not meaningful.',
    '5. STOP HERE before writing any fix — this is the only checkpoint in this workflow where you wait for me. Describe, in plain terms, exactly why the bug is arising (the specific mechanism in the engine producing the wrong output) and what you intend to do to fix it. Then show the potential changelog: a preview of the diff you intend to apply, with each changed file and the nature of the change. Do not write, commit, or apply any file edit until I have explicitly reviewed and approved this explanation and changelog. Come to this checkpoint only once, with a diagnosis you are actually confident in — do the digging in steps 1-4 thoroughly enough that you are not using my review cycle to debug.',
    '6. Once I approve, drive the fix to done yourself, without further check-ins: apply the edit, call reload_engine, then re-render this exact, unmodified expression via render_candidate and compare (still ignoring whitespace). If it still does not match, that almost always means the responsible code lives somewhere other than where you just edited, not that this same edit needs another tweak — widen the search rather than iterating in place, and re-confirm your diagnosis before editing again.',
    '7. Once it matches, call reload_engine once more and then run verify_ground_truth and line_status across ALL sources, and keep fixing and re-checking until that full regression check is clean — an engine change must not silently break previously-approved lines elsewhere. Do not stop at a partially-passing state; either reach a fully clean regression check or come back to me explaining specifically what is blocking it.',
    '8. Update ../nhe-enga/docs/agent/grammar-navigation.md with what you found: the phenomenon, exactly where it is implemented (file/class/function), and one gotcha. Keep it short — put the full root-cause narrative in ../nhe-enga/AGENT_NOTES.md or a session handoff and link to it instead. This is what makes the next agent faster than you were, even if this exact bug is never seen again.',
    '9. Explain in plain terms for a linguist (not just a diff) why the original rendering was wrong and why the fix produces the corrected form. If the fix does not make obvious grammatical sense even though it renders correctly, say so explicitly rather than presenting it as self-evidently right.',
    '10. Do not treat a matching render as proof that the historical analysis itself is correct. Once everything above is clean, tell me the line is ready for the "Commit ground truth" action in the editor rather than approving it yourself — that action is deliberately not available to you as an MCP tool.'
  ].join('\n');
}

async function copyCorrectionPromptToClipboard(prompt: string): Promise<void> {
  await vscode.env.clipboard.writeText(prompt);
  vscode.window.showInformationMessage('Correction prompt copied to the clipboard. Paste it into whichever AI chat you want.');
}

async function resolveCorpusRoot(document: vscode.TextDocument): Promise<string | undefined> {
  const configured = vscode.workspace.getConfiguration('tupy', document.uri).get<string>('corpusPath', '').trim();
  if (configured) {
    const resolved = resolveConfiguredCorpusPath(document, configured);
    if (resolved && (await hasAuthoringPackage(resolved))) {
      return resolved;
    }
  }

  const ancestor = await findAncestorWithAuthoringPackage(path.dirname(document.uri.fsPath));
  if (ancestor) {
    return ancestor;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    const sibling = path.join(workspaceFolder.uri.fsPath, '..', 'oldtupicorpus');
    if (await hasAuthoringPackage(sibling)) {
      return sibling;
    }
  }

  return undefined;
}

function resolveConfiguredCorpusPath(document: vscode.TextDocument, configuredPath: string): string | undefined {
  if (path.isAbsolute(configuredPath)) {
    return configuredPath;
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return undefined;
  }
  return path.join(workspaceFolder.uri.fsPath, configuredPath);
}

async function findAncestorWithAuthoringPackage(startDir: string): Promise<string | undefined> {
  let current = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    if (await hasAuthoringPackage(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

async function hasAuthoringPackage(root: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(path.join(root, 'authoring', 'service.py')));
    return true;
  } catch {
    return false;
  }
}

function canonicalSourceName(corpusRoot: string, documentPath: string): string | undefined {
  const name = path.basename(documentPath);
  let source: string | undefined;
  if (name.endsWith('.tu.py')) {
    source = name.slice(0, -'.tu.py'.length);
  } else if (name.endsWith('.py')) {
    source = name.slice(0, -'.py'.length);
  }
  if (!source) {
    return undefined;
  }

  const candidates = [
    path.join(corpusRoot, 'historic', `${source}.tu.py`),
    path.join(corpusRoot, 'historic', `${source}.py`)
  ];
  return candidates.some((candidate) => path.resolve(candidate) === path.resolve(documentPath)) ? source : undefined;
}
