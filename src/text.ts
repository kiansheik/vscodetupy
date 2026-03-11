const COMBINING_MARKS = /\p{Mark}+/gu;
const IDENTIFIER_START = /[$_\p{ID_Start}]/u;
const IDENTIFIER_PART = /[$_\u200C\u200D\p{ID_Continue}]/u;

export function normalizeForSearch(value: string): string {
  return value.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase();
}

export function suggestIdentifier(seed: string): string {
  const normalized = seed.normalize('NFD').replace(COMBINING_MARKS, '');
  const pieces: string[] = [];

  for (const char of normalized) {
    if (IDENTIFIER_PART.test(char)) {
      pieces.push(char.toLowerCase());
      continue;
    }

    if (/['’`\-\s]/u.test(char)) {
      pieces.push('_');
    }
  }

  let candidate = pieces.join('').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (!candidate) {
    candidate = 'entry';
  }
  if (!IDENTIFIER_START.test(candidate[0])) {
    candidate = `entry_${candidate}`;
  }
  return candidate;
}

export function escapeSnippet(value: string): string {
  return value.replace(/[\\$}]/g, '\\$&');
}
