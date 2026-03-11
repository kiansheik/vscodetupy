import * as vscode from 'vscode';
import { LexiconEntry } from './types';

const IDENTIFIER = String.raw`[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*`;
const CALLEE = `${IDENTIFIER}(?:\\.${IDENTIFIER})*`;
const ASSIGNMENT_PATTERN = new RegExp(`^\\s*(${IDENTIFIER})\\s*=\\s*(${CALLEE})\\s*\\(`, 'gmu');

export function extractEntries(text: string, uri: vscode.Uri): LexiconEntry[] {
  const entries: LexiconEntry[] = [];
  ASSIGNMENT_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = ASSIGNMENT_PATTERN.exec(text)) !== null) {
    const [, name, callee] = match;
    const openParenIndex = ASSIGNMENT_PATTERN.lastIndex - 1;
    const closeParenIndex = findClosingParen(text, openParenIndex);
    if (closeParenIndex === -1) {
      continue;
    }

    const argsText = text.slice(openParenIndex + 1, closeParenIndex);
    const args = splitTopLevelArguments(argsText);
    const positional: string[] = [];
    let definition: string | undefined;

    for (const arg of args) {
      const keyword = getKeyword(arg);
      if (keyword === 'definition') {
        definition = extractStringValue(arg.slice(arg.indexOf('=') + 1)) ?? definition;
        continue;
      }
      positional.push(arg);
    }

    const orthography = extractStringValue(positional[0] ?? '');
    if (!orthography) {
      ASSIGNMENT_PATTERN.lastIndex = closeParenIndex + 1;
      continue;
    }

    if (!definition) {
      definition = extractStringValue(positional[1] ?? '');
    }

    const line = lineNumberAt(text, match.index);
    const kind = callee.split('.').at(-1) ?? callee;

    entries.push({
      id: `${uri.toString()}::${name}::${line}`,
      name,
      kind,
      orthography,
      definition,
      uri,
      line
    });

    ASSIGNMENT_PATTERN.lastIndex = closeParenIndex + 1;
  }

  return entries;
}

function findClosingParen(text: string, openParenIndex: number): number {
  let depth = 0;
  let quote: '"' | '\'' | null = null;
  let triple = false;

  for (let i = openParenIndex; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    const next2 = text[i + 2];

    if (quote) {
      if (char === '\\') {
        i += 1;
        continue;
      }

      if (triple) {
        if (char === quote && next === quote && next2 === quote) {
          quote = null;
          triple = false;
          i += 2;
        }
        continue;
      }

      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      triple = next === char && next2 === char;
      if (triple) {
        i += 2;
      }
      continue;
    }

    if (char === '(') {
      depth += 1;
      continue;
    }

    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function splitTopLevelArguments(text: string): string[] {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let quote: '"' | '\'' | null = null;
  let triple = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    const next2 = text[i + 2];

    if (quote) {
      current += char;
      if (char === '\\') {
        if (i + 1 < text.length) {
          current += text[i + 1];
          i += 1;
        }
        continue;
      }

      if (triple) {
        if (char === quote && next === quote && next2 === quote) {
          current += next + next2;
          i += 2;
          quote = null;
          triple = false;
        }
        continue;
      }

      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === '\'') {
      quote = char;
      triple = next === char && next2 === char;
      current += char;
      if (triple) {
        current += next + next2;
        i += 2;
      }
      continue;
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
      current += char;
      continue;
    }

    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (char === ',' && depth === 0) {
      if (current.trim()) {
        args.push(current.trim());
      }
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

function getKeyword(argument: string): string | undefined {
  const match = argument.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
  return match?.[1];
}

function extractStringValue(expression: string): string | undefined {
  const literal = readStringLiteral(expression.trim());
  if (!literal) {
    return undefined;
  }
  return decodePythonString(literal);
}

function readStringLiteral(expression: string): string | undefined {
  let start = -1;
  let quote: '"' | '\'' | null = null;

  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i];
    if (char === '"' || char === '\'') {
      start = i;
      quote = char;
      break;
    }
    if (!/[A-Za-z_\s]/u.test(char)) {
      break;
    }
  }

  if (start === -1 || quote === null) {
    return undefined;
  }

  const triple = expression[start + 1] === quote && expression[start + 2] === quote;
  const endOffset = triple ? 3 : 1;

  for (let i = start + endOffset; i < expression.length; i += 1) {
    const char = expression[i];
    if (char === '\\') {
      i += 1;
      continue;
    }

    if (triple) {
      if (char === quote && expression[i + 1] === quote && expression[i + 2] === quote) {
        return expression.slice(start, i + 3);
      }
      continue;
    }

    if (char === quote) {
      return expression.slice(start, i + 1);
    }
  }

  return undefined;
}

function decodePythonString(literal: string): string {
  const start = literal.search(/['"]/u);
  const quote = literal[start];
  const triple = literal[start + 1] === quote && literal[start + 2] === quote;
  const contentStart = start + (triple ? 3 : 1);
  const contentEnd = literal.length - (triple ? 3 : 1);
  const content = literal.slice(contentStart, contentEnd);

  return content
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\');
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') {
      line += 1;
    }
  }
  return line;
}
