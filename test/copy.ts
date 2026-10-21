// Applies reviewed wording changes to frozen output captures. The original inputs, exit codes and frames
// remain immutable; the copy expectations live separately in test/copy/.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rules = JSON.parse(readFileSync(new URL('../../test/copy/cli.json', import.meta.url), 'utf8')) as {
  pattern: string;
  replacement: string;
}[];
const frames = JSON.parse(readFileSync(new URL('../../test/copy/tui.json', import.meta.url), 'utf8')) as {
  [name: string]: { line: number; was: string; text: string }[];
};

export function copyCLI(original: string): string {
  return rules.reduce((text, rule) => text.replace(new RegExp(rule.pattern, 'g'), rule.replacement), original);
}

export function copyFrame(name: string, original: string): string {
  const edits = frames[(process.platform === 'win32' ? 'win32/' : 'linux/') + name];
  if (!edits) return original;
  const lines = original.split('\n');
  for (const edit of edits) {
    assert.equal(lines[edit.line], edit.was, name + ' original row ' + (edit.line + 1));
    lines[edit.line] = edit.text;
  }
  return lines.join('\n');
}
