// Rendering helpers shared by the TUI screens and the CLI output: the palette, ANSI styles, cell widths and layout.
// Every block is built from styled text rows that paint the TUI background, so screens fill the window without holes.

import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { cellWidths } from './cell-widths.js';

// Colours

export const palette = {
  // TUI palette, chosen by the user
  pri: '#f2efe7',
  sec: '#0a0a0b',
  ter: '#1926c4',
  muted: '#b1aea9',
  subtle: '#797774',

  // TUI status colours, not yet confirmed by the user
  ok: '#7ee787',
  warn: '#f2cc60',
  bad: '#ffa198',

  // CLI accent and status markers, used by src/cli/format.ts
  cliAccent: '#4353ff',
  cliOK: '#3fb950',
  cliWarn: '#d29922',
  cliBad: '#f85149',
};

export type Style =
  | 'base'
  | 'text'
  | 'dim'
  | 'faded'
  | 'bold'
  | 'good'
  | 'caution'
  | 'error'
  | 'title'
  | 'selected'
  | 'key'
  | 'redacted'
  | 'removed'
  | 'goodBold'
  | 'warnBold'
  | 'link';

// Each style is [foreground, background, bold, underline]. base has no foreground and only paints the background.
const colors: Record<Style, [string | undefined, string, boolean?, boolean?]> = {
  base: [undefined, palette.ter],
  text: [palette.pri, palette.ter],
  dim: [palette.muted, palette.ter],
  faded: [palette.subtle, palette.ter],
  bold: [palette.pri, palette.ter, true],
  good: [palette.ok, palette.ter],
  caution: [palette.warn, palette.ter],
  error: [palette.bad, palette.ter, true],
  title: [palette.ter, palette.pri, true],
  selected: [palette.sec, palette.pri],
  key: [palette.ter, palette.pri, true],
  redacted: [palette.sec, palette.sec],
  removed: [palette.bad, palette.ter],
  goodBold: [palette.ok, palette.ter, true],
  warnBold: [palette.warn, palette.ter, true],
  link: [palette.pri, palette.ter, true, true],
};

// Turns '#rrggbb' into an SGR colour triple. The recorded output writes ter as 25;38;195, one below its real blue
// value, and this keeps that exact sequence.
const rgb = (s: string) =>
  s === palette.ter ? '25;38;195' : [1, 3, 5].map(i => Number.parseInt(s.slice(i, i + 2), 16)).join(';');

// Wraps each line in its own colour sequence, so a multi-line value stays styled on every row. Empty lines stay
// empty, and titles get a space of padding on each side.
export function style(kind: Style, value: string): string {
  const [fg, bg, bold, underline] = colors[kind];
  if (kind === 'title') value = ' ' + value + ' ';
  const params = [bold ? '1' : '', underline ? '4' : '', fg ? '38;2;' + rgb(fg) : '', '48;2;' + rgb(bg)]
    .filter(Boolean)
    .join(';');
  return value
    .split('\n')
    .map(s => (s ? '\x1b[' + params + 'm' + s + '\x1b[0m' : ''))
    .join('\n');
}

// Measuring text

// Removes CSI sequences, such as colours, and OSC sequences ended by BEL or ST.
export const strip = (s: string): string =>
  s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// Splits text into user-perceived characters. Printable ASCII skips the segmenter because it's much faster.
export function graphemes(s: string): string[] {
  return /^[\x20-\x7e]*$/.test(s) ? [...s] : [...segmenter.segment(s)].map(v => v.segment);
}

// Terminal cells taken by one grapheme. A character followed by VS16 (U+FE0F) shows as a wide emoji. Otherwise the
// first code point decides, using the table in cell-widths.ts, and anything not listed there is one cell.
export function cellWidth(g: string): number {
  if (!g) return 0;
  const first = g.codePointAt(0)!;
  const following = g.codePointAt(first > 0xffff ? 2 : 1);
  if (first > 0x1f && following === 0xfe0f) return 2;

  // Binary search over the sorted ranges.
  let low = 0;
  let high = cellWidths.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const [start, end, result] = cellWidths[middle];
    if (first < start) high = middle - 1;
    else if (first > end) low = middle + 1;
    else return result;
  }
  return 1;
}

// Screens measure the same strings many times per frame. The cache holds up to 1024 strings of at most 2048
// characters and drops the oldest entry when it's full.
const widths = new Map<string, number>();

// Width in cells of the widest line, ignoring escape sequences.
export function width(s: string): number {
  const cached = widths.get(s);
  if (cached !== undefined) return cached;

  const plain = strip(s);
  let result = 0;
  for (const line of plain.split('\n'))
    result = Math.max(
      result,
      /^[\x20-\x7e]*$/.test(line) ? line.length : graphemes(line).reduce((n, g) => n + cellWidth(g), 0),
    );

  if (s.length <= 2048) {
    if (widths.size >= 1024) widths.delete(widths.keys().next().value!);
    widths.set(s, result);
  }
  return result;
}

