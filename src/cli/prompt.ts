// Plain prompts drawn on the rail. Prompter reads the input stream itself, so answers can come from a
// terminal or a pipe.

import { StringDecoder } from 'node:string_decoder';
import { Block, Format, printable } from './format.js';

// Turns a declined or failed confirmation into a "cancelled" error.
export async function requireConfirmation(answer: Promise<boolean>): Promise<void> {
  let accepted: boolean;
  try {
    accepted = await answer;
  } catch (error) {
    throw new Error((error instanceof Error ? error.message : String(error)) + '\ncancelled', { cause: error });
  }
  if (!accepted) throw new Error('cancelled');
}

// The question waiting for input. `restore` undoes raw mode for a hidden answer.
interface Answer {
  hidden: boolean;
  text: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  restore?: () => void;
}

// A block that can also ask questions. Only one question waits at a time.
export class Prompter extends Block {
  private buffer = '';
  private ended = false;
  private decoder = new StringDecoder('utf8');
  private pending?: Answer;

  // These are the input handlers. The decoder keeps a character split across chunks in one piece.
  private read = (chunk: Buffer | string) => {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    this.drain();
  };
  private end = () => {
    this.buffer += this.decoder.end();
    this.ended = true;
    this.drain();
  };
  private readFailure = (error: Error) => {
    this.finish(undefined, error);
  };
  private abort = () => {
    this.finish(undefined, new Error('context canceled'));
  };

  constructor(
    fmt: Format,
    private input: NodeJS.ReadableStream,
    private tty = false,
    private signal?: AbortSignal,
  ) {
    super(fmt);
    input.on('data', this.read);
    input.once('end', this.end);
    input.on('error', this.readFailure);
    signal?.addEventListener('abort', this.abort);
  }

  private finish(value?: string, error?: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.restore?.();
    if (error) pending.reject(error);
    else pending.resolve((value ?? '').trim());
  }

  // Answers the waiting question from buffered input, if there's enough of it.
  private drain(): void {
    const pending = this.pending;
    if (!pending) return;

    if (pending.hidden) {
      // Raw mode delivers keys one at a time, so line editing happens here. ctrl+c cancels, ctrl+d ends
      // the input, backspace deletes a character, ctrl+u clears the line and ctrl+w deletes a word.
      while (this.buffer.length) {
        const c = String.fromCodePoint(this.buffer.codePointAt(0)!);
        this.buffer = this.buffer.slice(c.length);
        if (c === '\x03') {
          this.finish(undefined, new Error('context canceled'));
          return;
        }
        if (c === '\r' || c === '\n') {
          if (c === '\r' && this.buffer.startsWith('\n')) this.buffer = this.buffer.slice(1);
          this.finish(pending.text);
          return;
        }
        if (c === '\x04') {
          this.finish(undefined, new Error('no answer (input closed)'));
          return;
        }
        if (c === '\x7f' || c === '\b') pending.text = [...pending.text].slice(0, -1).join('');
        else if (c === '\x15') pending.text = '';
        else if (c === '\x17') pending.text = pending.text.replace(/\s*\S+\s*$/, '');
        else if (c >= ' ') pending.text += c;
      }
      if (this.ended) this.finish(undefined, new Error('no answer (input closed)'));
    } else {
      // A visible answer is one line. A last line without a newline still counts when the input ends.
      const next = this.buffer.indexOf('\n');
      if (next >= 0) {
        const line = this.buffer.slice(0, next);
        this.buffer = this.buffer.slice(next + 1);
        this.finish(line);
      } else if (this.ended) {
        const line = this.buffer;
        this.buffer = '';
        this.finish(line || undefined, line ? undefined : new Error('no answer (input closed)'));
      }
    }
  }

