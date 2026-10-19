// `frost init` runs this setup wizard. SetupModel walks through storage, folders, skip patterns,
// schedule and the recovery phrase, then hands everything to SetupDeps.finish to save.

import { addPath as coreAddPath } from '../core/config.js';
import { permafrostKeyPage } from '../core/storage.js';
import { Excluder } from '../engine/exclude.js';
import type { Config, Storage, Key } from './types.js';
import { Form, problem, inputBox, type KeyEvent } from './input.js';
import { providers, choices, choiceOf, selfHosted, matchProvider, describeStorage, projectLink } from './providers.js';
import {
  style,
  width,
  height,
  setupHeight,
  pad,
  padPlain,
  truncate,
  fill,
  blank,
  stack,
  place,
  centerRow,
  clip,
  para,
  fitHints,
  hint,
  sentence,
  box,
  logo,
  rawWordmark,
  cutStyled,
} from './render.js';
import { runTerminal, type TerminalOptions } from './terminal.js';

// What setup found when it connected. New has no backups yet, and LocalOK has backups this
// machine's key opens. NeedsPhrase and LocalWrong have backups that need their recovery phrase,
// because there's no local key or it's a different one.
export enum RepoState {
  New,
  LocalOK,
  NeedsPhrase,
  LocalWrong,
}

// Thrown when a connection fails because of one setting. about matches a Field's about, so setup
// can put the cursor on the field to fix.
export class ConnectError extends Error {
  constructor(
    public about: string,
    message: string,
  ) {
    super(message);
  }
}

// SetupDeps holds everything setup does outside the screen. The CLI supplies the real versions,
// and tests and the demo stub them.
export interface SetupDeps {
  localKey?: Key;
  // acceptNewHostKey trusts a self-hosted server's SSH host key the first time it's seen, after someone added
  // frost's key to it by hand.
  connect(s: Storage, signal?: AbortSignal, options?: { acceptNewHostKey?: boolean }): Promise<RepoState>;
  newKey(): Key | Promise<Key>;
  unlock(s: Storage, phrase: string, signal?: AbortSignal): Promise<Key>;
  // Creates the repository if it's new, saves the config and key, and returns the rows of the
  // summary printed afterwards.
  finish(cfg: Config, key: Key, newRepo: boolean, signal?: AbortSignal): Promise<[string, string][]>;
  // Picks the two phrase words the user types back, as zero-based indexes.
  pickWords(): [number, number];
  dirExists?(p: string): boolean;
  // Says where this machine's existing backups are, when that's somewhere other than s.
  elsewhere?(s: Storage): string;
  // Opens a web page in the browser, like the page where people get a Permafrost key.
  openBrowser?(url: string): void;
  // Adds frost's SSH key to a self-hosted server with ssh, which asks for the password in the terminal.
  addKey?(s: Storage): Promise<void>;
  // Where frost's public SSH key is, as setup shows it, and a way to show the file in the file manager.
  keyFile?(): string;
  reveal?(file: string): void;
  // Cleans up a typed folder path and returns the indexes of listed folders inside it.
  addPath?(
    typed: string,
    paths: string[],
  ): { clean: string; inside: number[] } | Promise<{ clean: string; inside: number[] }>;
}

interface SetupResult {
  saved: boolean;
  rows: [string, string][];
}

// stepOf groups the wizard's screens into the five steps the header shows.
type SetupStep =
  | 'welcome'
  | 'storage'
  | 'permaChoice'
  | 's3Choice'
  | 'details'
  | 'keyChoice'
  | 'keyManual'
  | 'folders'
  | 'skip'
  | 'schedule'
  | 'phrase'
  | 'check'
  | 'unlock'
  | 'review'
  | 'done';

// stepNames holds the header labels for steps 1 to 5. Welcome and done are step 0 and have no header.
const stepNames = ['', 'storage', 'folders', 'schedule', 'recovery phrase', 'review'];

function stepOf(s: SetupStep): number {
  if (['storage', 'permaChoice', 's3Choice', 'details', 'keyChoice', 'keyManual'].includes(s)) return 1;
  if (['folders', 'skip'].includes(s)) return 2;
  if (s === 'schedule') return 3;
  if (['phrase', 'check', 'unlock'].includes(s)) return 4;
  if (s === 'review') return 5;
  return 0;
}

// Turns a schedule value like daily or 6h into the label shown in the schedule list.
function schedLabel(v: string): string {
  if (['hourly', 'daily', 'weekly'].includes(v)) return v[0].toUpperCase() + v.slice(1);
  if (v === 'off') return "Off, I'll run `frost backup` myself";
  return 'Every ' + v.replace(/h$/, '') + ' hours';
}

// Splits a comma-separated list of skip patterns, dropping empty entries and a lone -.
const splitList = (s: string): string[] =>
  s
    .split(',')
    .map(v => v.trim())
    .filter(v => v && v !== '-');

// Draws one radio-button row. Names are padded to nameW so the notes after them line up.
export function choice(on: boolean, name: string, note: string, nameW: number, w: number): string {
  nameW = Math.min(nameW, Math.max(w - 5, 0));
  let label = ' ( ) ' + padPlain(truncate(name, nameW), nameW);
  if (note) label += ' ';
  return on
    ? style('selected', padPlain(truncate(label.replace('( )', '(•)') + note, w), w))
    : pad(style('text', label) + style('dim', truncate(note, Math.max(w - width(label), 0))), w);
}

// Fits a list into n rows, scrolled to keep the selection in view, with "more" markers for the
// rows above and below. A selection below 0 means the input box has focus, so the end stays in view.
function listRows(
  items: string[],
  sel: number,
  n: number,
  w: number,
  row: (i: number, on: boolean) => string,
): string[] {
  if (n <= 0 || !items.length) return [];

  let from = 0;
  let to = items.length;
  if (items.length > n) {
    const show = Math.max(n - 2, 1);
    const at = sel < 0 ? items.length - 1 : sel;
    from = Math.min(Math.max(at - Math.trunc(show / 2), 0), items.length - show);
    to = from + show;
  }

  const out: string[] = [];
  const more = items.length - to;
  if (n === 2 && from > 0 && more > 0) out.push(pad(style('dim', ` ↑ ${from} more, ↓ ${more} more`), w));
  else if (n > 1 && from > 0) out.push(pad(style('dim', ` ↑ ${from} more`), w));
  for (let i = from; i < to; i++) out.push(row(i, i === sel));
  if (more > 0 && out.length < n) out.push(pad(style('dim', ` ↓ ${more} more`), w));
  return out;
}

