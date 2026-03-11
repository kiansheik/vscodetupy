import * as vscode from 'vscode';

export interface LexiconEntry {
  id: string;
  name: string;
  kind: string;
  orthography: string;
  definition?: string;
  uri: vscode.Uri;
  line: number;
}
