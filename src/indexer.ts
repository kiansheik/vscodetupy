import * as vscode from 'vscode';
import { extractEntries } from './parser';
import { PythonLexiconEvaluator } from './runtimePython';
import { normalizeForSearch } from './text';
import { LexiconEntry } from './types';

export class WorkspaceLexicon {
  private readonly entriesByUri = new Map<string, LexiconEntry[]>();
  private readonly runtimeEntriesByUri = new Map<string, LexiconEntry[]>();
  private readonly onDidChangeEntriesEmitter = new vscode.EventEmitter<readonly LexiconEntry[]>();
  private readonly refreshTokens = new Map<string, number>();

  constructor(private readonly runtimeEvaluator?: PythonLexiconEvaluator) {}

  readonly onDidChangeEntries = this.onDidChangeEntriesEmitter.event;

  async initialize(): Promise<void> {
    this.entriesByUri.clear();
    this.runtimeEntriesByUri.clear();

    const files = await vscode.workspace.findFiles('**/*.tu.py', '**/{.git,dist,node_modules}/**');
    for (const uri of files) {
      await this.refreshUri(uri, { emit: false, includeRuntime: true });
    }

    for (const document of vscode.workspace.textDocuments) {
      if (isTupyDocument(document)) {
        await this.refreshDocument(document, {
          emit: false,
          includeRuntime: !document.isDirty && document.uri.scheme === 'file'
        });
      }
    }

    this.emit();
  }

  getAllEntries(): LexiconEntry[] {
    return Array.from(this.entriesByUri.values())
      .flat()
      .sort((left, right) => {
        const orthographyCompare = left.orthography.localeCompare(right.orthography);
        if (orthographyCompare !== 0) {
          return orthographyCompare;
        }
        const nameCompare = left.name.localeCompare(right.name);
        if (nameCompare !== 0) {
          return nameCompare;
        }
        return left.line - right.line;
      });
  }

  getEntry(id: string): LexiconEntry | undefined {
    return this.getAllEntries().find((entry) => entry.id === id);
  }

  search(query: string, limit = 100): LexiconEntry[] {
    const trimmed = query.trim();
    const entries = this.getAllEntries();
    if (!trimmed) {
      return entries.slice(0, limit);
    }

    const needle = normalizeForSearch(trimmed);
    return entries
      .map((entry) => ({ entry, rank: scoreEntry(entry, needle) }))
      .filter((match): match is { entry: LexiconEntry; rank: SearchRank } => match.rank !== undefined)
      .sort((left, right) => compareSearchRanks(left.entry, left.rank, right.entry, right.rank))
      .map((match) => match.entry)
      .slice(0, limit);
  }

  async refreshDocument(
    document: vscode.TextDocument,
    options: { emit?: boolean; includeRuntime?: boolean } = {}
  ): Promise<void> {
    if (!isTupyDocument(document)) {
      return;
    }

    const key = document.uri.toString();
    const token = this.beginRefresh(key);
    const staticEntries = extractEntries(document.getText(), document.uri);
    const runtimeEntries = await this.runtimeEntriesForDocument(document.uri, options.includeRuntime === true);
    const entries = mergeEntries(staticEntries, runtimeEntries);

    if (!this.isLatestRefresh(key, token)) {
      return;
    }

    this.entriesByUri.set(key, entries);
    if (options.emit ?? true) {
      this.emit();
    }
  }