// One wizard page, top to bottom: over, question, sub, body, then help, foot and extra when they
// fit. feedback joins errors and notes in the area pgup and pgdn scroll, which goes above the body
// when feedbackFirst is set.
interface Page {
  over?: string;
  question: string;
  good?: boolean;
  sub?: string;
  body: string[];
  help?: string;
  foot?: string;
  extra?: string[];
  feedback?: string;
  feedbackFirst?: boolean;
}

// Cuts text to h lines, ending the last one with "..." when anything was cut.
function limitSetupLines(s: string, w: number, h: number): string {
  if (h <= 0 || !s) return '';
  const lines = s.split('\n');
  if (lines.length <= h) return s;
  lines.length = h;
  lines[h - 1] = pad(cutStyled(lines[h - 1], Math.max(w - 3, 0)) + style('dim', '...'), w);
  return lines.join('\n');
}

// SetupModel holds the wizard's state. onKey moves between screens and view draws the current one.
// Slow work sets busy, which shows a spinner and ignores every key except ctrl+c until it's done.
export class SetupModel {
  private readonly controller = new AbortController();

  // These track the window and the current screen. back is the history esc walks back through.
  w = 0;
  h = 0;
  step: SetupStep = 'welcome';
  back: SetupStep[] = [];
  spin = 0;
  busy = '';
  quit = false;
  exited = false;

  // err and note show under the page, and feedbackTop is how far pgup and pgdn have scrolled them.
  err = '';
  note = '';
  feedbackTop = 0;

  // provCur is the highlighted choice in the storage list and s3Cur the highlighted S3 service. prov is the
  // provider whose form is open, and pending holds the storage settings being tried. keyCur is the highlighted
  // way of adding frost's SSH key.
  provCur = 0;
  s3Cur = 0;
  prov = 0;
  keyCur = 0;
  details = new Form();
  pending: Storage;
  connected = false;
  state = RepoState.New;
  elsewhere = '';
  autoTried = false;
  permaCur = 0;

  // In the folders and skip lists, a selection of -1 means the input box has focus.
  folderIn = new Form([{ placeholder: 'type a path, like ~/Pictures' }]);
  folderSel = -1;
  skipIn = new Form([{ placeholder: 'type a name or pattern, like *.iso' }]);
  skipSel = -1;
  schedCur = 0;

  // keyReady means the key is settled for the connected storage, and seenWords means the phrase
  // has been shown at least once.
  key?: Key;
  newRepo = false;
  keyReady = false;
  showWords = false;
  seenWords = false;
  check = new Form();
  checkIdx: [number, number] = [0, 0];
  phrase = new Form();

  // revCur and showKey belong to review. visited holds the steps advance doesn't need to ask again.
  revCur = 0;
  showKey = false;
  visited = new Set<SetupStep>();
  saved = false;
  savedRows: [string, string][] = [];

  // runTerminal sets these. Async work calls onChange to redraw, and suspend hands the terminal to work that
  // needs it, like ssh asking for a password.
  onChange?: () => void;
  suspend?: <T>(work: () => Promise<T>) => Promise<T>;

  // Works on a copy of the config, so nothing changes until finish saves it. An existing setup
  // starts with its folders, skip list and schedule visited, so advance can go straight to review.
  constructor(
    public deps: SetupDeps,
    public cfg: Config,
    public existing = false,
    public signal?: AbortSignal,
  ) {
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    this.cfg = structuredClone(cfg);
    this.pending = structuredClone(cfg.storage);
    if (existing) for (const s of ['folders', 'skip', 'schedule'] as SetupStep[]) this.visited.add(s);
    this.highlight(matchProvider(cfg.storage));
    this.schedCur = Math.max(this.schedOptions().indexOf(this.schedValue()), 0);
  }

  animation(): 'spinner' | undefined {
    return this.busy ? 'spinner' : undefined;
  }

  // Cancels anything still using the wizard's signal.
  close(): void {
    this.controller.abort();
  }

  resize(w: number, h: number): void {
    this.w = Math.max(w, 0);
    this.h = Math.max(h, 0);
    this.feedbackTop = Math.min(this.feedbackTop, this.feedbackWindow()[1]);
  }

  // Shows another screen and remembers this one, so esc can come back to it.
  goTo(s: SetupStep): void {
    if (s !== this.step) this.back.push(this.step);
    this.step = s;
    this.err = '';
    this.feedbackTop = 0;
  }

  goBack(): void {
    if (this.back.length) {
      this.step = this.back.pop()!;
      this.err = '';
      this.feedbackTop = 0;
      this.showWords = false;
    }
  }

  // Moves to the first step that still needs an answer. An existing setup tries its saved storage
  // once first, so a working config goes straight on.
  async advance(): Promise<void> {
    if (!this.connected) {
      if (this.existing && !this.autoTried && this.cfg.storage.backend) {
        this.autoTried = true;
        return this.connect(this.cfg.storage);
      }
      this.goTo('storage');
    } else if (!this.visited.has('folders')) {
      this.folderSel = -1;
      this.goTo('folders');
    } else if (!this.visited.has('skip')) {
      this.skipSel = -1;
      this.goTo('skip');
    } else if (!this.visited.has('schedule')) this.goTo('schedule');
    else if (!this.keyReady) await this.keyStep();
    else this.goTo('review');
  }

  // Settles the key for the connected storage. New backups use this machine's key, or a new key
  // whose phrase the user writes down. Existing backups the local key can't open need their phrase.
  async keyStep(): Promise<void> {
    const local = this.deps.localKey;
    if (this.state === RepoState.LocalOK) {
      this.key = local;
      this.newRepo = false;
      this.keyReady = true;
      return this.advance();
    }

    if (this.state === RepoState.New) {
      this.newRepo = true;
      if (local) {
        this.key = local;
        this.keyReady = true;
        return this.advance();
      }
      // Keep a key made earlier, so the phrase doesn't change when the user comes back to this step.
      if (!this.key || this.key === local) {
        try {
          this.key = await this.deps.newKey();
        } catch (e) {
          this.err = message(e);
          return;
        }
      }
      this.showWords = this.seenWords = false;
      this.goTo('phrase');
      return;
    }

    this.phrase = new Form([{ secret: true, placeholder: 'all 24 words, separated by spaces' }]);
    this.goTo('unlock');
  }