export const height = (s: string): number => s.split('\n').length;

// Like height, but an empty string takes no rows.
export const setupHeight = (s: string): number => (s ? height(s) : 0);

// Makes untrusted text, such as file names, safe to draw. Lone surrogates become U+FFFD and control characters
// become '?', so names can't move the cursor or inject escape sequences.
export const printable = (s: string): string => s.toWellFormed().replace(/[\p{Cc}]/gu, '?');

// Cutting and truncating

// The longest start of s that fits in w cells, without splitting a grapheme.
export function headCells(s: string, w: number): string {
  let out = '',
    n = 0;
  for (const g of graphemes(s)) {
    const d = cellWidth(g);
    if (n + d > w) break;
    out += g;
    n += d;
  }
  return out;
}

// The longest end of s that fits in w cells, without splitting a grapheme.
export function tailCells(s: string, w: number): string {
  if (w <= 0) return '';
  let out = '',
    n = 0;
  for (const g of graphemes(s).reverse()) {
    const d = cellWidth(g);
    if (n + d > w) break;
    out = g + out;
    n += d;
  }
  return out;
}

// Fits plain text in w cells, ending with '...' when it's cut.
export function truncate(s: string, w: number): string {
  s = printable(s);
  if (width(s) <= w) return s;
  return w <= 3 ? headCells(s, Math.max(w, 0)) : headCells(s, w - 3) + '...';
}

// Fits plain text in w cells, starting with '...' when it's cut. Paths use this so the file name stays visible.
export function truncateLeft(s: string, w: number): string {
  s = printable(s);
  if (width(s) <= w) return s;
  return w <= 3 ? tailCells(s, w) : '...' + tailCells(s, w - 3);
}