  // Waits for the next answer. A hidden answer puts the terminal in raw mode so nothing typed is echoed.
  private lineAnswer(hidden = false): Promise<string> {
    if (this.pending) return Promise.reject(new Error('a prompt is already waiting for input'));
    if (this.signal?.aborted) return Promise.reject(new Error('context canceled'));
    return new Promise((resolve, reject) => {
      let restore: (() => void) | undefined;
      if (hidden) {
        const stdin = this.input as NodeJS.ReadStream,
          wasRaw = stdin.isRaw;
        stdin.setRawMode(true);
        stdin.resume();
        restore = () => {
          stdin.setRawMode(!!wasRaw);
          this.fmt.write('\n');
        };
      }
      this.pending = { hidden, text: '', resolve, reject, restore };
      this.drain();
    });
  }

  async answer(): Promise<string> {
    return this.lineAnswer();
  }

  // Writes a question on the rail and leaves the cursor after it.
  question(q: string): void {
    this.fmt.write(this.fmt.railed(q) + ' ');
  }

  async ask(q: string, def = ''): Promise<string> {
    this.question(q + (def ? ' ' + this.fmt.dim('[' + printable(def) + ']') : ''));
    return (await this.answer()) || def;
  }

  async required(q: string, def = ''): Promise<string> {
    for (;;) {
      const s = await this.ask(q, def);
      if (s) return s;
      this.line(this.fmt.dim("  this one's required"));
    }
  }

  // Without a terminal there's nothing to hide from, so the answer is read as a normal line.
  async hidden(): Promise<string> {
    if (!this.tty || !(this.input as NodeJS.ReadStream).setRawMode) return this.answer();
    return this.lineAnswer(true);
  }

  // Asks for a secret without echoing it. An empty answer keeps `current`.
  async secret(q: string, current = ''): Promise<string> {
    for (;;) {
      this.question(q + (current ? ' ' + this.fmt.dim('[enter keeps the current one]') : ''));
      const s = await this.hidden();
      if (s || current) return s || current;
      this.line(this.fmt.dim("  this one's required"));
    }
  }

  async yesNo(q: string, def: boolean): Promise<boolean> {
    for (;;) {
      this.question(q + ' ' + this.fmt.dim(def ? '[Y/n]' : '[y/N]'));
      const s = (await this.answer()).toLowerCase();
      if (!s) return def;
      if (s === 'y' || s === 'yes') return true;
      if (s === 'n' || s === 'no') return false;
    }
  }

  // Goes ahead only if the user types `word` exactly.
  async confirm(word: string, to: string): Promise<boolean> {
    return (await this.ask('Type ' + this.fmt.bold(word) + ' to ' + to + ':')) === word;
  }

  // Lists numbered options and returns the index picked. A `def` of -1 means there's no default.
  async choose(q: string, options: string[], def: number): Promise<number> {
    this.line(q);
    options.forEach((o, i) => this.line('  ' + this.fmt.bold('[' + (i + 1) + ']') + ' ' + o));
    for (;;) {
      this.question((def >= 0 ? this.fmt.dim('[' + (def + 1) + ']') + ' ' : '') + '>');
      const s = await this.answer();
      if (!s && def >= 0) return def;
      const n = /^\d+/.exec(s);
      if (n && Number(n[0]) >= 1 && Number(n[0]) <= options.length) return Number(n[0]) - 1;
      this.line(this.fmt.dim('  type a number from 1 to ' + options.length));
    }
  }

  // A comma-separated answer. A lone `-` clears the list.
  async list(q: string, def: string[]): Promise<string[]> {
    return (await this.ask(q, def.join(', ')))
      .split(',')
      .map(s => s.trim())
      .filter(s => s && s !== '-');
  }

  // Fails any waiting question and lets go of the input, so the process can exit.
  async closeInput(): Promise<void> {
    this.finish(undefined, new Error('no answer (input closed)'));
    this.input.off('data', this.read);
    this.input.off('end', this.end);
    this.input.off('error', this.readFailure);
    this.signal?.removeEventListener('abort', this.abort);
    if (this.tty) this.input.pause();
    this.buffer = '';
  }
}