  // Highlights a provider in the storage list, and in the S3 list when it's an S3 service.
  highlight(provider: number): void {
    this.provCur = choiceOf(provider);
    if (choices[this.provCur].providers.length > 1) this.s3Cur = choices[this.provCur].providers.indexOf(provider);
  }

  // Tries storage settings and keeps them if they work. A failure opens that provider's form with
  // the error, and puts the cursor on the field the error is about. A self-hosted server that won't
  // take frost's SSH key yet goes to the screen for adding it instead.
  async connect(s: Storage, options?: { acceptNewHostKey?: boolean }): Promise<void> {
    this.busy = 'Connecting to your storage';
    this.err = '';
    this.pending = structuredClone(s);
    this.onChange?.();
    try {
      const state = await this.deps.connect(s, this.signal, options);

      // New settings or a different repository state mean the key step has to run again.
      if (
        JSON.stringify(this.cfg.storage) !== JSON.stringify(this.pending) ||
        !this.connected ||
        this.state !== state
      ) {
        this.keyReady = false;
        if (this.key === this.deps.localKey) this.key = undefined;
      }
      this.cfg.storage = this.pending;
      this.connected = true;
      this.state = state;
      this.elsewhere = state === RepoState.New ? (this.deps.elsewhere?.(this.pending) ?? '') : '';
      this.busy = '';
      await this.advance();
    } catch (e) {
      const login = e instanceof ConnectError && e.about === 'login' && this.pending.backend === 'sftp';
      if (login && (this.step === 'keyChoice' || this.step === 'keyManual')) {
        this.err = message(e);
        return;
      }

      // Open the form for these settings unless it's already showing. The default server's Permafrost
      // form sits behind permaChoice in the history, and an S3 service's behind the S3 list, so esc goes
      // back there.
      if (this.step !== 'details') {
        const p = matchProvider(this.pending);
        this.openDetails(p);
        if (p === 0 && !this.pending.permafrost.url) {
          this.back.push(this.step);
          this.step = 'permaChoice';
        } else if (choices[choiceOf(p)].providers.length > 1) {
          this.back.push(this.step);
          this.step = 's3Choice';
        }
        this.goTo('details');
      }
      if (login) {
        this.keyCur = 0;
        this.goTo('keyChoice');
        return;
      }
      if (e instanceof ConnectError) {
        const i = this.details.fields.findIndex(f => f.about === e.about);
        if (i >= 0) this.details.focus = i;
      }
      this.err = message(e);
    } finally {
      this.busy = '';
      this.feedbackTop = 0;
      this.onChange?.();
    }
  }

  // Hands the terminal to ssh, which adds frost's key to the server once the password is typed, then connects
  // again. Without a terminal to hand over, as in tests, it runs as it is.
  async addKey(): Promise<void> {
    const run = () => this.deps.addKey!(this.pending);
    try {
      await (this.suspend ? this.suspend(run) : run());
    } catch (e) {
      this.err = "The key wasn't added: " + message(e).replace(/\.$/, '') + '.';
      return;
    }
    await this.connect(this.pending);
  }

  // True while keys go into a text box, so letters like q type instead of acting as shortcuts.
  typing(): boolean {
    return (
      ['details', 'check', 'unlock'].includes(this.step) ||
      (this.step === 'folders' && this.folderSel < 0) ||
      (this.step === 'skip' && this.skipSel < 0)
    );
  }

