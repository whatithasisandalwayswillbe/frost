// Exclude patterns for backup. A pattern without a slash is tested against each file or folder name.
// A pattern with a slash is tested against the full path and each of its parent folders.

import path from 'node:path';

// Snapshots store paths with forward slashes on every platform.
export function slash(p: string): string {
  return process.platform === 'win32' ? p.replaceAll('\\', '/') : p;
}

// A null token is `*`, undefined is `?`, a string is one literal code point and a regex is one class.
type Token = string | RegExp | null | undefined;

// Compile without a backtracking regex: repeated stars must remain bounded for hostile file names.
function compile(pattern: string): (value: string) => boolean {
  const chars = Array.from(pattern);
  const tokens: Token[] = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '*') {
      if (tokens[tokens.length - 1] !== null) tokens.push(null);
    } else if (c === '?') tokens.push(undefined);
    else if (c === '[') {
      const end = chars.indexOf(']', i + 1);
      if (end < 0 || end === i + 1) throw new Error('syntax error in pattern');
      try {
        tokens.push(new RegExp('^[' + chars.slice(i + 1, end).join('') + ']$', 'u'));
      } catch {
        throw new Error('syntax error in pattern');
      }
      i = end;
    } else if (c === '\\') {
      if (++i === chars.length) throw new Error('syntax error in pattern');
      tokens.push(chars[i]);
    } else tokens.push(c);
  }

  // Literal names and one-star patterns cover the defaults without a state table or code-point copy.
  if (tokens.every(token => typeof token === 'string')) {
    const literal = tokens.join('');
    return value => value === literal;
  }
  const star = tokens.indexOf(null);
  if (star >= 0 && tokens.every((token, i) => i === star || typeof token === 'string')) {
    const prefix = tokens.slice(0, star).join('');
    const suffix = tokens.slice(star + 1).join('');
    return value =>
      value.length >= prefix.length + suffix.length &&
      value.startsWith(prefix) &&
      value.endsWith(suffix) &&
      !value.slice(prefix.length, value.length - suffix.length).includes('/');
  }

  // At each code point, state[j] means the first j tokens matched everything read so far.
  // A star consumes nothing from this row or one non-slash character from the previous row.
  return value => {
    let state = new Uint8Array(tokens.length + 1);
    let next = new Uint8Array(tokens.length + 1);
    state[0] = 1;
    for (let j = 0; tokens[j] === null; j++) state[j + 1] = 1;
    for (const c of value) {
      next[0] = 0;
      for (let j = 0; j < tokens.length; j++) {
        const token = tokens[j];
        next[j + 1] =
          token === null
            ? Number(!!next[j] || (c !== '/' && !!state[j + 1]))
            : Number(
                !!state[j] &&
                  (token === undefined ? c !== '/' : typeof token === 'string' ? token === c : token.test(c)),
              );
      }
      [state, next] = [next, state];
    }
    return !!state[tokens.length];
  };
}

export class Excluder {
  private names: ((value: string) => boolean)[] = [];
  private paths: ((value: string) => boolean)[] = [];

  constructor(patterns: string[]) {
    for (let p of patterns) {
      const original = p;
      p = slash(p).trim().replace(/\/$/, '');
      if (!p) continue;
      try {
        (p.includes('/') ? this.paths : this.names).push(compile(p));
      } catch {
        throw new Error(`invalid exclude pattern ${JSON.stringify(original)}: syntax error in pattern`);
      }
    }
  }

  match(p: string): boolean {
    if (!this.names.length && !this.paths.length) return false;
    p = slash(p);
    if (this.names.some(match => match(path.posix.basename(p)))) return true;

    // Test the path itself, then each parent folder up to the root.
    for (const match of this.paths)
      for (let q = p; q !== '/' && q !== '.' && q; q = path.posix.dirname(q)) {
        if (match(q)) return true;
        if (path.posix.dirname(q) === q) break;
      }
    return false;
  }
}
