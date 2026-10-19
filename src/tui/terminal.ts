// This module runs a full-screen TUI model in the terminal. It decodes raw key input, redraws the
// model's view and drives the spinner and game timers, then puts the terminal back as it was.

import { StringDecoder } from 'node:string_decoder';
import type { KeyEvent } from './input.js';
import { convertProfile, terminalProfile, type ColorProfile } from '../cli/terminal.js';

// TerminalModel is what runTerminal needs from a screen. animation() asks for regular redraws.
// 'game' calls tick every 50 ms, and 'spinner' advances spin every 100 ms. runTerminal sets onChange and
// suspend while it runs.
interface TerminalModel {
  w: number;
  h: number;
  spin: number;
  exited: boolean;
  onChange?: () => void;
  suspend?: <T>(work: () => Promise<T>) => Promise<T>;
  resize(w: number, h: number): void;
  view(): string;
  onKey(e: KeyEvent | string): void | Promise<void>;
  animation?(): 'game' | 'spinner' | undefined;
  tick?(): void;
  close?(): void;
}

// now is the clock in milliseconds that paces the game. Tests pass a fake.
export interface TerminalOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  signal?: AbortSignal;
  colorProfile?: ColorProfile;
  now?: () => number;
}

// sequences maps escape sequences to key names. Terminals send arrows, home and end in either
// the ESC [ or the ESC O form.
const sequences: Record<string, string> = {
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1bOA': 'up',
  '\x1bOB': 'down',
  '\x1bOC': 'right',
  '\x1bOD': 'left',
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1bOH': 'home',
  '\x1bOF': 'end',
  '\x1b[1~': 'home',
  '\x1b[4~': 'end',
  '\x1b[7~': 'home',
  '\x1b[8~': 'end',
  '\x1b[2~': 'insert',
  '\x1b[3~': 'delete',
  '\x1b[5~': 'pgup',
  '\x1b[6~': 'pgdown',
  '\x1b[Z': 'shift+tab',
  '\x1b[1;5D': 'ctrl+left',
  '\x1b[1;5C': 'ctrl+right',
  '\x1b[1;3D': 'alt+left',
  '\x1b[1;3C': 'alt+right',
};
const sequenceKeys = Object.keys(sequences);

// Turns raw terminal input into key events. Reads can split a character, an escape sequence
// or a paste anywhere, so unfinished input waits in pending for the next read.
export class InputDecoder {
  private pending = '';
  private paste = false;
  private pasted = '';
  private decoder = new StringDecoder('utf8');

  feed(data: Buffer | string): KeyEvent[] {
    this.pending += typeof data === 'string' ? data : this.decoder.write(data);
    const out: KeyEvent[] = [];
    while (this.pending) {
      // Inside a bracketed paste, everything up to the end marker becomes one text event.
      // The last few characters wait in case they're the start of a split end marker.
      if (this.paste) {
        const end = this.pending.indexOf('\x1b[201~');
        if (end < 0) {
          const keep = Math.min(this.pending.length, 5);
          this.pasted += this.pending.slice(0, -keep || undefined);
          this.pending = this.pending.slice(-keep);
          break;
        }
        this.pasted += this.pending.slice(0, end);
        out.push({ key: 'text', text: this.pasted });
        this.pasted = '';
        this.paste = false;
        this.pending = this.pending.slice(end + 6);
        continue;
      }
      if (this.pending.startsWith('\x1b[200~')) {
        this.paste = true;
        this.pending = this.pending.slice(6);
        continue;
      }

      if (this.pending[0] === '\x1b') {
        const exact = sequenceKeys.find(s => this.pending.startsWith(s));
        if (exact) {
          out.push({ key: sequences[exact], alt: sequences[exact].startsWith('alt+') });
          this.pending = this.pending.slice(exact.length);
          continue;
        }

        // Wait for more input after a partial sequence. A lone escape is left for flushEscape.
        if (
          this.pending === '\x1b' ||
          sequenceKeys.some(s => s.startsWith(this.pending)) ||
          '\x1b[200~'.startsWith(this.pending)
        )
          break;

        // Unknown CSI sequences are dropped whole.
        if (this.pending[1] === '[') {
          const csi = /^\x1b\[[0-?]*[ -/]*[@-~]/.exec(this.pending);
          if (!csi) break;
          this.pending = this.pending.slice(csi[0].length);
          continue;
        }

        // Escape followed by anything else is that key with alt held.
        const r = String.fromCodePoint(this.pending.codePointAt(1)!);
        out.push({ key: 'alt+' + (r === '\x7f' ? 'backspace' : r === '\r' ? 'enter' : r), alt: true });
        this.pending = this.pending.slice(1 + r.length);
        continue;
      }

      // Anything else is one ordinary character. Control characters get key names, and printable
      // ones carry their text.
      const r = String.fromCodePoint(this.pending.codePointAt(0)!);
      this.pending = this.pending.slice(r.length);
      const c = r.codePointAt(0)!;
      let key: string;
      if (r === '\r' || r === '\n') key = 'enter';
      else if (r === '\t') key = 'tab';
      else if (c === 0x7f || c === 8) key = 'backspace';
      else if (c > 0 && c < 27) key = 'ctrl+' + String.fromCharCode(96 + c);
      else key = r;
      out.push({
        key,
        ...(c >= 32 && c !== 127 && r !== ' ' ? { text: r } : {}),
      });
    }
    return out;
  }

  // runTerminal calls this once input goes quiet. An escape still waiting by itself was the esc key.
  flushEscape(): KeyEvent[] {
    if (this.pending === '\x1b') {
      this.pending = '';
      return [{ key: 'esc' }];
    }
    return [];
  }
}

// Takes over the terminal until the model exits, input ends or the signal aborts. The terminal's
// previous mode comes back on the way out, after errors too.
export async function runTerminal(model: TerminalModel, options: TerminalOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!input.isTTY || !output.isTTY)
    throw new Error('could not open a new TTY: terminal input and output are required');