  async onKey(event: string | KeyEvent): Promise<void> {
    const e = typeof event === 'string' ? { key: event } : event;
    const key = e.key;
    if (key === 'ctrl+c') {
      this.exited = true;
      return;
    }
    if (this.busy) return;

    // pgup and pgdn scroll the feedback area a page at a time.
    if (key === 'pgup' || key === 'pgdown') {
      const [rows, top] = this.feedbackWindow();
      this.feedbackTop = Math.min(
        Math.max(this.feedbackTop + (key === 'pgup' ? -1 : 1) * Math.max(rows - 1, 1), 0),
        top,
      );
      return;
    }

    if (this.quit) {
      if (key === 'y') {
        this.exited = true;
      } else if (key === 'n' || key === 'esc') this.quit = false;
      return;
    }

    // Any other key clears the last message. q asks before quitting, except on the welcome
    // screen where nothing has changed yet.
    this.err = this.note = '';
    this.feedbackTop = 0;
    if (!this.typing() && key === 'q' && this.step !== 'done') {
      if (this.step === 'welcome') this.exited = true;
      else this.quit = true;
      return;
    }

    switch (this.step) {
      case 'welcome':
        if (key === 'enter') await this.advance();
        else if (key === 'esc') this.exited = true;
        break;

      case 'storage': {
        const c = choices[this.provCur];
        if (['up', 'k'].includes(key)) this.provCur = Math.max(this.provCur - 1, 0);
        else if (['down', 'j'].includes(key)) this.provCur = Math.min(this.provCur + 1, choices.length - 1);
        else if (key === 'enter') {
          // A custom Permafrost server hands out keys its own way, so it goes straight to the key.
          if (!this.provCur && !this.cfg.storage.permafrost.url) {
            this.permaCur = 0;
            this.goTo('permaChoice');
          } else if (c.providers.length > 1) this.goTo('s3Choice');
          else {
            this.openDetails(c.providers[0]);
            this.goTo('details');
          }
        } else if (key === 'esc') this.goBack();
        else if (/^[1-9]$/.test(key) && +key <= choices.length) this.provCur = +key - 1;
        break;
      }

      case 's3Choice': {
        const list = choices[this.provCur].providers;
        if (['up', 'k'].includes(key)) this.s3Cur = Math.max(this.s3Cur - 1, 0);
        else if (['down', 'j'].includes(key)) this.s3Cur = Math.min(this.s3Cur + 1, list.length - 1);
        else if (key === 'enter') {
          this.openDetails(list[this.s3Cur]);
          this.goTo('details');
        } else if (key === 'esc') this.goBack();
        else if (/^[1-9]$/.test(key) && +key <= list.length) this.s3Cur = +key - 1;
        break;
      }

      case 'keyChoice':
        if (['up', 'k', '1'].includes(key)) this.keyCur = 0;
        else if (['down', 'j', '2'].includes(key)) this.keyCur = 1;
        else if (key === 'esc') this.goBack();
        else if (key === 'enter') {
          if (this.keyCur) this.goTo('keyManual');
          else await this.addKey();
        }
        break;

      // The key was added by hand, so the server's host key may be new to this computer too.
      case 'keyManual':
        if (key === 'enter') await this.connect(this.pending, { acceptNewHostKey: true });
        else if (key === 'o') this.deps.reveal?.(this.deps.keyFile?.() ?? '');
        else if (key === 'esc') this.goBack();
        break;

      case 'permaChoice':
        if (['up', 'k', '1'].includes(key)) this.permaCur = 0;
        else if (['down', 'j', '2'].includes(key)) this.permaCur = 1;
        else if (key === 'esc') this.goBack();
        else if (key === 'enter') {
          // Without a key, the key page opens in the browser and the key is pasted here.
          if (this.permaCur) this.deps.openBrowser?.(permafrostKeyPage);
          this.openDetails(0);
          this.goTo('details');
        }
        break;

      // esc steps back a field before it leaves the form. enter checks the field, then moves to
      // the next one, or connects after the last.
      case 'details':
        if (key === 'esc') {
          if (this.details.focus > 0) this.details.focus--;
          else this.goBack();
        } else if (key === 'tab' && this.details.fields[this.details.focus].secret)
          this.details.reveal = !this.details.reveal;
        else if (this.details.key(e)) {
          const err = problem(this.details.fields[this.details.focus]);
          if (err) this.err = err;
          else if (this.details.focus < this.details.fields.length - 1) this.details.focus++;
          else {
            const st = structuredClone(this.cfg.storage);
            providers[this.prov].apply(this.details.values(), st);
            await this.connect(st);
          }
        }
        break;

      case 'folders':
        await this.listInputKey(e, false);
        break;

      case 'skip':
        await this.listInputKey(e, true);
        break;

      case 'schedule': {
        const opts = this.schedOptions();
        if (['up', 'k'].includes(key)) this.schedCur = Math.max(this.schedCur - 1, 0);
        else if (['down', 'j'].includes(key)) this.schedCur = Math.min(this.schedCur + 1, opts.length - 1);
        else if (key === 'esc') this.goBack();
        else if (key === 'enter') {
          const v = opts[this.schedCur];
          this.cfg.schedule.enabled = v !== 'off';
          if (v !== 'off') this.cfg.schedule.every = v;
          this.visited.add('schedule');
          await this.advance();
        }
        break;
      }

      // The words have to be shown at least once before the check.
      case 'phrase':
        if (key === 'v') {
          this.showWords = !this.showWords;
          this.seenWords = true;
        } else if (key === 'esc') this.goBack();
        else if (key === 'enter') {
          if (!this.seenWords) this.err = 'Press [v] to show the words, and write them down first.';
          else {
            this.checkIdx = this.deps.pickWords();
            const [i, j] = this.checkIdx;
            this.check = new Form([
              { question: "Let's check, what's word " + (i + 1) + '?' },
              { question: 'What about word ' + (j + 1) + '?' },
            ]);
            this.showWords = false;
            this.goTo('check');
          }
        }
        break;

      // Asks for the two picked words in turn. Case doesn't matter.
      case 'check':
        if (key === 'esc') this.goBack();
        else if (this.check.key(e)) {
          const n = this.checkIdx[this.check.focus];
          const got = this.check.values()[this.check.focus];
          if (!got) this.err = `Type word ${n + 1} from your copy.`;
          else if (got.toLowerCase() !== this.key!.phrase().split(/\s+/)[n].toLowerCase()) {
            this.check.fields[this.check.focus].value = '';
            this.err = `That's not word ${n + 1}. Check your copy, or press [esc] to see the words again.`;
          } else if (!this.check.focus) this.check.focus = 1;
          else {
            this.keyReady = true;
            await this.advance();
          }
        }
        break;

      case 'unlock':
        if (key === 'esc') this.goBack();
        else if (key === 'tab') this.phrase.reveal = !this.phrase.reveal;
        else if (this.phrase.key(e)) {
          const words = this.phrase.values()[0].split(/\s+/).filter(Boolean);
          if (!words.length) this.err = 'Type your recovery phrase.';
          else if (words.length !== 24) this.err = `That's ${words.length} words. A recovery phrase has 24.`;
          else {
            this.busy = 'Checking the phrase';
            this.onChange?.();
            try {
              this.key = await this.deps.unlock(this.cfg.storage, words.join(' '), this.signal);
              this.newRepo = false;
              this.keyReady = true;
              this.busy = '';
              await this.advance();
            } catch (err) {
              this.err = message(err);
            } finally {
              this.busy = '';
              this.onChange?.();
            }
          }
        }
        break;

      // Editing a step takes it out of visited, so advance comes back to review once it's
      // answered again. [s] saves everything through finish.
      case 'review':
        if (['up', 'k'].includes(key)) this.revCur = Math.max(this.revCur - 1, 0);
        else if (['down', 'j'].includes(key)) this.revCur = Math.min(this.revCur + 1, 3);
        else if (key === 'v') this.showKey = !this.showKey;
        else if (key === 'esc') this.goBack();
        else if (['e', ' ', 'right', 'l'].includes(key)) {
          const step = this.reviewRows()[this.revCur].edit;
          if (step === 'storage') this.highlight(matchProvider(this.cfg.storage));
          else this.visited.delete(step);
          if (step === 'folders') this.folderSel = -1;
          if (step === 'skip') this.skipSel = -1;
          this.goTo(step);
        } else if (key === 's') {
          this.busy = 'Saving';
          this.onChange?.();
          try {
            this.savedRows = await this.deps.finish(this.cfg, this.key!, this.newRepo, this.signal);
            this.saved = true;
            this.back = [];
            this.step = 'done';
          } catch (err) {
            this.err = message(err);
          } finally {
            this.busy = '';
            this.onChange?.();
          }
        }
        break;

      case 'done':
        if (['enter', 'q', 'esc'].includes(key)) this.exited = true;
        break;
    }
  }

