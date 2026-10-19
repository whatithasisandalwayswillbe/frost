// The `frost browse` snapshot browser. BrowserModel holds the state, turns keys into state changes and draws
// each frame as a string, and runTerminal in terminal.ts drives it. The restore dialog lives in restore.ts.

import path from 'node:path';
import os from 'node:os';
import { cacheDir } from '../core/config.js';
import { isDefaultPermafrost, permafrostAccountPage } from '../core/storage.js';
import { shorten, shortOf, diff } from '../core/snapshot.js';
import { besideFolder, newRestoreFolder, canOverwrite, RestoreError } from '../engine/restore.js';
import * as desktop from '../platform/desktop.js';
import type { BrowserRepo, Snapshot, Config, State, Change } from './types.js';
import { FileTree, covered } from './tree.js';
import { Form, type KeyEvent } from './input.js';
import { Arcade, openGameSound, type GameSound } from './arcade.js';
import { RestoreState, restoreContent, restoreHints, pickerStartFolder, carryOn, asError } from './restore.js';
import { runTerminal, type TerminalOptions } from './terminal.js';
import {
  style,
  printable,
  width,
  height,
  strip,
  fill,
  pad,
  padPlain,
  box,
  stack,
  side,
  clip,
  place,
  centerRow,
  logo,
  humanBytes,
  ago,
  shortPath,
  truncate,
  truncateLeft,
  para,
  hint,
  fitHints,
  windowTop,
  wrapStyled,
  type Style,
} from './render.js';

type Screen = 'home' | 'snapshots' | 'files' | 'diff' | 'restore';