  const decoder = new InputDecoder();
  const wasRaw = input.isRaw;
  const profile = options.colorProfile ?? terminalProfile(true);
  const now = options.now ?? (() => performance.now());
  let escaped: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let suspended = false;

  const resize = () => {
    model.resize(output.columns ?? 80, output.rows ?? 24);
    draw();
  };
  // Each frame overwrites the last one from the top-left corner, in the colours the terminal supports.
  const draw = () => {
    if (!finished && !suspended)
      output.write('\x1b[H' + convertProfile(model.view(), profile).replaceAll('\n', '\r\n'));
  };

  // Draws straight after the key so a busy state shows, then again once an async handler settles.
  const effect = (e: KeyEvent) => {
    try {
      const result = model.onKey(e);
      draw();
      Promise.resolve(result).then(() => {
        if (model.exited) finish();
        else draw();
      }, fail);
    } catch (err) {
      fail(err);
    }
  };

  // The promise below assigns these, next to the listeners they remove.
  let finish: () => void;
  let fail: (e: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    // Runs once. Stops the timers and listeners, closes the model and restores the input mode,
    // then turns off bracketed paste, shows the cursor and leaves the alternate screen.
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (game) clearTimeout(game);
      if (escaped) clearTimeout(escaped);
      input.off('data', data);
      input.off('error', fail);
      input.off('end', finish);
      output.off('error', fail);
      output.off('resize', resize);
      options.signal?.removeEventListener('abort', finish);
      model.close?.();
      model.onChange = undefined;
      model.suspend = undefined;
      input.setRawMode(wasRaw ?? false);
      input.pause();
      output.write('\x1b[?2004l\x1b[?25h\x1b[?1049l');
    };
    finish = () => {
      cleanup();
      resolve();
    };
    fail = (e: unknown) => {
      cleanup();
      reject(e);
    };

    // A lone escape could be the start of a sequence, so it only counts as esc after 30 ms of quiet.
    const data = (buf: Buffer) => {
      if (escaped) clearTimeout(escaped);
      for (const e of decoder.feed(buf)) effect(e);
      escaped = setTimeout(() => {
        for (const e of decoder.flushEscape()) effect(e);
      }, 30);
    };

    // Hands the terminal to work that needs it, like ssh asking for a password. Keys stop being read, and the
    // normal screen, cursor and input mode come back while it runs. Then the full screen returns and redraws.
    const suspend = async <T>(work: () => Promise<T>): Promise<T> => {
      suspended = true;
      input.off('data', data);
      if (escaped) clearTimeout(escaped);
      input.setRawMode(wasRaw ?? false);
      input.pause();
      output.write('\x1b[?2004l\x1b[?25h\x1b[?1049l');
      try {
        return await work();
      } finally {
        suspended = false;
        if (!finished) {
          output.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
          input.setRawMode(true);
          input.on('data', data);
          input.resume();
          resize();
        }
      }
    };

    // Game ticks follow the clock, because a Windows timer can fire up to a 15.6 ms clock tick late, and counting
    // firings would run the game at 16 ticks a second. Each tick aims the next 50 ms after its own due time. After a
    // stall, one tick catches up and the rest of the backlog is dropped.
    let game: ReturnType<typeof setTimeout> | undefined;
    let tickAt = 0;
    const play = () => {
      game = undefined;
      if (finished || model.animation?.() !== 'game') return;
      const t = now();
      if (t >= tickAt) {
        model.tick?.();
        draw();
        tickAt = tickAt + 50 > t ? tickAt + 50 : t;
      }
      game = setTimeout(play, Math.max(0, tickAt - now()));
    };

    // Starts the game ticks and the spinner, and notices a model that exits without a key press.
    let spinAt = Date.now();
    const timer = setInterval(() => {
      const animation = model.animation?.();
      if (animation === 'game' && !game) {
        tickAt = now();
        play();
      } else if (animation === 'spinner' && Date.now() - spinAt >= 100) {
        spinAt = Date.now();
        model.spin++;
        draw();
      }
      if (model.exited) finish();
    }, 50);

    model.onChange = draw;
    model.suspend = suspend;
    input.on('data', data);
    input.on('error', fail);
    input.on('end', finish);
    output.on('error', fail);
    output.on('resize', resize);
    options.signal?.addEventListener('abort', finish, { once: true });

    // Switch to the alternate screen, hide the cursor and turn on bracketed paste.
    output.write('\x1b[?1049h\x1b[?25l\x1b[?2004h');
    input.setRawMode(true);
    input.resume();
    resize();
    if (options.signal?.aborted) finish();
  });
  await promise;
}