  // Keys for the folders and skip screens. While the input box has focus, enter adds what's typed,
  // or moves on when it's empty, and up selects the list. While a list item is selected, x removes it.
  async listInputKey(e: KeyEvent, skip: boolean): Promise<void> {
    const key = e.key;
    const form = skip ? this.skipIn : this.folderIn;
    const items = skip ? this.cfg.exclude : this.cfg.paths;
    let sel = skip ? this.skipSel : this.folderSel;
    if (key === 'esc' && sel < 0) {
      this.goBack();
      return;
    }

    if (sel >= 0) {
      if (['esc', 'enter'].includes(key)) sel = -1;
      else if (['up', 'k'].includes(key)) sel = Math.max(sel - 1, 0);
      else if (['down', 'j'].includes(key)) {
        sel++;
        if (sel >= items.length) sel = -1;
      } else if (['x', 'backspace', 'delete'].includes(key)) {
        items.splice(sel, 1);
        if (sel >= items.length) sel = items.length - 1;
      }
    } else if (key === 'up' && items.length) sel = items.length - 1;
    else if (form.key(e)) {
      const typed = form.values()[0];
      if (!typed || (skip && !splitList(typed).length)) {
        if (!skip && !items.length) this.err = 'Add at least one folder to continue.';
        else {
          this.visited.add(skip ? 'skip' : 'folders');
          await this.advance();
        }
      } else if (skip) {
        // Nothing is added unless every pattern typed is valid.
        const parts = splitList(typed);
        for (const p of parts) {
          try {
            new Excluder([p]);
          } catch {
            this.err = JSON.stringify(p) + " isn't a valid pattern. Check its brackets.";
            return;
          }
        }
        for (const p of parts) if (!items.includes(p)) items.push(p);
        form.fields = [{ placeholder: form.fields[0].placeholder }];
      } else {
        // A new folder replaces any listed folders inside it, since it already covers them.
        try {
          const result = await (this.deps.addPath?.(typed, items) ?? addPath(typed, items));
          const dropped = items.filter((_, i) => result.inside.includes(i));
          this.cfg.paths = [...items.filter((_, i) => !result.inside.includes(i)), result.clean];
          if (dropped.length)
            this.note = 'Took ' + dropped.join(', ') + ' off the list, ' + result.clean + ' includes it.';
          form.fields = [{ placeholder: form.fields[0].placeholder }];
        } catch (err) {
          this.err = message(err);
        }
      }
    }

    if (skip) this.skipSel = sel;
    else this.folderSel = sel;
  }

  // Opens provider i's form, filled in from the config when the config already uses that provider.
  // A saved Permafrost token is offered even when it doesn't.
  openDetails(i: number): void {
    this.prov = i;
    this.highlight(i);
    const p = providers[i];
    const fields = p.fields.map(f => ({ ...f }));
    if (matchProvider(this.cfg.storage) === i && this.cfg.storage.backend)
      p.read(this.cfg.storage).forEach((v, j) => (fields[j].value = v));
    if (!i && !fields[0].value) fields[0].value = this.cfg.storage.permafrost.token;
    this.details = new Form(fields);
  }

  schedValue(): string {
    return this.cfg.schedule.enabled ? this.cfg.schedule.every || 'daily' : 'off';
  }

  // Lists the schedule choices. A custom interval from the config goes in just before off.
  schedOptions(): string[] {
    const opts = ['hourly', '6h', '12h', 'daily', 'weekly', 'off'];
    const v = this.schedValue();
    if (!opts.includes(v)) opts.splice(opts.length - 1, 0, v);
    return opts;
  }

  // Lists the settings for the review screen, and for the welcome screen of an existing setup.
  reviewRows(): { label: string; value: string; edit: SetupStep }[] {
    return [
      { label: 'storage', value: describeStorage(this.cfg.storage), edit: 'storage' },
      { label: 'folders', value: this.cfg.paths.join(', '), edit: 'folders' },
      { label: 'skip', value: this.cfg.exclude.join(', ') || 'nothing', edit: 'skip' },
      {
        label: 'schedule',
        value: this.cfg.schedule.enabled ? schedLabel(this.schedValue()).toLowerCase() : 'off',
        edit: 'schedule',
      },
    ];
  }

  setupHints(): string[] {
    const h = hint;
    if (this.busy) return [h('ctrl+c', 'quit')];
    if (this.quit) return [];
    const quit = h('q', 'quit');
    let hints: string[] = [];
    switch (this.step) {
      case 'welcome':
        hints = [h('enter', this.existing ? 'review settings' : 'start'), quit];
        break;
      case 'storage':
      case 'schedule':
      case 'permaChoice':
      case 's3Choice':
      case 'keyChoice':
        hints = [h('enter', 'next'), h('↑↓', 'choose'), h('esc', 'back'), quit];
        break;
      case 'keyManual':
        hints = [h('enter', 'connect'), h('o', 'show file'), h('esc', 'back')];
        break;
      case 'details':
        hints = [h('enter', this.details.focus === this.details.fields.length - 1 ? 'connect' : 'next')];
        if (this.details.fields[this.details.focus].secret) hints.push(h('tab', this.details.reveal ? 'hide' : 'show'));
        hints.push(h('esc', 'back'));
        break;
      case 'folders':
      case 'skip': {
        const skip = this.step === 'skip';
        const sel = skip ? this.skipSel : this.folderSel;
        const items = skip ? this.cfg.exclude : this.cfg.paths;
        const f = skip ? this.skipIn : this.folderIn;
        hints =
          sel >= 0
            ? [h('x', 'remove'), h('↑↓', 'choose'), h('esc', 'done'), quit]
            : [
                h('enter', f.values()[0] || (!skip && !items.length) ? 'add' : 'continue'),
                ...(items.length ? [h('↑', 'remove one')] : []),
                h('esc', 'back'),
              ];
        break;
      }
      case 'phrase':
        hints = [
          h('v', this.showWords ? 'hide words' : 'show words'),
          h('enter', 'words saved'),
          h('esc', 'back'),
          quit,
        ];
        break;
      case 'check':
        hints = [h('enter', this.check.focus === 1 ? 'check' : 'next'), h('esc', 'see the words')];
        break;
      case 'unlock':
        hints = [h('enter', 'unlock'), h('tab', this.phrase.reveal ? 'hide phrase' : 'show phrase'), h('esc', 'back')];
        break;
      case 'review':
        hints = [
          h('s', 'save and finalise'),
          h('e', 'edit'),
          h('↑↓', 'choose'),
          h('v', this.showKey ? 'hide key' : 'show key'),
          quit,
        ];
        break;
      case 'done':
        hints = [h('enter', 'exit')];
    }

    // The pgup pgdn hint only shows when the feedback area has more to scroll.
    if (this.feedbackWindow()[1] > 0) hints.unshift(h('pgup pgdn', 'details'));
    return hints;
  }