// Cuts styled text to w cells and keeps its escape sequences. When it cuts text that had any styling, it ends
// with a reset so the colour doesn't leak.
export function cutStyled(s: string, w: number): string {
  let out = '',
    n = 0,
    colored = false;
  for (const token of s.match(/\x1b\[[0-?]*[ -/]*[@-~]|[^\x1b]+/g) ?? []) {
    if (token.startsWith('\x1b')) {
      out += token;
      colored = true;
      continue;
    }
    for (const g of graphemes(token)) {
      const d = cellWidth(g);
      if (n + d > w) return out + (colored ? '\x1b[0m' : '');
      out += g;
      n += d;
    }
  }
  return out;
}

// Layout. Blocks are newline-joined rows, and the helpers below pad them with background-coloured cells.

// Pads with plain spaces, for text that gets styled afterwards.
export function padPlain(s: string, w: number): string {
  return s + ' '.repeat(Math.max(w - width(s), 0));
}

// A w by h block of background.
export function fill(w: number, h = 1): string {
  if (w <= 0 || h <= 0) return '';
  return Array(h)
    .fill(style('base', ' '.repeat(Math.trunc(w))))
    .join('\n');
}

export const blank = (w: number): string => fill(w);

// Makes one row exactly w cells wide, padding with background or cutting.
export function pad(s: string, w: number): string {
  const d = w - width(s);
  if (d > 0) return s + fill(d);
  if (d < 0) return cutStyled(s, w);
  return s;
}

// Pads every row to the block's widest row, so the block is a solid rectangle.
export function solid(s: string): string {
  const w = width(s);
  return s
    .split('\n')
    .map(l => pad(l, w))
    .join('\n');
}

// Stacks blocks top to bottom and pads them to the widest one.
export function stack(...blocks: string[]): string {
  const w = Math.max(0, ...blocks.map(width));
  return blocks.flatMap(b => b.split('\n').map(l => pad(l, w))).join('\n');
}

// Lays blocks out left to right with gap cells between them. Shorter blocks are padded down to the tallest.
export function side(gap: number, ...blocks: string[]): string {
  const h = Math.max(0, ...blocks.map(height));
  const ws = blocks.map(width);
  const rows = blocks.map(b => b.split('\n'));
  return Array.from({ length: h }, (_, i) => rows.map((r, j) => pad(r[i] ?? '', ws[j])).join(fill(gap))).join('\n');
}

// Crops a block to at most w by h cells.
export function clip(s: string, w: number, h: number): string {
  return s
    .split('\n')
    .slice(0, Math.max(h, 0))
    .map(l => cutStyled(l, Math.max(w, 0)))
    .join('\n');
}

// Places a block in a w by h area of background, centred by default. A block wider than w isn't cut.
export function place(
  w: number,
  h: number,
  s: string,
  align: 'left' | 'center' = 'center',
  vertical: 'top' | 'center' = 'center',
): string {
  const sw = width(s);
  const sh = height(s);
  const x = align === 'left' ? 0 : Math.max(Math.floor((w - sw) / 2), 0);
  const y = vertical === 'top' ? 0 : Math.max(Math.floor((h - sh) / 2), 0);
  const rows = s.split('\n').map(l => pad(fill(x) + pad(l, sw), Math.max(w, sw + x)));
  return [...Array(y).fill(fill(w)), ...rows, ...Array(Math.max(h - y - sh, 0)).fill(fill(w))].join('\n');
}

// Centres a block across w cells and keeps its own height.
export const centerRow = (w: number, s: string): string => place(w, height(s), s);

// Draws content in a box with sharp corners. options.w and options.h size the inside, and long lines wrap to fit.
// The border is pri when focused, subtle when idle and the error colour when options.error is set.
export function box(
  content: string,
  focused = false,
  options: { w?: number; h?: number; padX?: number; padY?: number; error?: boolean } = {},
): string {
  const px = options.padX ?? 1;
  const py = options.padY ?? 0;
  const w = Math.max(options.w ?? width(content) + px * 2, px * 2);
  const h = Math.max(options.h ?? height(content) + py * 2, 0);
  const st: Style = options.error ? 'removed' : focused ? 'text' : 'faded';

  const rows = content.split('\n').flatMap(l => {
    if (width(l) <= w - 2 * px) return [l];
    return wrapStyled(l, w - 2 * px);
  });
  const inner = [...Array(py).fill(''), ...rows, ...Array(py).fill('')];
  while (inner.length < h) inner.push('');

  const edge = (a: string, b: string) => style(st, a + '─'.repeat(w) + b);
  return [
    edge('┌', '┐'),
    ...inner.map(l => style(st, '│') + fill(px) + pad(l, w - 2 * px) + fill(px) + style(st, '│')),
    edge('└', '┘'),
  ].join('\n');
}

// Wrapping

export function wrapPlain(s: string, w: number): string[] {
  return wrapStyled(printable(s), w);
}

// Word wraps styled text to w cells per line. Escape sequences travel with the next word, hyphens are break points
// and words longer than a line are split. The frozen TUI fixtures pin these exact break rules.
export function wrapStyled(s: string, w: number): string[] {
  if (w < 1) return [s];

  // out holds finished text, and current counts the cells on its last line. word and space wait until the next
  // break decides which line they go on.
  let out = '';
  let word = '';
  let space = '';
  let current = 0;
  let wordWidth = 0;
  let spaceWidth = 0;
  const addSpace = () => {
    out += space;
    current += spaceWidth;
    space = '';
    spaceWidth = 0;
  };
  const addWord = () => {
    if (!word) return;
    addSpace();
    out += word;
    current += wordWidth;
    word = '';
    wordWidth = 0;
  };
  const newline = () => {
    out += '\n';
    current = 0;
    space = '';
    spaceWidth = 0;
  };

  for (const token of s.match(/\x1b\[[0-?]*[ -/]*[@-~]|[^\x1b]+/g) ?? []) {
    if (token.startsWith('\x1b')) {
      word += token;
      continue;
    }
    for (const g of graphemes(token)) {
      const n = cellWidth(g);
      const ascii = g.length === 1 && g.charCodeAt(0) < 128;
      if (g === '\n') {
        // Keep trailing space only when it still fits on the line.
        if (!wordWidth) {
          if (current + spaceWidth <= w) out += space;
          space = '';
          spaceWidth = 0;
        }
        addWord();
        newline();
      } else if (g !== '\u00a0' && /^\s$/u.test(g)) {
        // Whitespace ends a word. A non-breaking space stays inside it.
        addWord();
        space += g;
        spaceWidth += n;
      } else if (g === '-') {
        // A hyphen commits the word before it, so the line can break after the hyphen. On a full line the
        // hyphen stays with the pending word instead.
        addSpace();
        if (current + wordWidth >= w) {
          word += g;
          wordWidth += n;
        } else {
          addWord();
          out += g;
          current += n;
        }
      } else {
        // Words longer than a line are split. ASCII splits once the word is exactly w cells, and wide characters
        // split before the word would pass w. A word that no longer fits moves to the next line.
        if (ascii && current === w) newline();
        if (!ascii && wordWidth + n > w) addWord();
        word += g;
        wordWidth += n;
        if (ascii && wordWidth === w) addWord();
        if (current + wordWidth + spaceWidth > w) newline();
      }
    }
  }

  if (!wordWidth) {
    if (current + spaceWidth <= w) out += space;
    space = '';
    spaceWidth = 0;
  }
  addWord();
  return out.split('\n');
}

// A wrapped paragraph in one style, with every line padded to w so the background is solid.
export function para(st: Style, s: string, w: number, centered = false): string {
  return wrapPlain(s, w)
    .map(l =>
      style(st, centered ? padPlain(' '.repeat(Math.max(Math.floor((w - width(l)) / 2), 0)) + l, w) : padPlain(l, w)),
    )
    .join('\n');
}

// Footer hints and list scrolling

// A footer shortcut such as '[h] help'.
export const hint = (key: string, label: string): string => style('bold', '[' + key + ']') + style('dim', ' ' + label);

// Joins hints three cells apart and drops them from the end until the row fits in w.
export function joinFit(hints: string[], w: number): string {
  hints = [...hints];
  while (hints.length) {
    const s = hints.join(fill(3));
    if (width(s) <= w) return s;
    hints.pop();
  }
  return '';
}

// Fits hints in w cells by shrinking the gaps from three cells to one, then dropping the second to last hint. The
// last hint goes only when it can't fit on its own.
export function fitHints(hints: string[], w: number): string {
  hints = [...hints];
  while (hints.length > 1) {
    for (const n of [3, 2, 1]) {
      const s = hints.join(fill(n));
      if (width(s) <= w) return s;
    }
    hints.splice(hints.length - 2, 1);
  }
  return joinFit(hints, w);
}

// First visible row of an n row list in an h row window, keeping the cursor near the middle.
export const windowTop = (cur: number, n: number, h: number): number =>
  n <= h ? 0 : Math.max(0, Math.min(cur - Math.trunc(h / 2), n - h));

// Value formatting

// Capitalises a message and adds a full stop unless it already ends with punctuation.
export const sentence = (s: string): string => {
  s = s.trim();
  if (!s) return '';
  return s[0].toUpperCase() + s.slice(1) + (/[.?!]$/.test(s) ? '' : '.');
};

// Shows the home folder as ~ and cuts long paths from the left. On Windows the home folder matches
// case-insensitively, with either kind of slash.
export function shortPath(p: string, w: number, home = homedir(), platform = process.platform): string {
  if (w <= 0) return '';
  if (!p) return '/';
  for (const h of [home.replaceAll('\\', '/'), home]) {
    if (
      (platform === 'win32' ? p.slice(0, h.length).toLowerCase() === h.toLowerCase() : p.startsWith(h)) &&
      (p.length === h.length || '/\\'.includes(p[h.length]))
    ) {
      p = '~' + p.slice(h.length);
      break;
    }
  }
  return truncateLeft(p, w);
}

// Sizes in decimal units with one decimal place, such as '4.1 MB'.
export function humanBytes(n: number): string {
  if (n < 1000) return n + ' B';
  let div = 1000,
    exp = 0;
  for (let m = Math.trunc(n / 1000); m >= 1000; m = Math.trunc(m / 1000)) {
    div *= 1000;
    exp++;
  }
  const value = n / div;

  // toFixed rounds an exact .25 up to .3, but the recorded output rounds halves to even and shows .2.
  return (value % 1 === 0.25 ? Math.trunc(value) + '.2' : value.toFixed(1)) + ' ' + 'kMGTPE'[exp] + 'B';
}

// Short relative time. Hours count up to two days, then it switches to days.
export function ago(t: string | Date, now = Date.now()): string {
  const d = now - new Date(t).getTime();
  if (d < 60000) return 'just now';
  if (d < 3600000) return Math.trunc(d / 60000) + 'm ago';
  if (d < 172800000) return Math.trunc(d / 3600000) + 'h ago';
  return Math.trunc(d / 86400000) + 'd ago';
}

// Wordmarks

const marks = new Map<boolean, string>();

// The Frost wordmark, or the icebreaker one for the game, read once from assets. It keeps the blank row of spaces
// at the bottom of each asset file.
export function rawWordmark(game = false): string {
  let mark = marks.get(game);
  if (mark === undefined) {
    mark = readFileSync(
      new URL('../../assets/wordmarks/' + (game ? 'icebreaker' : 'frost') + '-wordmark.txt', import.meta.url),
      'utf8',
    )
      .replaceAll('\r\n', '\n')
      .replace(/\n+$/, '');
    marks.set(game, mark);
  }
  return mark;
}

// The wordmark without its trailing blank row.
export function wordmark(game = false): string {
  return rawWordmark(game).replace(/[\n ]+$/, '');
}

// The wordmark when it fits in w by h cells, otherwise a small title tag.
export function logo(w: number, h: number): string {
  const mark = rawWordmark();
  return width(mark) > w || height(mark) > h ? style('title', 'FROST') : style('text', mark);
}
