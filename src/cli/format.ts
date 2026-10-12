// Text helpers and the rail layout every command prints with. Styles are foreground only, so output reads
// on light and dark terminals. Only the TUI paints a background.

import os from 'node:os';
import path from 'node:path';
import { palette, width as visibleWidth, cutStyled, tailCells } from '../tui/render.js';
export { humanBytes } from '../tui/render.js';
import { colorSequence, type ColorProfile } from './terminal.js';

export type Writer = (text: string) => void;

// Removes ANSI style and OSC sequences, for log files and emptiness checks.
export const strip = (s: string): string => s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');

// Replaces control characters, so file names and remote messages can't move the cursor or restyle the
// terminal.
export const printable = (s: string): string => s.toWellFormed().replace(/\p{Cc}/gu, '?');

// Shows a slash-separated path with backslashes on Windows.
export const nativePath = (p: string): string => (process.platform === 'win32' ? p.replaceAll('/', '\\') : p);

// Shortens a path in the home folder to start with ~. A slash-separated path keeps its slashes.
export function tildify(p: string): string {
  const h = os.homedir();
  if (p === h) return '~';
  if (p.startsWith(h + path.sep)) return '~' + p.slice(h.length);
  if (p.startsWith(h.replaceAll('\\', '/') + '/')) return '~/' + p.slice(h.length + 1);
  return p;
}

export const humanCount = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export const plural = (n: number, thing: string): string =>
  n === 1 ? '1 ' + thing : humanCount(n) + ' ' + thing + 's';

// A rough duration: minutes, then hours up to two days, then days.
export function relative(ms: number): string {
  if (ms < 60_000) return 'moments';
  if (ms < 3600_000) return Math.trunc(ms / 60_000) + 'm';
  if (ms < 48 * 3600_000) return Math.trunc(ms / 3600_000) + 'h';
  return Math.trunc(ms / 86400_000) + 'd';
}

export const ago = (time: string, now = Date.now()) => relative(now - Date.parse(time)) + ' ago';

export const inTime = (time: number, now = Date.now()) => (time < now ? 'overdue' : 'in ' + relative(time - now));

// Local time as YYYY-MM-DD HH:MM.
export function when(time: string): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  return `${year < 0 ? '-' : ''}${String(Math.abs(year)).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Widths count terminal cells, so wide characters count double and styling counts as nothing.
export const cellWidth = visibleWidth;

export function truncate(s: string, width: number): string {
  return cellWidth(s) <= width ? s : cutStyled(s, Math.max(0, width));
}

export const truncateLeft = (s: string, width: number): string => tailCells(s, Math.max(0, width));

// Redraws one progress line in place. It stays a cell short of the width so the terminal never wraps it.
export function statusLine(write: Writer, s: string, width = 0): void {
  write('\r\x1b[K' + (width ? truncate(s, Math.max(0, width - 1)) : s));
}

// Writes output and styles text. `blockOpen` tells the error printer whether a block still needs closing.
export class Format {
  blockOpen = false;

  constructor(
    public write: Writer,
    public colors = false,
    public profile: ColorProfile = 'truecolor',
  ) {}

  // Multi-line text is styled one line at a time and padded to its widest line.
  style(s: string, hex?: string, bold = false): string {
    const colored = this.colors && this.profile !== 'ascii';
    const params = [bold ? '1' : '', hex ? colorSequence(hex, this.profile) : ''].filter(Boolean).join(';');
    const prefix = '\x1b[' + params + 'm';
    const paint = (line: string) => (colored && line ? prefix + line + '\x1b[0m' : line);
    if (!s.includes('\n')) return paint(s);
    const lines = s.split('\n');
    const width = lines.reduce((w, line) => Math.max(w, cellWidth(line)), 0);
    return lines.map(line => paint(line) + ' '.repeat(width - cellWidth(line))).join('\n');
  }

  dim(s: string): string {
    return this.style(s, palette.subtle);
  }

  bold(s: string): string {
    return this.style(s, undefined, true);
  }

  good(s: string): string {
    return this.style(s, palette.cliOK);
  }

  caution(s: string): string {
    return this.style(s, palette.cliWarn);
  }

  error(s: string): string {
    return this.style(s, palette.cliBad, true);
  }

  // The rail is the accent-coloured line down the left of a block.
  rail(s: string): string {
    return this.style(s, palette.cliAccent);
  }

  railed(s: string): string {
    return this.rail('│') + '  ' + s;
  }

  // A one-line result, with a blank line before and after.
  single(s: string): void {
    this.write('\n' + s + '\n\n');
  }

  // The └ line that ends a block. Later lines of the message are indented to sit under its first line.
  closeLine(s: string): string {
    return (
      this.rail('└') +
      (s
        ? '  ' +
          s
            .split('\n')
            .map((l, i) => (i && l ? '   ' + l : l))
            .join('\n')
        : '')
    );
  }

  // Error messages can carry text from storage or the filesystem, so their control characters are replaced.
  errorText(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    return msg.split('\n').map(printable).join('\n');
  }

  errorLine(err: unknown, closes = false): string {
    const s = this.error('error:') + ' ' + this.errorText(err);
    return closes ? this.closeLine(s) : s;
  }

  block(): Block {
    return new Block(this);
  }
}

// Draws a railed block. ┌ opens it with a bold title, │ holds rows, ├ starts a section and └ closes it. Row
// labels are padded to `width` so their values line up.
export class Block {
  width = 12;

  constructor(public fmt: Format) {}

  open(title: string, meta = ''): void {
    this.fmt.write(
      '\n' + this.fmt.rail('┌') + '  ' + this.fmt.bold(title) + (meta ? '  ' + this.fmt.dim(meta) : '') + '\n',
    );
    this.fmt.blockOpen = true;
  }

  section(title: string): void {
    this.fmt.write(this.fmt.rail('├') + '  ' + this.fmt.bold(title) + '\n');
  }

  gap(): void {
    this.fmt.write(this.fmt.rail('│') + '\n');
  }

  line(s: string): void {
    this.mark(this.fmt.rail('│'), s);
  }

  ok(s: string): void {
    this.mark(this.fmt.good('●'), s);
  }

  warn(s: string): void {
    this.mark(this.fmt.caution('▲'), s);
  }

  fail(s: string): void {
    this.mark(this.fmt.error('■'), s);
  }

  // Writes text behind a marker. Later lines go behind the rail, indented by `indent`. Blank lines get no
  // trailing spaces.
  mark(glyph: string, s: string, indent = ''): void {
    s.split('\n').forEach((l, i) => {
      const g = i ? this.fmt.rail('│') : glyph;
      if (i) l = indent + l;
      this.fmt.write(g + (strip(l).trim() ? '  ' + l : '') + '\n');
    });
  }

  row(label: string, value: string): void {
    this.markedRow(this.fmt.rail('│'), label, value);
  }

  warnRow(label: string, value: string): void {
    this.markedRow(this.fmt.caution('▲'), label, value);
  }

  failRow(label: string, value: string): void {
    this.markedRow(this.fmt.error('■'), label, value);
  }

  private markedRow(glyph: string, label: string, value: string) {
    this.mark(glyph, this.fmt.dim(label.padEnd(this.width)) + ' ' + value, ' '.repeat(this.width + 1));
  }

  close(s = ''): void {
    this.fmt.write(this.fmt.closeLine(s) + '\n\n');
    this.fmt.blockOpen = false;
  }
}