  // Puts the title on the left, and the step name with a five-part progress bar on the right.
  setupHeader(w: number): string {
    const left = style('title', 'FROST') + style('dim', '  setup');
    const n = stepOf(this.step);
    const right = n
      ? style('dim', stepNames[n] + '  ') +
        Array.from({ length: 5 }, (_, i) => style(i < n ? 'text' : 'faded', '━━━')).join(fill(1))
      : '';
    const gap = w - width(left) - width(right);
    return gap < 1 ? pad(left, w) : left + fill(gap) + right;
  }

  // Draws the whole window. The wizard is centred and at most 80 columns wide. Welcome and done
  // leave out the header and get more height.
  view(): string {
    if (this.w <= 0 || this.h <= 0) return '';
    if (this.w < 56 || this.h < 18)
      return clip(place(this.w, this.h, style('text', 'make the window at least 56x18')), this.w, this.h);

    // The header, the spacer rows around the body, the rule and the hints take 5 rows. Without the
    // header, only the rule and the hints are left.
    const w = Math.min(80, this.w - 4);
    const bare = this.step === 'welcome' || this.step === 'done';
    const h = Math.min(bare ? 30 : 26, this.h - 2);
    const bodyH = h - (bare ? 2 : 5);
    let body: string;
    if (this.busy) {
      const spinner = style('bold', ['|', '/', '-', '\\'][this.spin % 4]);
      body = place(w, bodyH, spinner + style('text', ' ' + this.busy + '...'));
    } else if (this.quit) body = this.viewQuit(w, bodyH);
    else if (this.step === 'welcome') body = this.viewWelcome(w, bodyH);
    else if (this.step === 'done') body = this.viewDone(w, bodyH);
    else body = this.renderPage(this.page(w, bodyH), w, bodyH);
    body = place(w, bodyH, clip(body, w, bodyH), 'left', 'top');

    const rule = style('faded', '─'.repeat(w));
    const hints = pad(fitHints(this.setupHints(), w), w);
    return clip(
      place(
        this.w,
        this.h,
        bare ? stack(body, rule, hints) : stack(this.setupHeader(w), fill(w), body, fill(w), rule, hints),
      ),
      this.w,
      this.h,
    );
  }

  // Describes the page for the current step, given w by h cells. Text stays within 60 columns.
  page(w: number, h: number): Page {
    const cw = Math.min(w, 60);
    switch (this.step) {
      case 'storage':
        return {
          question: 'Where should backups go?',
          sub: 'Choose your storage below.',
          body: choices.map((c, i) => choice(i === this.provCur, c.name, c.note, 21, cw)),
        };

      case 's3Choice':
        return {
          over: choices[this.provCur].name,
          question: 'Which S3 service?',
          body: choices[this.provCur].providers.map((p, i) =>
            choice(i === this.s3Cur, providers[p].name, providers[p].note ?? '', 21, cw),
          ),
        };

      case 'keyChoice':
        return {
          over: providers[selfHosted].name,
          question: `Add frost's SSH key to ${this.pending.sftp.host}.`,
          sub: 'frost logs in with its own key, so scheduled backups never need a password.',
          body: [
            choice(this.keyCur === 0, 'Add it for me', 'needs your password once', 21, cw),
            choice(this.keyCur === 1, "I'll add it myself", 'shows where the key is', 21, cw),
          ],
        };

      case 'keyManual':
        return {
          over: providers[selfHosted].name,
          question: "Add frost's key to the server.",
          sub: `Add the line in this file to ~/.ssh/authorized_keys on ${this.pending.sftp.host}, then press [enter].`,
          body: [inputBox({ value: this.deps.keyFile?.() ?? '' }, false, false, cw)],
          help: projectLink + '/help/storage/self-hosted shows how.',
        };

      case 'details': {
        const p = providers[this.prov];
        const d = this.details;
        const f = d.fields[d.focus];
        return {
          over: p.name + (d.fields.length > 1 ? `  ${d.focus + 1} of ${d.fields.length}` : ''),
          question: f.question ?? '',
          body: [inputBox(f, d.reveal, true, cw)],
          help: f.help,
          // The default server's key field says where keys come from. A custom server has its own way.
          ...(this.prov === 0 && !this.cfg.storage.permafrost.url
            ? {
                extra: [
                  this.permaCur
                    ? style('text', 'Get one at ') +
                      style('bold', permafrostKeyPage.replace('https://', '')) +
                      style('text', ', then paste it here.')
                    : style('text', 'No key yet? Press ') + style('bold', '[esc]') + style('text', ' to get one.'),
                ],
              }
            : {}),
        };
      }

      case 'permaChoice':
        return {
          over: 'Permafrost',
          question: 'Do you have a Permafrost access key?',
          sub: "It's the only thing frost needs to connect.",
          body: [
            choice(this.permaCur === 0, 'I have a key', '', 26, cw),
            choice(this.permaCur === 1, "I don't have a key yet", 'get one in your browser', 26, cw),
          ],
        };

      // Show as many list rows as fit, from 6 down to 1.
      case 'folders':
      case 'skip': {
        for (let n = 6; n > 1; n--) {
          const pg = this.listPage(cw, n, this.step === 'skip');
          let used = setupHeight(para('bold', pg.question, cw)) + setupHeight(stack(...pg.body));
          for (const s of [pg.over, pg.sub, sentence(this.err), sentence(this.note)])
            if (s) used += height(para('text', s, cw));
          if (used <= h) return pg;
        }
        return this.listPage(cw, 1, this.step === 'skip');
      }

      case 'schedule':
        return {
          question: 'How often should frost back up?',
          sub: 'Backups run automatically in the background, only uploading new or modified files.',
          body: this.schedOptions().map((o, i) => choice(i === this.schedCur, schedLabel(o), '', 40, cw)),
          foot: 'You can change this any time by running frost init again.',
        };

      case 'phrase':
        return {
          question: 'Write down your recovery phrase.',
          sub: "It's the only way to get your files back if this machine is ever lost.",
          body: [this.phraseCard(cw)],
          help: 'Consider writing it down on paper and placing it somewhere secure. Make sure nobody but you has access.',
        };

      case 'check':
        return {
          over: `Confirm you've saved your phrase (${this.check.focus + 1} of 2)`,
          question: this.check.fields[this.check.focus].question ?? '',
          body: [inputBox(this.check.fields[this.check.focus], false, true, cw)],
          help: 'Type it from what you wrote down.',
        };

      case 'unlock':
        return {
          question:
            this.state === RepoState.LocalWrong
              ? 'These backups use a different key.'
              : 'This storage already has backups.',
          sub:
            this.state === RepoState.LocalWrong
              ? "The key on this machine doesn't open them. Type their recovery phrase, and frost will use that key here instead."
              : 'Type the recovery phrase you saved when you first set them up.',
          body: [inputBox(this.phrase.fields[0], this.phrase.reveal, true, cw)],
          help: 'All 24 words, separated by spaces.',
        };

      case 'review': {
        const rows = this.reviewRows().map((r, i) =>
          i === this.revCur
            ? style('selected', padPlain(' ' + padPlain(r.label, 10) + truncate(r.value, cw - 12), cw))
            : pad(style('dim', ' ' + padPlain(r.label, 10)) + style('text', truncate(r.value, cw - 12)), cw),
        );

        // The key's fingerprint stays covered until [v].
        if (this.key) {
          const fp = this.key.fingerprint();
          const from =
            this.key === this.deps.localKey
              ? 'already on this machine'
              : !this.newRepo
                ? 'from your recovery phrase'
                : 'new';
          rows.push(
            pad(
              style('dim', ' ' + padPlain('key', 10)) +
                style(this.showKey ? 'text' : 'redacted', this.showKey ? fp : ' '.repeat(fp.length)) +
                style('dim', '  ' + from),
              cw,
            ),
          );
        }
        const pg: Page = {
          question: 'Review and finalise.',
          sub: "Adjust your preferences below. When you're ready, press [s] to finish.",
          body: rows,
        };

        // Starting new backups when this machine already has some elsewhere gets a warning. It goes
        // under the rows when it fits, and in the scrollable feedback area when it doesn't.
        if (this.newRepo && this.elsewhere) {
          const warning = para(
            'caution',
            'This starts a separate set of backups. Your current ones in ' +
              this.elsewhere +
              ' stay there, but frost will only show the new ones, and the first backup uploads everything again.',
            cw,
          );
          let used =
            height(para('bold', pg.question, cw)) + height(para('dim', pg.sub!, cw)) + height(stack(...pg.body));
          for (const s of [this.err, this.note]) if (s) used += height(para('text', sentence(s), cw));
          if (used < h) used++;
          if (used + 1 + height(warning) <= h) pg.extra = [warning];
          else pg.feedback = warning;
        }
        return pg;
      }

      default:
        return { question: '', body: [] };
    }
  }