  async refreshUri(
    uri: vscode.Uri,
    options: { emit?: boolean; includeRuntime?: boolean } = {}
  ): Promise<void> {
    if (!isTupyUri(uri)) {
      return;
    }

    const key = uri.toString();
    const token = this.beginRefresh(key);

    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf8');
      const staticEntries = extractEntries(text, uri);
      const runtimeEntries = await this.runtimeEntriesForDocument(uri, options.includeRuntime === true);
      const entries = mergeEntries(staticEntries, runtimeEntries);

      if (!this.isLatestRefresh(key, token)) {
        return;
      }

      this.entriesByUri.set(key, entries);
      if (options.emit ?? true) {
        this.emit();
      }
    } catch {
      this.removeUri(uri);
    }
  }

  removeUri(uri: vscode.Uri): void {
    this.runtimeEntriesByUri.delete(uri.toString());
    if (this.entriesByUri.delete(uri.toString())) {
      this.emit();
    }
  }

  private emit(): void {
    this.onDidChangeEntriesEmitter.fire(this.getAllEntries());
  }

  private beginRefresh(key: string): number {
    const token = (this.refreshTokens.get(key) ?? 0) + 1;
    this.refreshTokens.set(key, token);
    return token;
  }

  private isLatestRefresh(key: string, token: number): boolean {
    return this.refreshTokens.get(key) === token;
  }

  private async runtimeEntriesForDocument(uri: vscode.Uri, includeRuntime: boolean): Promise<LexiconEntry[]> {
    const key = uri.toString();
    if (!includeRuntime) {
      return this.runtimeEntriesByUri.get(key) ?? [];
    }

    const runtimeEntries = this.runtimeEvaluator ? await this.runtimeEvaluator.evaluate(uri) : [];
    this.runtimeEntriesByUri.set(key, runtimeEntries);
    return runtimeEntries;
  }
}

export function isTupyDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'tupy' || isTupyUri(document.uri);
}

function isTupyUri(uri: vscode.Uri): boolean {
  return uri.path.endsWith('.tu.py');
}

function scoreEntry(entry: LexiconEntry, needle: string): SearchRank | undefined {
  const name = normalizeForSearch(entry.name);
  if (name === needle) {
    return { tier: 0, span: 0, field: entry.name };
  }
  if (name.startsWith(needle)) {
    return { tier: 1, span: name.length - needle.length, field: entry.name };
  }
  if (name.includes(needle)) {
    return { tier: 2, span: name.indexOf(needle), field: entry.name };
  }

  const orthography = normalizeForSearch(entry.orthography);
  if (orthography === needle) {
    return { tier: 3, span: 0, field: entry.orthography };
  }
  if (orthography.startsWith(needle)) {
    return { tier: 4, span: orthography.length - needle.length, field: entry.orthography };
  }
  if (orthography.includes(needle)) {
    return { tier: 5, span: orthography.indexOf(needle), field: entry.orthography };
  }

  const definition = normalizeForSearch(entry.definition ?? '');
  if (!definition) {
    return undefined;
  }
  if (definition === needle) {
    return { tier: 6, span: 0, field: entry.definition ?? '' };
  }
  if (definition.startsWith(needle)) {
    return { tier: 7, span: definition.length - needle.length, field: entry.definition ?? '' };
  }
  if (definition.includes(needle)) {
    return { tier: 8, span: definition.indexOf(needle), field: entry.definition ?? '' };
  }

  return undefined;
}

function compareSearchRanks(
  leftEntry: LexiconEntry,
  leftRank: SearchRank,
  rightEntry: LexiconEntry,
  rightRank: SearchRank
): number {
  if (leftRank.tier !== rightRank.tier) {
    return leftRank.tier - rightRank.tier;
  }
  if (leftRank.span !== rightRank.span) {
    return leftRank.span - rightRank.span;
  }
  const fieldCompare = leftRank.field.localeCompare(rightRank.field);
  if (fieldCompare !== 0) {
    return fieldCompare;
  }
  const orthographyCompare = leftEntry.orthography.localeCompare(rightEntry.orthography);
  if (orthographyCompare !== 0) {
    return orthographyCompare;
  }
  return leftEntry.name.localeCompare(rightEntry.name);
}

function mergeEntries(staticEntries: LexiconEntry[], runtimeEntries: LexiconEntry[]): LexiconEntry[] {
  const merged = new Map<string, LexiconEntry>();

  for (const entry of staticEntries) {
    merged.set(entry.id, entry);
  }

  for (const entry of runtimeEntries) {
    const existing = merged.get(entry.id);
    merged.set(entry.id, {
      ...existing,
      ...entry,
      definition: entry.definition ?? existing?.definition
    });
  }

  return Array.from(merged.values());
}

interface SearchRank {
  tier: number;
  span: number;
  field: string;
}