// Formats a time in the local time zone, padding the year to four digits.
export function dateLabel(t: string, format: 'date' | 'time' | 'minute' | 'second' | 'heading' = 'minute'): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  const y = d.getFullYear();
  const year = (y < 0 ? '-' : '') + String(Math.abs(y)).padStart(4, '0');
  const date = `${year}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (format === 'date') return date;
  if (format === 'time') return time;
  if (format === 'heading')
    return (
      ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] +
      ' ' +
      p(d.getDate()) +
      ' ' +
      ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] +
      ' ' +
      year
    );
  return date + ' ' + time + (format === 'second' ? ':' + p(d.getSeconds()) : '');
}

// Splits the file list's inner width into name, size and modified columns. Narrow windows drop the size and
// modified columns, and modified shows only the date before it goes.
function fileColumns(inner: number): [number, number, number] {
  const size = inner >= 28 ? 8 : 0;
  const modified = inner >= 70 ? 16 : inner >= 54 ? 10 : 0;
  return [Math.max(inner - 4, 0) - (size ? size + 2 : 0) - (modified ? modified + 2 : 0), size, modified];
}

// Builds one row of the snapshot list with the time, short ID, file count and size. When fewer than 8 cells are
// left for the ID, the counts drop out.
function snapshotListLabel(s: Snapshot, id: string, mark: string, countW: number, sizeW: number, w: number): string {
  const prefix = mark + dateLabel(s.time, 'time') + '  ';
  const suffix =
    '  ' + String(s.stats.files).padStart(countW) + ' files  ' + humanBytes(s.stats.bytes).padStart(sizeW) + '  ';
  const idWidth = w - width(prefix) - width(suffix);
  return idWidth < 8
    ? truncate(prefix + id, Math.max(w - 2, 0)) + ' '.repeat(Math.min(w, 2))
    : prefix + padPlain(truncate(id, idWidth), idWidth) + suffix;
}

// Shows p relative to the folder holding its backed-up root, so the root's own name stays visible.
function relToRoot(p: string, ...roots: string[][]): string {
  for (const rs of roots)
    for (const r of rs) if (p === r || p.startsWith(r + '/')) return p.replace(path.posix.dirname(r) + '/', '');
  return p;
}

// Builds the hint at the bottom of the settings dialog, with the version on the right when there's room.
// It falls back to two rows, then to wrapping, as the dialog narrows.
function settingsFooter(version: string, w: number): string[] {
  const first = style('dim', 'Change these with ') + style('bold', 'frost config set') + style('dim', ' or');
  const second = style('bold', 'frost config edit');
  const colophon = version ? style('dim', 'frost ' + version) : '';
  const one = first + style('text', ' ') + second;
  if (width(second) + 2 + width(colophon) > w)
    return [...wrapStyled(one, w), ...(colophon ? para('dim', 'frost ' + version, w).split('\n') : [])];

  const right = (left: string) => {
    const gap = w - width(left) - width(colophon);
    return !colophon || gap < 2 ? left : left + fill(gap) + colophon;
  };
  if (width(one) + 2 + width(colophon) <= w || (!colophon && width(one) <= w)) return [right(one)];
  if (width(first) + 2 + width(colophon) <= w) return [right(first), second];
  return [...wrapStyled(first, w), right(second)];
}

// Desktop and filesystem hooks, which tests replace so nothing opens a real window or folder.
export interface BrowserDeps {
  canOpen(): boolean;
  canPick(): boolean | Promise<boolean>;
  pickFolder(title: string, start: string, signal?: AbortSignal): Promise<string>;
  openFolder(p: string, file: boolean): Promise<void>;
  openBrowser?(url: string): Promise<void>;
  besideFolder: typeof besideFolder;
  newRestoreFolder: typeof newRestoreFolder;
  canOverwrite: typeof canOverwrite;
  gameSound?: () => GameSound;
}

const defaults: BrowserDeps = {
  canOpen: desktop.available,
  canPick: desktop.canPick,
  pickFolder: (title, start, signal) => desktop.pickFolder(title, start, { signal }),
  openFolder: (p, file) => (file ? desktop.reveal(p) : desktop.openFolder(p)),
  openBrowser: desktop.openBrowser,
  besideFolder,
  newRestoreFolder,
  canOverwrite,
  gameSound: openGameSound,
};

// Thrown by runBrowser when the browser closes while a restore is running.
export class RestoreStopped extends Error {
  constructor() {
    super('Restore stopped. ' + carryOn);
  }
}

export class BrowserModel {
  // close() aborts this, cancelling any storage call still in flight.
  private readonly controller = new AbortController();
  stoppedRestore = false;

  // These track the window size, the current screen and anything drawn over it. The flash is a footer
  // notice that the next key clears, and loading is the spinner text while waiting on storage.
  w = 0;
  h = 0;
  screen: Screen = 'home';
  overlay = '';
  overlayTop = 0;
  showKey = false;
  spin = 0;
  loading = 'Loading snapshots';
  err?: Error;
  errorTop = 0;
  flash = '';
  exited = false;

  // snapLayout holds the snapshot list's rows, each a date heading or an index into snaps, and
  // snapPositions maps each snapshot to its row. marked is the snapshot [m] marked for comparing.
  snaps: Snapshot[] = [];
  snapLayout: { header?: string; idx?: number }[] = [];
  snapPositions: number[] = [];
  snapCountW = 0;
  snapSizeW = 0;
  snapCur = 0;
  marked = '';
  short = new Map<string, string>();

  // The open snapshot's files and selection live here. trail remembers the cursor in each folder visited.
  snap?: Snapshot;
  tree?: FileTree;
  dir = '';
  fileCur = 0;
  fileTop = 0;
  sel = new Set<string>();
  trail = new Map<string, number>();
  selFiles = 0;
  selBytes = 0;

  // These hold the comparison between two snapshots, with counts for its header.
  diffFrom?: Snapshot;
  diffTo?: Snapshot;
  changes: Change[] = [];
  diffTop = 0;
  diffAdd = 0;
  diffDel = 0;
  diffMod = 0;

  rs = new RestoreState();
  private restorePreparation?: { controller: AbortController; cancel: (key: string) => void };

  private prepareRestore(cancel: (key: string) => void) {
    if (this.restorePreparation) return;
    return (this.restorePreparation = { controller: new AbortController(), cancel });
  }

  private prepared(work: NonNullable<BrowserModel['restorePreparation']>): boolean {
    return this.restorePreparation === work && !this.exited && !this.signal?.aborted;
  }

  private finishPreparing(work: NonNullable<BrowserModel['restorePreparation']>): void {
    if (this.restorePreparation === work) this.restorePreparation = undefined;
  }

  // bestPath is the file that keeps the hidden game's best score. The terminal sets onChange to redraw
  // after async work.
  game?: Arcade;
  bestPath: string;
  onChange?: () => void;
  deps: BrowserDeps;

  constructor(
    public repo: BrowserRepo,
    public cfg: Config,
    public st: State = {},
    public signal?: AbortSignal,
    deps: Partial<BrowserDeps> = {},
    bestPath?: string,
  ) {
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    this.deps = { ...defaults, ...deps };
    this.bestPath = bestPath ?? path.join(cacheDir(), 'icebreaker.json');
  }

  // Keeps every scroll offset in range for the new size.
  resize(w: number, h: number): void {
    this.w = Math.max(w, 0);
    this.h = Math.max(h, 0);
    this.diffTop = Math.min(this.diffTop, this.diffMaxTop());
    this.overlayTop = Math.min(this.overlayTop, this.overlayMaxTop());
    if (this.err) this.errorTop = Math.min(this.errorTop, this.errorMaxTop());
    if (this.screen === 'restore') this.rs.top = Math.min(this.rs.top, this.restoreMaxTop());
    this.game?.resize(this.innerW() - 2, this.areaH() - 3);
  }

  // These size the content area inside the window's margins, header and footer. The minimums keep tiny
  // windows drawable, and clipping in view() cuts the frame back to the real size.
  innerW(): number {
    return Math.max(this.w - 4, 20);
  }

  areaH(): number {
    return Math.max(this.h - 7, 5);
  }

  // Counts the rows inside a full-height box.
  bodyH(): number {
    return this.areaH() - 2;
  }

  dialogPadX(): number {
    return this.innerW() >= 96 ? 3 : this.innerW() >= 60 ? 2 : 1;
  }

  dialogW(most: number): number {
    return Math.max(Math.min(this.innerW() - 2 - 2 * this.dialogPadX(), most), 16);
  }

  // Returns how many content rows a dialog shows, and whether it scrolls. A scrolling dialog keeps its last row
  // for the position line.
  dialogRows(n: number): [number, boolean] {
    const room = this.areaH() - 2;
    return n > room ? [Math.max(room - 1, 1), true] : [n, false];
  }

  dialogMaxTop(n: number): number {
    return Math.max(n - this.dialogRows(n)[0], 0);
  }

  // Draws content in a centred box. Content too tall for the area scrolls, starting at row top.
  dialog(content: string, w: number, top: number, error = false): string {
    let lines = content.split('\n');
    const [rows, scrolls] = this.dialogRows(lines.length);
    const py = !scrolls && lines.length + 4 <= this.areaH() ? 1 : 0;
    if (scrolls) {
      top = Math.max(Math.min(top, lines.length - rows), 0);
      const n = lines.length;
      lines = [...lines.slice(top, top + rows), style('dim', `${top + 1}-${top + rows} of ${n}`)];
    }
    return this.center(box(lines.map(l => pad(l, w)).join('\n'), true, { padX: this.dialogPadX(), padY: py, error }));
  }

  center(s: string): string {
    return place(this.innerW(), this.areaH(), s);
  }

  // Lays out the snapshot list with a heading before each new day, and works out its column widths and
  // the shortest unique IDs.
  indexSnapshots(): void {
    this.snapLayout = [];
    this.snapPositions = [];
    this.snapCountW = this.snapSizeW = 0;
    let last = '';
    this.snaps.forEach((s, i) => {
      const date = dateLabel(s.time, 'heading');
      if (date !== last) {
        this.snapLayout.push({ header: date });
        last = date;
      }
      this.snapPositions[i] = this.snapLayout.length;
      this.snapLayout.push({ idx: i });
      this.snapCountW = Math.max(this.snapCountW, String(s.stats.files).length);
      this.snapSizeW = Math.max(this.snapSizeW, humanBytes(s.stats.bytes).length);
    });
    this.short = shorten(this.snaps);
  }

  async init(): Promise<void> {
    await this.loadSnaps();
  }

  // Loads snapshots newest first, breaking ties by ID. Saving them back to st.known lets a refresh skip
  // the ones already loaded. The list is rebuilt even after a failure, so the cursor and mark stay valid.
  async loadSnaps(): Promise<void> {
    try {
      this.snaps = (await this.repo.snapshots(this.st.known, this.signal))
        .filter(s => s.id)
        .sort(
          (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      this.err = undefined;
    } catch (e) {
      this.err = asError(e);
    } finally {
      this.loading = '';
      this.errorTop = 0;
      this.indexSnapshots();
      this.st.known = new Map(this.snaps.map(s => [s.id, s]));
      if (!this.snaps.some(s => s.id === this.marked)) this.marked = '';
      this.snapCur = Math.max(Math.min(this.snapCur, this.snaps.length - 1), 0);
      this.onChange?.();
    }
  }

  // Opens a snapshot's files. A snapshot of a single folder opens inside it.
  async loadTree(s: Snapshot): Promise<void> {
    try {
      this.snap = s;
      this.tree = new FileTree(s, await this.repo.loadTree(s.id, this.signal));
      this.dir = this.tree.roots.length === 1 && this.tree.isDir(this.tree.roots[0]) ? this.tree.roots[0] : '';
      this.fileCur = this.fileTop = this.selFiles = this.selBytes = 0;
      this.sel = new Set();
      this.trail = new Map();
      this.screen = 'files';
    } catch (e) {
      this.err = asError(e);
      this.errorTop = 0;
    } finally {
      this.loading = '';
      this.onChange?.();
    }
  }

  // Compares two snapshots, always from the older to the newer.
  async loadDiff(from: Snapshot, to: Snapshot): Promise<void> {
    if (new Date(from.time) > new Date(to.time)) [from, to] = [to, from];
    try {
      const [a, b] = await Promise.all([
        this.repo.loadTree(from.id, this.signal),
        this.repo.loadTree(to.id, this.signal),
      ]);
      this.diffFrom = from;
      this.diffTo = to;
      this.changes = diff(a, b);
      this.diffTop = this.diffAdd = this.diffDel = this.diffMod = 0;
      for (const c of this.changes)
        if (c.kind === 'added') this.diffAdd++;
        else if (c.kind === 'removed') this.diffDel++;
        else this.diffMod++;
      this.screen = 'diff';
    } catch (e) {
      this.err = asError(e);
      this.errorTop = 0;
    } finally {
      this.loading = '';
      this.onChange?.();
    }
  }

  // Keys go to the first layer that wants them, in this order: ctrl+c, the folder input, an error, the game,
  // [v], an overlay, a load in progress, the restore dialog and the current screen.
  async onKey(event: string | KeyEvent): Promise<void> {
    const e = typeof event === 'string' ? { key: event } : event;
    const k = e.key;
    this.flash = '';
    if (k === 'ctrl+c') {
      this.exited = true;
      return;
    }
    if (this.restorePreparation) {
      if (['esc', 'q'].includes(k)) {
        const work = this.restorePreparation;
        this.restorePreparation = undefined;
        work.controller.abort();
        work.cancel(k);
      }
      return;
    }
    if (this.screen === 'restore' && this.rs.phase === 'typing' && !this.overlay && !this.err) {
      await this.restoreTypingKey(e);
      return;
    }

    // An error that scrolls takes the scroll keys. Any other key dismisses it.
    if (this.err) {
      if (k === 'q') {
        this.exited = true;
        return;
      }
      if (this.errorMaxTop() > 0) {
        const rows = this.dialogRows(height(this.errorContent()))[0];
        if (['up', 'k'].includes(k)) this.errorTop = Math.max(this.errorTop - 1, 0);
        else if (['down', 'j'].includes(k)) this.errorTop = Math.min(this.errorTop + 1, this.errorMaxTop());
        else if (k === 'pgup') this.errorTop = Math.max(this.errorTop - rows, 0);
        else if (['pgdown', ' '].includes(k)) this.errorTop = Math.min(this.errorTop + rows, this.errorMaxTop());
        else if (['g', 'home'].includes(k)) this.errorTop = 0;
        else if (['G', 'end'].includes(k)) this.errorTop = this.errorMaxTop();
        else {
          this.err = undefined;
          this.errorTop = 0;
        }
      } else {
        this.err = undefined;
        this.errorTop = 0;
      }
      return;
    }

    if (this.game) {
      if (this.game.key(k)) {
        void this.game.snd?.close();
        this.game = undefined;
      }
      return;
    }
    if (k === 'v') {
      this.showKey = !this.showKey;
      return;
    }

    if (this.overlay) {
      if (this.overlay === 'help' && k === 'p' && this.hasPermafrostAccount()) {
        try {
          if (!this.deps.canOpen() || !this.deps.openBrowser) throw new Error('no browser is available');
          await this.deps.openBrowser(permafrostAccountPage);
        } catch {
          this.err = new Error('Open ' + permafrostAccountPage + ' in your browser to manage your Permafrost account.');
        }
      } else if (['esc', 'h', 's', 'q', '?'].includes(k)) {
        this.overlay = '';
        this.overlayTop = 0;
      } else if (['up', 'k'].includes(k)) this.overlayTop = Math.max(this.overlayTop - 1, 0);
      else if (['down', 'j'].includes(k)) this.overlayTop = Math.min(this.overlayTop + 1, this.overlayMaxTop());
      else if (k === 'pgup') this.overlayTop = Math.max(this.overlayTop - this.overlayH(), 0);
      else if (['pgdown', ' '].includes(k))
        this.overlayTop = Math.min(this.overlayTop + this.overlayH(), this.overlayMaxTop());
      else if (['g', 'home'].includes(k)) this.overlayTop = 0;
      else if (['G', 'end'].includes(k)) this.overlayTop = this.overlayMaxTop();
      return;
    }

    if (this.loading) {
      if (k === 'q') this.exited = true;
      return;
    }
    if (this.screen === 'restore') {
      await this.restoreKey(k);
      return;
    }

    // Global keys come first, then each screen's own. [i] opens the hidden game.
    if (k === 'q') this.exited = true;
    else if (['h', '?'].includes(k)) {
      this.overlay = 'help';
      this.overlayTop = 0;
    } else if (k === 's') {
      this.overlay = 'settings';
      this.overlayTop = 0;
    } else if (k === 'i') {
      this.game = new Arcade(this.bestPath);
      this.game.snd = this.deps.gameSound?.();
      this.game.resize(this.innerW() - 2, this.areaH() - 3);
    } else if (this.screen === 'home') {
      if (['enter', 'b'].includes(k)) this.screen = 'snapshots';
      else if (k === 'r') {
        this.loading = 'Refreshing';
        this.onChange?.();
        await this.loadSnaps();
      }
    } else if (this.screen === 'snapshots') await this.snapshotsKey(k);
    else if (this.screen === 'files') await this.filesKey(k);
    else if (this.screen === 'diff') {
      if (['esc', 'backspace', 'left'].includes(k)) this.screen = 'snapshots';
      else if (['up', 'k'].includes(k)) this.diffTop = Math.max(this.diffTop - 1, 0);
      else if (['down', 'j'].includes(k)) this.diffTop = Math.min(this.diffTop + 1, this.diffMaxTop());
      else if (k === 'pgup') this.diffTop = Math.max(this.diffTop - this.diffListH(), 0);
      else if (['pgdown', ' '].includes(k)) this.diffTop = Math.min(this.diffTop + this.diffListH(), this.diffMaxTop());
    }
  }

  async snapshotsKey(k: string): Promise<void> {
    const n = this.snaps.length;
    if (['esc', 'backspace', 'left'].includes(k)) this.screen = 'home';
    else if (['up', 'k'].includes(k)) this.snapCur = Math.max(this.snapCur - 1, 0);
    else if (['down', 'j'].includes(k)) this.snapCur = Math.min(this.snapCur + 1, n - 1);
    else if (k === 'pgup') this.snapCur = Math.max(this.snapCur - this.bodyH(), 0);
    else if (k === 'pgdown') this.snapCur = Math.min(this.snapCur + this.bodyH(), n - 1);
    else if (['home', 'g'].includes(k)) this.snapCur = 0;
    else if (['end', 'G'].includes(k)) this.snapCur = n - 1;
    else if (['enter', 'right', 'l'].includes(k) && n) {
      this.loading = 'Loading files for ' + this.shortID(this.snaps[this.snapCur].id);
      this.onChange?.();
      await this.loadTree(this.snaps[this.snapCur]);
    } else if (k === 'm' && n) {
      const id = this.snaps[this.snapCur].id;
      if (this.marked === id) this.marked = '';
      else {
        this.marked = id;
        this.flash = 'Marked ' + this.shortID(id) + '. Move to another snapshot and press [d] to compare.';
      }
    } else if (k === 'd' && n) {
      // Compare with the marked snapshot, or else with the one taken just before this one.
      const cur = this.snaps[this.snapCur];
      let from: Snapshot | undefined;
      if (this.marked && this.marked !== cur.id) from = this.snaps.find(s => s.id === this.marked);
      else if (this.snapCur + 1 < n) from = this.snaps[this.snapCur + 1];
      else {
        this.flash = 'This is the oldest snapshot, nothing to compare it with.';
        return;
      }
      if (from) {
        this.loading = 'Comparing snapshots';
        this.onChange?.();
        await this.loadDiff(from, cur);
      }
    }

    // Moving down or to the end of an empty list leaves the cursor at -1.
    this.snapCur = Math.max(this.snapCur, 0);
  }

  async filesKey(k: string): Promise<void> {
    const t = this.tree!;
    const kids = t.children.get(this.dir) ?? [];
    const n = kids.length;
    if (k === 'esc') this.screen = 'snapshots';
    else if (['up', 'k'].includes(k)) this.fileCur = Math.max(this.fileCur - 1, 0);
    else if (['down', 'j'].includes(k)) this.fileCur = Math.min(this.fileCur + 1, n - 1);
    else if (k === 'pgup') this.fileCur = Math.max(this.fileCur - this.fileListH(), 0);
    else if (k === 'pgdown') this.fileCur = Math.min(this.fileCur + this.fileListH(), n - 1);
    else if (['home', 'g'].includes(k)) this.fileCur = 0;
    else if (['end', 'G'].includes(k)) this.fileCur = Math.max(n - 1, 0);
    else if (['enter', 'right', 'l'].includes(k) && n && t.isDir(kids[this.fileCur])) {
      this.trail.set(this.dir, this.fileCur);
      this.dir = kids[this.fileCur];
      this.fileCur = this.trail.get(this.dir) ?? 0;
      this.fileTop = 0;
    } else if (['left', 'backspace'].includes(k)) {
      // Going up from the top level, or from a snapshot's only folder, returns to the snapshot list.
      if (!this.dir || (t.roots.length === 1 && this.dir === t.roots[0])) this.screen = 'snapshots';
      else {
        this.trail.set(this.dir, this.fileCur);
        const up = t.parent(this.dir);
        this.fileCur = Math.max((t.children.get(up) ?? []).indexOf(this.dir), 0);
        this.dir = up;
        this.fileTop = 0;
      }
    } else if ([' ', 'x'].includes(k) && n) {
      // A path inside a selected folder can't be toggled on its own.
      const p = kids[this.fileCur];
      if (!this.sel.has(p) && covered(p, this.sel)) this.flash = 'Its folder is already selected.';
      else {
        if (this.sel.has(p)) this.sel.delete(p);
        else this.selectPath(p);
        this.fileCur = Math.min(this.fileCur + 1, n - 1);
      }
    } else if (k === 'a') {
      // Toggle everything in this folder. Selecting also drops anything selected deeper inside it.
      const all = kids.every(p => this.sel.has(p));
      for (const p of kids) {
        if (all) this.sel.delete(p);
        else if (!covered(p, this.sel)) this.sel.add(p);
      }
      if (!all)
        for (const p of this.sel)
          if (path.posix.dirname(p) !== p && covered(path.posix.dirname(p), this.sel)) this.sel.delete(p);
    } else if (k === 'c') this.sel.clear();
    else if (k === 'r') {
      // Restore the selection, or the focused item when nothing is selected.
      const paths = [...this.sel].sort();
      if (!paths.length && n) paths.push(kids[this.fileCur]);
      if (paths.length) {
        const work = this.prepareRestore(key => {
          if (key === 'q') this.exited = true;
          else this.screen = 'snapshots';
        });
        if (!work) return;
        try {
          const rs = await RestoreState.create(this.snap!, this.shortID(this.snap!.id), paths, t, this.deps);
          if (this.prepared(work)) {
            this.rs = rs;
            this.screen = 'restore';
          }
        } finally {
          this.finishPreparing(work);
        }
      }
    }

    this.fileCur = Math.max(this.fileCur, 0);
    if ([' ', 'x', 'a', 'c'].includes(k)) this.countSel();
  }

  // Selecting a folder drops anything already selected inside it.
  selectPath(p: string): void {
    this.sel.add(p);
    if (this.tree?.isDir(p))
      for (const q of this.sel) if (q !== p && q.startsWith(p.replace(/\/$/, '') + '/')) this.sel.delete(q);
  }

  countSel(): void {
    const total = this.tree?.selectionTotals(this.sel);
    this.selFiles = total?.files ?? 0;
    this.selBytes = total?.bytes ?? 0;
  }

  shortID(id: string): string {
    return shortOf(this.short, id);
  }

  // Tells the terminal loop what to animate, the game or a spinner.
  animation(): 'game' | 'spinner' | undefined {
    if (this.game?.phase === 'playing') return 'game';
    if (this.loading || (this.screen === 'restore' && this.rs.phase === 'running')) return 'spinner';
    return undefined;
  }

  tick(): void {
    this.game?.tick();
  }

  // Runs when the terminal closes and again from runBrowser. A running restore is recorded, and kept on the
  // second call, so runBrowser can report it. Then the game's sound, the folder picker and every storage call are
  // stopped.
  close(): void {
    this.stoppedRestore ||= this.screen === 'restore' && this.rs.phase === 'running';
    void this.game?.snd?.close();
    this.rs.pickController?.abort();
    this.controller.abort();
  }

  // The key fingerprint stays covered until [v].
  keyLabel(): string {
    return style(
      this.showKey ? 'text' : 'redacted',
      this.showKey ? this.repo.fingerprint : ' '.repeat(this.repo.fingerprint.length),
    );
  }

  keyHint(): string {
    return this.showKey ? 'hide key' : 'show key';
  }

  // Draws one frame at exactly the window size. An error covers everything, then a load in progress, the
  // game, an overlay and finally the current screen.
  view(): string {
    if (this.w <= 0 || this.h <= 0) return '';
    let body: string;
    if (this.err) body = this.dialog(this.errorContent(), this.dialogW(64), this.errorTop, true);
    else if (this.loading && this.screen === 'home') body = this.viewHome();
    else if (this.loading)
      body = this.center(
        style('bold', ['|', '/', '-', '\\'][this.spin % 4]) + style('text', ' ' + this.loading + '...'),
      );
    else if (this.game) body = this.center(this.game.view());
    else if (this.overlay) body = this.dialog(this.overlayContent(), this.overlayW(), this.overlayTop);
    else if (this.screen === 'home') body = this.viewHome();
    else if (this.screen === 'snapshots') body = this.viewSnapshots();
    else if (this.screen === 'files') body = this.viewFiles();
    else if (this.screen === 'diff') body = this.viewDiff();
    else body = this.dialog(restoreContent(this), this.dialogW(80), this.rs.top);

    // Fill the body out to the content area and clip the whole frame, so every cell gets the background.
    body = place(this.innerW(), this.areaH(), clip(body, this.innerW(), this.areaH()), 'left', 'top');
    return clip(
      place(this.w, this.h, stack(this.header(), fill(this.innerW()), body, fill(this.innerW()), this.footer())),
      this.w,
      this.h,
    );
  }

  // Draws the title and where you are on the left, and the storage and key fingerprint on the right. The
  // right side drops out when it doesn't fit.
  header(): string {
    let left = style('title', 'FROST');
    let crumb = '';
    if (this.screen === 'snapshots')
      crumb = 'snapshots' + (this.snaps.length ? `  ${this.snapCur + 1} of ${this.snaps.length}` : '');
    else if (this.screen === 'files' && this.snap) {
      const id = this.shortID(this.snap.id);
      const iw = Math.min(width(id), Math.max(Math.trunc((this.innerW() - 12) / 2), 8));
      crumb = truncate(id, iw) + '  ' + shortPath(this.dir, Math.max(this.innerW() - iw - 11, 1));
    } else if (this.screen === 'diff') {
      const w = Math.max(Math.trunc((this.innerW() - 18) / 2), 1);
      crumb =
        'compare ' +
        truncate(this.shortID(this.diffFrom?.id ?? ''), w) +
        ' → ' +
        truncate(this.shortID(this.diffTo?.id ?? ''), w);
    } else if (this.screen === 'restore') crumb = 'restore from ' + this.rs.shown;
    if (this.game) crumb = 'icebreaker';
    else if (this.overlay) crumb = this.overlay;
    if (crumb) left += style('dim', '  ' + truncate(crumb, Math.max(this.innerW() - width(left) - 2, 0)));

    const right = style('dim', printable(this.repo.label) + '  key ') + this.keyLabel();
    const gap = this.innerW() - width(left) - width(right);
    return gap < 1 ? left + fill(Math.max(this.innerW() - width(left), 0)) : left + fill(gap) + right;
  }

  // Draws a rule, then the key hints for whatever is showing, or the flash notice in their place.
  footer(): string {
    const w = this.innerW();
    const rule = style('faded', '─'.repeat(w));
    if (this.flash) return rule + '\n' + pad(style('caution', printable(this.flash)), w);
    let hints: string[];
    if (this.err)
      hints =
        this.errorMaxTop() > 0
          ? [hint('↑↓', 'scroll'), hint('esc', 'dismiss'), hint('q', 'quit')]
          : [hint('any key', 'dismiss'), hint('q', 'quit')];
    else if (this.game) {
      hints = [hint('← →', 'move'), hint('space', 'shoot'), hint('p', 'pause')];
      if (this.game.snd?.available()) hints.push(hint('m', this.game.muted ? 'unmute' : 'mute'));
      hints.push(hint('esc', 'back'));
    } else if (this.overlay) {
      hints = [hint('esc', 'close'), hint('v', this.keyHint())];
      if (this.overlayMaxTop() > 0) hints.push(hint('↑↓', 'scroll'));
    } else if (this.loading) hints = [hint('q', 'quit')];
    else {
      if (this.screen === 'home') hints = [hint('enter', 'browse snapshots'), hint('r', 'refresh')];
      else if (this.screen === 'snapshots')
        hints = this.snaps.length
          ? [
              hint('enter', 'open'),
              hint('d', 'diff'),
              hint('m', this.snaps[this.snapCur].id === this.marked ? 'unmark' : 'mark'),
              hint('esc', 'back'),
            ]
          : [hint('esc', 'back')];
      else if (this.screen === 'files')
        hints = [
          hint('space', 'select'),
          hint('r', 'restore'),
          hint('enter', 'open'),
          hint('←', 'up'),
          hint('esc', 'snapshots'),
        ];
      else if (this.screen === 'diff') hints = [hint('↑↓', 'scroll'), hint('esc', 'back')];
      else hints = restoreHints(this.rs);

      // A restore dialog that scrolls gets a scroll hint. Other screens add the global keys, shedding the
      // optional ones first and then the screen's own, so help and quit always show.
      if (this.screen === 'restore') {
        if (this.restoreMaxTop() > 0) {
          if (this.rs.phase === 'done') hints = [hint('enter', 'files'), hint('q', 'quit')];
          hints.splice(1, 0, hint('pgup pgdn', 'scroll'));
        }
      } else {
        const optional = [hint('v', this.keyHint()), hint('s', 'settings')];
        const keep = [hint('h', 'help'), hint('q', 'quit')];
        while (optional.length && width([...hints, ...optional, ...keep].join('   ')) > w) optional.pop();
        while (hints.length && width([...hints, ...keep].join(' ')) > w) hints.pop();
        hints.push(...optional, ...keep);
      }
    }
    return rule + '\n' + pad(fitHints(hints, w), w);
  }

  // Draws the status box on the home screen.
  summary(): string {
    const row = (k: string, v: string) => cutTo(style('dim', padPlain(k, 13)) + v, Math.max(this.innerW() - 4, 1));
    const rows: string[] = [];
    if (!this.snaps.length) rows.push(row('snapshots', style('text', 'none yet, run `frost backup`')));
    else {
      const s = this.snaps[0];
      rows.push(
        row('snapshots', style('text', `${this.snaps.length}, newest ${ago(s.time)}`)),
        row('protected', style('text', `${s.stats.files} files, ${humanBytes(s.stats.bytes)}`)),
      );
    }

    const last = this.st.last;
    if (last && (this.st.hasLast ?? true)) {
      rows.push(
        row(
          'last backup',
          last.error
            ? style('error', 'failed ') + style('text', ago(last.time))
            : (last.skipped ?? 0) > 0
              ? style('caution', `ok, ${last.skipped} items unreadable `) + style('text', ago(last.time))
              : style('good', 'ok ') + style('text', ago(last.time)),
        ),
      );
      if (!last.error && (last.kept ?? 0) > 0)
        rows.push(row('busy files', style('caution', `${last.kept} kept their previous copy`)));
    }

    const v = this.st.verify;
    rows.push(
      row(
        'health',
        !v || this.st.hasVerify === false
          ? style('dim', 'not checked yet')
          : !v.failures?.length
            ? style('good', 'ok ') + style('text', `${v.checked} objects checked ${ago(v.time)}`)
            : style('error', `${v.failures.length} problems found ${ago(v.time)}`),
      ),
    );
    const w = Math.max(...rows.map(width));
    return box(stack(...rows.map(r => pad(r, w))));
  }

  // Draws the wordmark, tagline and status box. A window too small for the wordmark gets the plain title
  // and no tagline.
  viewHome(): string {
    let info = this.summary();
    if (this.loading)
      info = style('bold', ['|', '/', '-', '\\'][this.spin % 4]) + style('text', ' ' + this.loading + '...');
    const w = this.innerW();
    const mark = logo(w, this.areaH() - 4 - height(info));
    const row = (s: string) => centerRow(w, s);
    return this.center(
      height(mark) > 1
        ? stack(row(mark), fill(w), row(style('dim', 'back up your files.')), fill(w, 2), row(info))
        : stack(row(mark), fill(w, 2), row(info)),
    );
  }

  // Draws the snapshot list, with a detail panel beside it in wide windows.
  viewSnapshots(): string {
    const w = this.innerW();
    const h = this.bodyH();
    if (!this.snaps.length)
      return this.center(
        style('text', 'No snapshots yet. Run ') + style('bold', 'frost backup') + style('text', ' first.'),
      );

    const detail = w >= 90;
    const lw = detail ? Math.trunc((w * 3) / 5) : w;
    const inner = lw - 4;
    const top = windowTop(this.snapPositions[this.snapCur], this.snapLayout.length, h);
    const lines: string[] = [];
    for (const r of this.snapLayout.slice(top, top + h)) {
      if (r.header) {
        lines.push(pad(style('bold', r.header), inner));
        continue;
      }
      const s = this.snaps[r.idx!];
      const text = snapshotListLabel(
        s,
        this.shortID(s.id),
        s.id === this.marked ? '* ' : '  ',
        this.snapCountW,
        this.snapSizeW,
        inner,
      );
      lines.push(
        r.idx === this.snapCur
          ? style('selected', padPlain(text, inner))
          : pad(style(s.id === this.marked ? 'caution' : 'text', text), inner),
      );
    }
    const list = box(lines.join('\n'), true, { w: lw - 2, h });
    return detail
      ? side(1, list, box(this.snapDetail(this.snaps[this.snapCur], w - lw - 5), false, { w: w - lw - 3, h }))
      : list;
  }

  // Draws the detail panel for one snapshot.
  snapDetail(s: Snapshot, w: number): string {
    const row = (k: string, v: string) => pad(style('dim', padPlain(k, 10)) + style('text', truncate(v, w - 10)), w);
    let lines = [
      pad(style('bold', truncate(this.shortID(s.id), w)), w),
      fill(w),
      row('taken', dateLabel(s.time, 'second')),
      row('', ago(s.time)),
      row('host', s.host),
      row('files', `${s.stats.files} in ${s.stats.dirs} folders`),
      row('size', humanBytes(s.stats.bytes)),
      row('new data', humanBytes(s.stats.new_bytes)),
      fill(w),
      pad(style('dim', 'paths'), w),
    ];
    let notes: string[] = [];
    if (s.stats.skipped) notes.push(fill(w), para('caution', `${s.stats.skipped} items couldn't be read`, w));
    if (s.stats.kept) notes.push(fill(w), para('caution', `${s.stats.kept} busy files kept their previous copy`, w));
    if (this.marked && this.marked !== s.id)
      notes.push(fill(w), pad(style('dim', truncate('[d] compares with ' + this.shortID(this.marked), w)), w));
    notes = notes.flatMap(n => n.split('\n'));

    // When the panel is short, blank rows go first and then the relative time. Notes win over the details,
    // and one row stays for the paths, which end with a count of any that didn't fit.
    if (lines.length + notes.length + Math.min(s.paths.length, 2) > this.bodyH()) {
      lines = lines.filter(l => strip(l).trim());
      notes = notes.filter(l => strip(l).trim());
      if (lines.length + notes.length + Math.min(s.paths.length, 2) > this.bodyH()) lines.splice(2, 1);
    }
    const reserve = Math.min(s.paths.length, 1);
    notes = notes.slice(0, Math.max(this.bodyH() - reserve, 0));
    lines = lines.slice(0, Math.max(this.bodyH() - notes.length - reserve, 0));
    const room = Math.max(this.bodyH() - lines.length - notes.length, 0);
    let show = Math.min(s.paths.length, room);
    if (show < s.paths.length && show > 0) show--;
    for (const p of s.paths.slice(0, show)) lines.push(pad(style('text', truncate('  ' + shortPath(p, w - 2), w)), w));
    if (s.paths.length - show > 0 && room > 0) lines.push(pad(style('dim', '  +' + (s.paths.length - show)), w));
    return [...lines, ...notes].join('\n');
  }

  // Draws the selection status and column titles above the file list. A status too wide for the name
  // column wraps onto rows of its own.
  fileHeader(): string[] {
    const inner = this.innerW() - 4;
    const [nw, sw, tw] = fileColumns(inner);
    const lines: string[] = [];
    let status =
      this.selFiles > 0
        ? style('bold', `${this.selFiles} files selected (${humanBytes(this.selBytes)})`)
        : style('dim', `${this.tree?.children.get(this.dir)?.length ?? 0} items`);
    if (width(status) > nw + 4) {
      lines.push(...wrapStyled(status, inner));
      status = '';
    }
    if (status || sw || tw)
      lines.push(
        pad(
          pad(status, nw + 4) +
            (sw ? style('dim', '  ' + 'size'.padStart(sw)) : '') +
            (tw ? style('dim', '  ' + padPlain('modified', tw)) : ''),
          inner,
        ),
      );
    lines.push(pad(style('faded', '─'.repeat(inner)), inner));
    return lines.slice(0, Math.max(this.bodyH() - 1, 1));
  }

  fileListH(): number {
    return Math.max(this.bodyH() - this.fileHeader().length, 1);
  }

  // Draws the current folder. Each row starts with [x] when selected, [.] when inside a selected folder and
  // [ ] otherwise. Top-level rows show full paths, and folder sizes are their recursive totals.
  viewFiles(): string {
    const w = this.innerW();
    const h = this.bodyH();
    const inner = w - 4;
    const t = this.tree!;
    const kids = t.children.get(this.dir) ?? [];
    const [nw, sw, tw] = fileColumns(inner);
    const lines = this.fileHeader();
    const listH = Math.max(h - lines.length, 1);
    const top = windowTop(this.fileCur, kids.length, listH);
    if (!kids.length) lines.push(pad(style('dim', '(empty folder)'), inner));
    for (let i = top; i < Math.min(top + listH, kids.length); i++) {
      const p = kids[i];
      const f = t.files.get(p)!;
      const mark = this.sel.has(p) ? '[x] ' : covered(p, this.sel) ? '[.] ' : '[ ] ';
      let name = !this.dir ? shortPath(p, nw - (f.type === 'dir' ? 1 : 0)) : path.posix.basename(p);
      let size = humanBytes(f.size ?? 0);
      if (f.type === 'dir') {
        name = truncate(name, Math.max(nw - 1, 0)) + '/';
        size = humanBytes(t.totals.get(p)?.bytes ?? 0);
      } else if (f.type === 'symlink') {
        name += ' -> ' + (f.target ?? '');
        size = '';
      }
      let text = mark + padPlain(truncate(name, nw), nw);
      if (sw) text += '  ' + truncate(size, sw).padStart(sw);
      if (tw) text += '  ' + dateLabel(f.mtime, tw === 16 ? 'minute' : 'date');
      lines.push(
        i === this.fileCur
          ? style('selected', padPlain(text, inner))
          : this.sel.has(p) || covered(p, this.sel)
            ? pad(style('bold', text), inner)
            : f.type === 'dir'
              ? pad(style('text', text), inner)
              : pad(style('dim', mark) + style('text', text.slice(mark.length)), inner),
      );
    }
    return box(lines.join('\n'), true, { w: w - 2, h });
  }

  // Draws the counts of added, removed and changed files above the comparison, wrapped to fit.
  diffHeader(): string[] {
    const inner = this.innerW() - 4;
    const parts = [
      style(this.diffAdd ? 'good' : 'dim', `+${this.diffAdd} added`),
      style(this.diffDel ? 'removed' : 'dim', `-${this.diffDel} removed`),
      style(this.diffMod ? 'caution' : 'dim', `~${this.diffMod} changed`),
    ];
    const lines: string[] = [];
    let line = '';
    for (const p of parts) {
      if (line && width(line) + 3 + width(p) > inner) {
        lines.push(...wrapStyled(line, inner));
        line = '';
      }
      if (line) line += fill(3);
      line += p;
    }
    lines.push(...wrapStyled(line, inner), pad(style('faded', '─'.repeat(inner)), inner));
    return lines.slice(0, Math.max(this.bodyH() - 1, 1));
  }

  diffListH(): number {
    return Math.max(this.bodyH() - this.diffHeader().length, 1);
  }

  diffMaxTop(): number {
    return Math.max(this.changes.length - this.diffListH(), 0);
  }

  // Draws the comparison list. Long paths lose their start, so the file name stays visible.
  viewDiff(): string {
    const w = this.innerW();
    const h = this.bodyH();
    const inner = w - 4;
    const lines = this.diffHeader();
    if (!this.changes.length) lines.push(pad(style('dim', 'No differences.'), inner));
    for (const c of this.changes.slice(this.diffTop, this.diffTop + Math.max(h - lines.length, 1))) {
      const sym = c.kind === 'added' ? '+' : c.kind === 'removed' ? '-' : '~';
      const st: Style = c.kind === 'added' ? 'good' : c.kind === 'removed' ? 'removed' : 'caution';
      const detail =
        c.kind === 'added'
          ? humanBytes(c.new?.size ?? 0)
          : c.kind === 'removed'
            ? humanBytes(c.old?.size ?? 0)
            : humanBytes(c.old?.size ?? 0) + ' → ' + humanBytes(c.new?.size ?? 0);
      const dw = Math.min(24, Math.max(Math.trunc(inner / 3), 0));
      const pw = Math.max(inner - dw - 4, 0);
      const p = truncateLeft(relToRoot(c.path, this.diffTo?.paths ?? [], this.diffFrom?.paths ?? []), pw);
      lines.push(
        pad(
          style(st, sym + ' ') +
            style('text', padPlain(p, pw)) +
            style('dim', '  ' + truncate(detail, dw).padStart(dw)),
          inner,
        ),
      );
    }
    return box(lines.join('\n'), true, { w: w - 2, h });
  }

  overlayW(): number {
    return this.dialogW(90);
  }

  overlayContent(): string {
    return this.overlay === 'help'
      ? this.helpContent(this.overlayW())
      : this.overlay === 'settings'
        ? this.settingsContent(this.overlayW())
        : '';
  }

  overlayH(): number {
    return Math.max(this.dialogRows(height(this.overlayContent()))[0], 1);
  }

  overlayMaxTop(): number {
    return this.dialogMaxTop(height(this.overlayContent()));
  }

  hasPermafrostAccount(): boolean {
    return this.cfg.storage.backend === 'permafrost' && isDefaultPermafrost(this.cfg.storage.permafrost.url);
  }

  // Lists the keys, in two columns when the dialog is wide enough.
  helpContent(w: number): string {
    const cw = w >= 68 ? Math.trunc((w - 3) / 2) : w;
    const section = (title: string, rows: [string, string][]) => {
      const out = [style('dim', title)];
      for (const [key, label] of rows)
        para('text', label, Math.max(cw - 12, 1))
          .split('\n')
          .forEach((l, i) => {
            const k = '[' + key + ']';
            out.push(pad((i ? fill(12) : style('bold', k) + fill(Math.max(12 - width(k), 1))) + l, cw));
          });
      return stack(...out);
    };
    const everywhere = section('Everywhere', [
      ['h', 'help'],
      ['s', 'settings'],
      ['v', 'show / hide key'],
      ['esc', 'back'],
      ['q', 'quit'],
    ]);
    const moving = section('Moving', [
      ['↑↓', 'move (or k j)'],
      ['pgup pgdn', 'page'],
      ['g G', 'first / last'],
      ['enter', 'open'],
      ['←', 'parent folder'],
    ]);
    const snapshots = section('Snapshots', [
      ['d', 'compare with previous snapshot'],
      ['m', 'mark source, then [d] on another snapshot'],
    ]);
    const files = section('Files', [
      ['space', 'select / unselect'],
      ['a', 'select / clear all'],
      ['c', 'clear selection'],
      ['r', 'restore selected or focused item'],
    ]);

    const body =
      w >= 68
        ? stack(side(3, everywhere, snapshots), fill(w), side(3, moving, files))
        : stack(everywhere, fill(1), moving, fill(1), snapshots, fill(1), files);
    let footer = style('dim', 'Documentation  ') + style('bold', 'getfro.st/help');
    if (width(footer) > w) footer = stack(para('dim', 'Documentation', w), para('bold', 'getfro.st/help', w));
    const account = this.hasPermafrostAccount()
      ? stack(...wrapStyled(style('bold', '[p]') + ' Permafrost account', w))
      : '';
    return stack(body, fill(1), footer, ...(account ? [fill(1), account] : []));
  }

  // Shows the config read-only. Narrow dialogs put each label above its value.
  settingsContent(w: number): string {
    const lines: string[] = [];
    const labelW = 19;
    const vw = w >= 31 ? w - 19 : w;
    const rowValue = (k: string, v: string) => {
      if (w < 31) {
        if (k) lines.push(para('dim', k, w));
        lines.push(v);
      } else v.split('\n').forEach((l, i) => lines.push(style('dim', padPlain(i ? '' : k, labelW)) + l));
    };
    const row = (k: string, v: string) => rowValue(k, para('text', v || 'none', vw));

    if (!this.cfg.paths.length) row('backing up', 'none');
    this.cfg.paths.forEach((p, i) => rowValue(i ? '' : 'backing up', style('text', shortPath(p, vw))));
    row('skipping', this.cfg.exclude.join(', '));
    lines.push(fill(w));
    row('automatic backups', this.cfg.schedule.enabled ? this.cfg.schedule.every : 'off');
    if (this.st.updates) row('updates', this.st.updates);
    row('spot check', `${this.cfg.verify.sample} chunks after each backup`);
    lines.push(fill(w));
    row('storage', this.repo.label);
    rowValue('key fingerprint', this.keyLabel());
    lines.push(fill(w), ...settingsFooter(this.st.version ?? '', w));
    return stack(...lines.map(l => pad(l, w)));
  }

  errorContent(): string {
    const w = this.dialogW(64);
    return stack(para('error', 'Something went wrong', w), fill(w), para('text', this.err?.message ?? '', w));
  }

  errorMaxTop(): number {
    return this.dialogMaxTop(height(this.errorContent()));
  }

  restoreMaxTop(): number {
    return this.dialogMaxTop(height(restoreContent(this)));
  }

  // Handles keys for the restore dialog. Page keys scroll it, and any other key scrolls back to the top first.
  async restoreKey(k: string): Promise<void> {
    const rs = this.rs;
    if (['pgup', 'pgdown'].includes(k)) {
      this.rs.top = Math.max(
        0,
        Math.min(rs.top + (k === 'pgup' ? -1 : 1) * Math.max(this.areaH() - 3, 1), this.restoreMaxTop()),
      );
      return;
    }
    rs.top = 0;

    if (rs.phase === 'confirm') {
      if (['esc', 'q'].includes(k)) this.screen = 'files';
      else if (/^[123]$/.test(k)) this.chooseDest(+k - 1);
      else if (['up', 'k', 'shift+tab', 'down', 'j', 'tab'].includes(k)) {
        // Step to the next destination, skipping unavailable ones. The new folder elsewhere is always available.
        const by = ['up', 'k', 'shift+tab'].includes(k) ? -1 : 1;
        for (let d = (rs.dest + 3 + by) % 3; ; d = (d + 3 + by) % 3)
          if (!rs.unavailable(d)) {
            rs.dest = d;
            break;
          }
      } else if (k === 'c' && rs.dest === 1) await this.startPick();
      else if (['enter', 'y'].includes(k)) {
        if (rs.dest === 1) {
          if (!rs.picked) await this.startPick();
          else rs.phase = 'ready';
        } else await this.confirmRestore(k);
      }
    } else if (rs.phase === 'ready') {
      if (['enter', 'y'].includes(k)) await this.confirmRestore(k);
      else if (k === 'c') await this.startPick();
      else if (['esc', 'q'].includes(k)) {
        rs.phase = 'confirm';
        this.screen = 'files';
      }
    } else if (rs.phase === 'picking') {
      if (['esc', 'q'].includes(k)) {
        rs.pickController?.abort();
        rs.phase = rs.afterPick();
      } else if (k === 't') {
        rs.pickController?.abort();
        this.startTyping();
      }
    } else if (rs.phase === 'done') {
      if (k === 'q') this.exited = true;
      else {
        this.sel.clear();
        this.selFiles = this.selBytes = 0;
        this.screen = 'files';
      }
    }
  }

  chooseDest(d: number): void {
    const err = this.rs.unavailable(d);
    if (err) this.flash = `Option ${d + 1} isn't available: ${err.message}.`;
    else this.rs.dest = d;
  }

  // Starts the restore. Overwriting needs [y]. For a new folder, frost looks up the restore folder again,
  // since the folders there may have changed since the dialog opened, and stops so the user can review a
  // different one. A folder an earlier restore can carry on in counts as well as a free one.
  async confirmRestore(k: string): Promise<void> {
    const rs = this.rs;
    if (!['confirm', 'ready'].includes(rs.phase)) return;
    const work = this.prepareRestore(() => (this.screen = 'files'));
    if (!work) return;
    try {
      if (rs.dest === 2) {
        if (k !== 'y') {
          this.flash = 'Overwriting replaces existing files. Press [y] to confirm.';
          return;
        }
        rs.folder = '';
      } else {
        const current = rs.dest === 1 ? rs.chosen : rs.beside;
        const parent = rs.dest === 1 ? rs.picked : path.dirname(rs.beside);
        const { dir } = await this.deps.newRestoreFolder(parent, rs.snap!.id, rs.paths);
        if (!this.prepared(work)) return;
        if (dir !== current) {
          if (rs.dest === 1) rs.chosen = dir;
          else rs.beside = dir;
          this.flash = 'That folder now exists. Review the new destination and press [enter].';
          return;
        }
        rs.folder = dir;
      }
      rs.phase = 'running';
    } catch (e) {
      if (this.prepared(work)) {
        rs.err = asError(e);
        rs.phase = 'done';
      }
      return;
    } finally {
      this.finishPreparing(work);
    }

    this.onChange?.();
    try {
      rs.res = await this.repo.restore(
        rs.snap!.id,
        {
          include: rs.paths,
          ...(rs.dest !== 2 ? { target: rs.folder, newTarget: true, base: rs.base } : {}),
          progress: p => {
            rs.done = p.files;
            rs.total = p.totalFiles;
            rs.current = p.path;
            this.onChange?.();
          },
        },
        this.signal,
      );
      rs.phase = 'done';
      rs.top = 0;

      // Show the restored files in the file manager. Failing to open them only earns a notice.
      if (!this.signal?.aborted && this.deps.canOpen()) {
        const [p, file] = rs.showPath();
        if (p)
          try {
            await this.deps.openFolder(p, file);
          } catch (e) {
            this.flash = "Couldn't open the restored files: " + asError(e).message;
          }
      }
    } catch (e) {
      // A RestoreError carries how much was restored before it stopped.
      if (e instanceof RestoreError) rs.res = e.result;
      rs.err = asError(e);
      rs.phase = 'done';
      rs.top = 0;
    }
    this.onChange?.();
  }

  // Opens the system folder picker without waiting for it, or falls back to typing when there isn't one.
  // The previous or original folder sets the start location when it responds. Otherwise the picker starts at home.
  async startPick(): Promise<void> {
    if (this.restorePreparation) return;
    const rs = this.rs;
    rs.pickController?.abort();
    const seq = ++rs.pickSeq;
    const controller = new AbortController();
    rs.pickController = controller;
    rs.phase = 'picking';
    this.onChange?.();

    // The answer only counts while this is still the latest picker and it hasn't been cancelled.
    const signal = AbortSignal.any([controller.signal, this.signal!]);
    const current = () =>
      this.rs === rs &&
      this.screen === 'restore' &&
      !this.exited &&
      rs.phase === 'picking' &&
      seq === rs.pickSeq &&
      !signal.aborted;
    const failed = (e: unknown) => {
      if (!current()) return;
      rs.phase = rs.afterPick();
      if (e !== desktop.errCanceled) {
        this.startTyping();
        this.flash = "Couldn't open the folder picker, so type the folder instead: " + asError(e).message;
      }
      this.onChange?.();
    };
    if (!current()) return;
    try {
      const canPick = await this.deps.canPick();
      if (!current()) return;
      if (!canPick) {
        this.startTyping();
        this.flash = "There's no folder picker here, so type the folder instead.";
        this.onChange?.();
        return;
      }
      const start = await pickerStartFolder(rs.picked || rs.base, os.homedir(), signal);
      if (!current()) return;
      void this.deps.pickFolder('Restore to', start, signal).then(async p => {
        if (!current()) return;
        try {
          await rs.setPicked(p, this.deps, signal);
          if (!current()) return;
          rs.phase = 'ready';
        } catch (e) {
          if (!current()) return;
          rs.phase = rs.afterPick();
          this.flash = asError(e).message;
        }
        this.onChange?.();
      }, failed);
    } catch (e) {
      failed(e);
    }
  }

  // Switches to typing a folder, starting from the one picked before.
  startTyping(): void {
    this.rs.phase = 'typing';
    this.rs.inputErr = '';
    this.rs.input = new Form([
      { name: 'folder', placeholder: '~/Desktop', value: this.rs.picked ? shortPath(this.rs.picked, 1000) : '' },
    ]);
  }

  // Handles keys while typing a folder. Enter checks the folder, and a leading ~/ means the home folder.
  async restoreTypingKey(e: KeyEvent): Promise<void> {
    const rs = this.rs;
    if (['pgup', 'pgdown'].includes(e.key)) return this.restoreKey(e.key);
    rs.top = 0;
    if (e.key === 'esc') {
      rs.phase = rs.afterPick();
      return;
    }
    rs.inputErr = '';
    if (!rs.input.key(e)) return;
    const v = rs.input.values()[0];
    if (!v) {
      rs.inputErr = 'Type the folder to restore into.';
      return;
    }
    const work = this.prepareRestore(() => (rs.phase = rs.afterPick()));
    if (!work) return;
    try {
      await rs.setPicked(
        v.startsWith('~/') || v.startsWith('~\\') ? path.join(os.homedir(), v.slice(2)) : v,
        this.deps,
        AbortSignal.any([work.controller.signal, this.signal!]),
      );
      if (this.prepared(work)) rs.phase = 'ready';
    } catch (e) {
      if (this.prepared(work)) rs.inputErr = asError(e).message;
    } finally {
      this.finishPreparing(work);
    }
  }
}

// Cuts a styled string to at most w cells without padding a shorter one.
function cutTo(s: string, w: number): string {
  return pad(s, Math.min(width(s), w));
}

// Runs the browser until the user quits. Closing during a restore throws RestoreStopped once the terminal
// is restored, so the CLI can say how to carry on.
export async function runBrowser(
  repo: BrowserRepo,
  cfg: Config,
  st: State = {},
  options: TerminalOptions = {},
  deps: Partial<BrowserDeps> = {},
): Promise<void> {
  const m = new BrowserModel(repo, cfg, st, options.signal, deps);
  void m.init();
  try {
    await runTerminal(m, options);
  } finally {
    m.close();
  }
  if (m.stoppedRestore) throw new RestoreStopped();
}