  // Builds the folders or skip page with up to n list rows. Folders missing from this machine are marked.
  listPage(cw: number, n: number, skip: boolean): Page {
    const items = skip ? this.cfg.exclude : this.cfg.paths;
    const sel = skip ? this.skipSel : this.folderSel;
    let missing = false;
    const rows = listRows(items, sel, n, cw, (i, on) => {
      const note = !skip && this.deps.dirExists && !this.deps.dirExists(items[i]) ? '  not found' : '';
      if (note) missing = true;
      return on
        ? style('selected', padPlain(truncate(' ' + items[i], cw - width(note)) + note, cw))
        : pad(style('text', ' ' + truncate(items[i], cw - (skip ? 2 : 14))) + style('caution', note), cw);
    });
    if (rows.length) rows.push(blank(cw));
    rows.push(inputBox((skip ? this.skipIn : this.folderIn).fields[0], false, sel < 0, cw));

    if (skip) {
      return {
        question: 'Which files should frost skip?',
        sub: 'Names or patterns. * matches anything, like *.tmp.',
        body: rows,
        help: items.length
          ? 'Type a name or pattern and press enter to add it. Press enter on an empty box to move on.'
          : 'Nothing is skipped yet. Type a name or pattern and press enter to add it.',
      };
    }
    return {
      question: 'Which folders should frost back up?',
      sub: 'Whole folders, with everything inside them.',
      body: rows,
      help: items.length
        ? 'Type a path and press enter to add it. Press enter on an empty box to move on.'
        : 'Type a path and press enter to add it. Add as many as you like.',
      foot: missing ? "A folder that isn't there is skipped until it is, like a drive that isn't plugged in." : '',
    };
  }

  // Joins the page's feedback with the current error and note, and works out how many rows are
  // left for them under the question and body.
  pageFeedback(p: Page, cw: number, h: number): [string, number] {
    const blocks: string[] = [];
    if (p.feedbackFirst && p.feedback) blocks.push(p.feedback);
    if (this.err) blocks.push(para('error', sentence(this.err), cw));
    if (this.note) blocks.push(para('text', sentence(this.note), cw));
    if (!p.feedbackFirst && p.feedback) blocks.push(p.feedback);
    if (!blocks.length) return ['', 0];
    const used =
      setupHeight(para('bold', p.question, cw)) +
      setupHeight(stack(...p.body)) +
      (p.over ? height(style('dim', p.over)) : 0);
    return [stack(...blocks), Math.max(h - used, 0)];
  }

  // Returns the feedback area's visible rows and its furthest scroll position. It uses the same
  // sizes as view, so scrolling matches what's drawn.
  feedbackWindow(): [number, number] {
    if (this.w < 56 || this.h < 18 || this.busy || this.quit || ['welcome', 'done'].includes(this.step)) return [0, 0];
    const w = Math.min(80, this.w - 4);
    const h = Math.min(26, this.h - 2) - 5;
    const [text, rows] = this.pageFeedback(this.page(w, h), Math.min(w, 60), h);
    return rows <= 0 ? [0, 0] : [rows, Math.max(setupHeight(text) - rows, 0)];
  }

  // Lays out a page in h rows. The question, body and feedback always get their space. The sub line
  // is cut to fit what's left, and help, foot and extra only show when each one fits whole.
  renderPage(p: Page, w: number, h: number): string {
    const cw = Math.min(w, 60);
    const lines: string[] = [];
    if (p.over) lines.push(style('dim', p.over));
    lines.push(para(p.good ? 'goodBold' : 'bold', p.question, cw));
    const answer = stack(...p.body);
    let used = height(stack(...lines)) + setupHeight(answer);

    // Only the scrolled part of the feedback is drawn.
    let [feedback, rows] = this.pageFeedback(p, cw, h);
    if (!rows || !feedback) feedback = '';
    else {
      const parts = feedback.split('\n');
      const top = Math.min(Math.max(this.feedbackTop, 0), Math.max(parts.length - rows, 0));
      feedback = parts.slice(top, top + rows).join('\n');
    }
    used += setupHeight(feedback);

    if (p.sub) {
      const sub = limitSetupLines(para('dim', p.sub, cw), cw, Math.max(h - used, 0));
      if (sub) {
        lines.push(sub);
        used += height(sub);
      }
    }
    if (used < h) {
      lines.push(blank(cw));
      used++;
    }
    if (p.feedbackFirst && feedback) lines.push(feedback);
    if (answer) lines.push(answer);
    if (!p.feedbackFirst && feedback) lines.push(feedback);

    for (const extra of [p.help, p.foot])
      if (extra) {
        const block = para('dim', extra, cw);
        if (used + 1 + height(block) <= h) {
          lines.push(blank(cw), block);
          used += 1 + height(block);
        }
      }
    if (p.extra?.length) {
      const extra = stack(...p.extra);
      if (used + 1 + height(extra) <= h) {
        lines.push(blank(cw), extra);
        used += 1 + height(extra);
      }
    }

    // Taller windows get up to two spare rows above the page.
    if (h >= 16 && used < h) lines.unshift(fill(cw, Math.min(2, h - used)));
    return centerRow(w, stack(...lines.map(l => pad(l, cw))));
  }

  // Draws the phrase in a box, numbered down each column, with 3 columns on narrow pages and 4
  // otherwise. Each column is a 2-digit number, a space and 8 cells for the word. Words stay
  // covered until [v].
  phraseCard(w: number): string {
    const words = this.key!.phrase().split(/\s+/);
    const cols = w - 4 < 47 ? 3 : 4;
    const gap = Math.max(Math.trunc((w - 4 - cols * 11) / Math.max(cols - 1, 1)), 0);
    const rows = Math.ceil(words.length / cols);
    const out: string[] = [];
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) {
        const i = c * rows + r;
        if (i >= words.length) break;
        line +=
          style('dim', String(i + 1).padStart(2) + ' ') +
          style(this.showWords ? 'text' : 'redacted', this.showWords ? padPlain(words[i], 8) : ' '.repeat(8));
        if (c < cols - 1) line += fill(gap);
      }
      out.push(pad(line, w - 4));
    }
    return box(stack(...out), true, { w: w - 2 });
  }

  // Shows the wordmark and a short intro, or the current settings for an existing setup.
  viewWelcome(w: number, h: number): string {
    const tw = Math.min(w, 60);
    const row = (s: string) => centerRow(w, s);
    const center = (st: 'text' | 'dim', s: string) => row(para(st, s, tw, true));
    const text: string[] = [];
    if (this.existing) {
      text.push(
        center('text', 'frost is already set up on this machine. Review your settings, change any of them, and save.'),
        blank(w),
      );
      for (const r of this.reviewRows())
        text.push(row(pad(style('dim', padPlain(r.label, 10)) + style('text', truncate(r.value, tw - 10)), tw)));
    } else {
      text.push(
        center('text', 'frost backs up your files.'),
        fill(w, 2),
        row(style('text', 'learn more at ') + style('link', projectLink)),
        blank(w),
        center('dim', 'Setup takes about two minutes.'),
      );
    }

    // The gap under the wordmark shrinks when the full layout is too tall, and the wordmark gets
    // whatever height is left.
    const rest = stack(...text);
    const markH = height(rawWordmark());
    const gap = 2 + markH + 3 + height(rest) > h ? 1 : 3;
    const mark = logo(w, h - height(rest) - gap - 2);
    return place(w, h, stack(row(style('dim', 'Welcome to')), blank(w), row(mark), fill(w, gap), rest));
  }

  viewQuit(w: number, h: number): string {
    const row = (s: string) => centerRow(w, s);
    return place(
      w,
      h,
      stack(
        row(style('bold', 'Are you sure you want to quit?')),
        blank(w),
        row(style('dim', 'Unsaved changes will be lost.')),
        fill(w, 2),
        row(style('bold', '[y]') + style('text', ' yes') + fill(5) + style('bold', '[n]') + style('text', ' no')),
      ),
    );
  }

  // Draws the finished screen. When finish reports the scheduled job as not installed, its reason
  // replaces the schedule line, and the retry hint stays visible even when the reason is cut.
  viewDone(w: number, h: number): string {
    const row = (s: string) => centerRow(w, s);
    const tw = Math.min(w, 60);
    let when = this.cfg.schedule.enabled
      ? 'Your folders will be backed up ' + schedLabel(this.schedValue()).toLowerCase() + '.'
      : 'Automatic backups are off, so run a backup whenever you like.';
    let retry = '';
    let st: 'text' | 'caution' = 'text';
    for (const r of this.savedRows)
      if (r[0] === 'schedule' && r[1].startsWith('not installed')) {
        retry = 'Run frost init again to retry.';
        when = "Automatic backups couldn't be set up (" + r[1].replace(/^not installed: /, '') + '). ' + retry;
        st = 'caution';
      }

    // The message gets whatever the other 9 rows leave.
    const mh = Math.max(h - 9, 1);
    let message = para(st, when, tw, true);
    if (retry && height(message) > mh) {
      const action = para(st, retry, tw, true);
      message = stack(
        limitSetupLines(para(st, when.slice(0, -(retry.length + 1)), tw, true), tw, Math.max(mh - height(action), 0)),
        action,
      );
    } else message = limitSetupLines(message, tw, mh);

    const list = [
      ['frost backup', 'back up now'],
      ['frost browse', 'look through your backups'],
      ['frost status', "check everything's healthy"],
    ].map(c => style('bold', padPlain(c[0], 16)) + style('dim', c[1]));
    return place(
      w,
      h,
      stack(
        row(style('goodBold', 'All set up!')),
        blank(w),
        row(message),
        fill(w, 2),
        row(style('dim', 'Exit, then run one of these to get started:')),
        blank(w),
        row(stack(...list)),
      ),
    );
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Used when SetupDeps leaves out addPath.
async function addPath(typed: string, paths: string[]): Promise<{ clean: string; inside: number[] }> {
  const result = await coreAddPath(typed, paths);
  return { clean: result.path, inside: result.inside };
}

// Runs the wizard in the terminal. saved is false when the user quit before saving.
export async function setup(
  deps: SetupDeps,
  cfg: Config,
  existing = false,
  options: TerminalOptions = {},
): Promise<SetupResult> {
  const m = new SetupModel(deps, cfg, existing, options.signal);
  try {
    await runTerminal(m, options);
  } finally {
    m.close();
  }
  return { saved: m.saved, rows: m.savedRows };
}
