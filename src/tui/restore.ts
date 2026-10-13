// The browser's restore dialog. RestoreState follows one restore from choosing a destination to the result,
// and restoreContent draws the dialog for its current phase. BrowserModel in browser.ts handles the keys.

import path from 'node:path';
import { stat } from 'node:fs/promises';
import { commonDir, restoreBase, restoreRel, isRoot } from '../core/snapshot.js';
import { restoreFolderName } from '../engine/restore.js';
import type { Snapshot, RestoreResult } from './types.js';
import type { BrowserModel, BrowserDeps } from './browser.js';
import { dateLabel } from './browser.js';
import { FileTree } from './tree.js';
import { Form, inputBox } from './input.js';
import {
  style,
  printable,
  pad,
  padPlain,
  truncate,
  fill,
  stack,
  humanBytes,
  ago,
  shortPath,
  para,
  hint,
  width,
  type Style,
} from './render.js';

// The browser shows this when a restore stops early. Running the same restore again resumes in the same folder.
export const carryOn =
  "What's restored so far was kept. Restore the same files to the same place again and frost carries on where it stopped.";

let probingStartFolder = false;

// The initial folder is a convenience. Slow locations get 100 ms, and only one probe can remain pending.
export async function pickerStartFolder(original: string, fallback: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!original || !path.isAbsolute(original) || probingStartFolder) return fallback;
  probingStartFolder = true;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const timeout = new Promise<string>(resolve => (timer = setTimeout(resolve, 100, fallback)));
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return stat(original);
        })
        .then(
          s => (s.isDirectory() ? original : fallback),
          () => fallback,
        )
        .finally(() => (probingStartFolder = false)),
      timeout,
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export class RestoreState {
  snap?: Snapshot;
  shown = '';
  paths: string[] = [];
  files = 0;
  bytes = 0;

  // The destination. 0 makes a new folder beside the originals, 1 makes a new folder elsewhere and 2
  // overwrites the originals. The dialog numbers them [1] to [3].
  dest = 0;

  // The confirm phase picks a destination. The picking phase waits on the system folder picker, typing takes
  // a typed path, and ready previews the new folder before the restore is running and then done.
  phase: 'confirm' | 'picking' | 'typing' | 'ready' | 'running' | 'done' = 'confirm';
  top = 0;

  // Restored paths are relative to base, the selection's common parent. The new folder for dest 0 is
  // beside, and the errors say why dest 0 or 2 isn't available.
  base = '';
  beside = '';
  besideErr?: Error;
  overErr?: Error;

  // For dest 1, picked is the folder the user chose and chosen is the new folder frost will make inside it.
  // The tops are the top-level entries the restore creates, for the preview. The restore writes into
  // folder, which stays empty when overwriting.
  picked = '';
  chosen = '';
  tops: string[] = [];
  folder = '';

  // Each folder picker gets a number, so an answer from one that was replaced or cancelled is ignored.
  pickSeq = 0;
  pickController?: AbortController;

  input = new Form();
  inputErr = '';

  // show and showFile say what to open in the file manager afterwards. The rest track progress and results.
  show = '';
  showFile = false;
  done = 0;
  total = 0;
  current = '';
  res: RestoreResult = { files: 0, bytes: 0 };
  err?: Error;

  // Works out the totals, the preview and which destinations are available. When there's no folder beside
  // the originals, the dialog starts on a folder elsewhere instead.
  static async create(
    snap: Snapshot,
    shown: string,
    paths: string[],
    t: FileTree,
    deps: BrowserDeps,
  ): Promise<RestoreState> {
    const rs = new RestoreState();
    rs.snap = snap;
    rs.shown = shown;
    rs.paths = paths;
    rs.show = commonDir(paths);
    rs.base = restoreBase(paths);
    rs.showFile = paths.length === 1 && t.files.get(paths[0])?.type !== 'dir';
    const total = t.selectionTotals(new Set(paths));
    rs.files = total.files;
    rs.bytes = total.bytes;

    // Paths that can't be placed under base are left out of the preview.
    const seen = new Set<string>();
    for (const p of paths) {
      try {
        const rel = restoreRel(p, rs.base);
        let top = rel.split('/')[0];
        if (rel.includes('/') || t.isDir(p)) top += '/';
        seen.add(top);
      } catch {}
    }
    rs.tops = [...seen].sort();

    await Promise.all([
      deps.besideFolder(rs.base, snap.id, paths).then(
        r => (rs.beside = r.dir),
        e => (rs.besideErr = asError(e)),
      ),
      deps.canOverwrite(paths).catch(e => (rs.overErr = asError(e))),
    ]);
    if (rs.besideErr) rs.dest = 1;
    return rs;
  }

  // Only the beside and overwrite options can be unavailable.
  unavailable(d: number): Error | undefined {
    return d === 0 ? this.besideErr : d === 2 ? this.overErr : undefined;
  }

  // Where the dialog returns to when picking a folder ends without a new one.
  afterPick(): 'ready' | 'confirm' {
    return this.picked ? 'ready' : 'confirm';
  }

  // Checks the folder exists and finds a restore folder inside it, either a free one or one an earlier
  // restore of the same files can carry on in.
  async setPicked(dir: string, deps: Pick<BrowserDeps, 'newRestoreFolder'>, signal?: AbortSignal): Promise<void> {
    const abs = path.resolve(dir);
    try {
      if (!(await stat(abs)).isDirectory()) throw new Error();
    } catch {
      throw new Error("There's no folder at " + shortPath(abs, 60) + '.');
    }
    const { dir: chosen } = await deps.newRestoreFolder(abs, this.snap!.id, this.paths);
    signal?.throwIfAborted();
    this.picked = abs;
    this.chosen = chosen;
    this.dest = 1;
  }

  // Returns the path to open once the restore finishes, and whether it's a file. Overwrites open the original
  // location, and new folders open the restored copy.
  showPath(): [string, boolean] {
    if (this.dest === 2)
      return !this.show || isRoot(this.show) ? ['', false] : [path.normalize(this.show), this.showFile];
    try {
      return [path.join(this.folder, restoreRel(this.show, this.base)), this.showFile];
    } catch {
      return [this.folder, false];
    }
  }
}

// Turns anything thrown into an Error, so its message can be shown.
export const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

function restoreTitle(rs: RestoreState): string {
  return rs.files === 0
    ? 'Restore empty folders from ' + rs.shown
    : `Restore ${rs.files} files (${humanBytes(rs.bytes)}) from ${rs.shown}`;
}

function readyActions(): string[] {
  return [hint('enter', 'restore'), hint('c', 'change location'), hint('esc', 'cancel')];
}

// Lists the footer hints for each phase of the restore dialog.
export function restoreHints(rs: RestoreState): string[] {
  const choose = hint('1 2 3', 'choose');
  const cancel = hint('esc', 'cancel');
  if (rs.phase === 'confirm')
    return [
      hint(
        rs.dest === 2 ? 'y' : 'enter',
        rs.dest === 2 ? 'overwrite' : rs.dest === 1 ? (rs.picked ? 'continue' : 'choose folder') : 'restore',
      ),
      choose,
      cancel,
    ];
  if (rs.phase === 'ready') return readyActions();
  if (rs.phase === 'picking') return [hint('t', 'type a path'), cancel];
  if (rs.phase === 'typing') return [hint('enter', 'use folder'), hint('esc', 'back')];
  if (rs.phase === 'running') return [hint('ctrl+c', 'abort')];
  return [hint('any key', 'back to files'), hint('q', 'quit')];
}

// Draws a small tree of the new folder for the ready screen. More than four entries show three and a count.
function landing(rs: RestoreState, w: number): string[] {
  const line = (s: string) => pad(s, w);
  const lines = [
    line(style('text', shortPath(rs.picked, w))),
    line(style('faded', '└─ ') + style('bold', printable(path.basename(rs.chosen)) + '/') + style('dim', '  new')),
  ];
  let tops = rs.tops;
  let more = 0;
  if (tops.length > 4) {
    more = tops.length - 3;
    tops = tops.slice(0, 3);
  }
  tops.forEach((t, i) =>
    lines.push(
      line(style('faded', '   ' + (i === tops.length - 1 && !more ? '└─ ' : '├─ ')) + style('text', printable(t))),
    ),
  );
  if (more) lines.push(line(style('faded', '   └─ ') + style('dim', more + ' more')));
  return lines;
}

// Draws the restore dialog's content for the current phase. The browser wraps it in a scrolling box.
export function restoreContent(m: BrowserModel): string {
  const rs = m.rs;
  const w = m.dialogW(80);
  const lines: string[] = [];
  const line = (s: string) => pad(s, w);
  const paragraph = (st: Style, s: string) => lines.push(...para(st, s, w).split('\n'));

  if (rs.phase === 'confirm') {
    paragraph('bold', restoreTitle(rs));
    paragraph(
      'dim',
      'taken ' +
        dateLabel(rs.snap?.time ?? '0001-01-01T00:00:00Z') +
        ', ' +
        ago(rs.snap?.time ?? '0001-01-01T00:00:00Z'),
    );

    // Spacer rows and the heading only appear in taller windows. The path list shrinks to leave room
    // for the options.
    if (m.areaH() >= 17) lines.push(fill(w));
    const limit = Math.min(5, Math.max(m.areaH() - 13, 1));
    for (let i = 0; i < rs.paths.length; i++) {
      if (i === limit) {
        lines.push(line(style('dim', `  ... and ${rs.paths.length - limit} more`)));
        break;
      }
      lines.push(line(style('text', '  ' + shortPath(rs.paths[i], w - 2))));
    }
    if (m.areaH() >= 17) lines.push(fill(w), line(style('bold', 'Where to?')));

    // Wide dialogs show every option's note in a column. Narrow ones show only the selected option's
    // note, on its own line.
    const labelW = 27;
    const wide = w >= 76;
    const noteW = wide ? w - labelW - 13 : w - 11;
    const notes = [
      rs.besideErr ? 'not available' : 'in ' + shortPath(path.dirname(rs.beside), noteW),
      rs.picked ? 'in ' + shortPath(rs.picked, noteW) : 'choose a folder',
      rs.overErr ? 'not available' : "replaces what's there now",
    ];
    const labels = ['New folder beside originals', 'New folder elsewhere', 'Overwrite original files'];
    for (let d = 0; d < 3; d++) {
      const key = `[${d + 1}] `;
      const radio = rs.dest === d ? '(•) ' : '( ) ';
      const label = padPlain(labels[d], labelW + 2);
      const note = wide ? notes[d] : '';
      if (rs.dest === d) lines.push(style('selected', padPlain(truncate(key + radio + label + note, w), w)));
      else {
        const st = rs.unavailable(d) ? 'faded' : 'text';
        const nst = rs.unavailable(d) ? 'faded' : 'dim';
        lines.push(line(style(st, key) + style(st, radio + label) + style(nst, note)));
      }
      if (!wide && rs.dest === d) lines.push(line(style('dim', '        ' + truncate(notes[d], w - 8))));
    }

    // Explain each unavailable option, after a single blank row.
    let gap = true;
    for (const d of [0, 2]) {
      const e = rs.unavailable(d);
      if (e) {
        if (gap) {
          lines.push(fill(w));
          gap = false;
        }
        paragraph('dim', `Option ${d + 1} isn't available: ${e.message}.`);
      }
    }

    if (rs.dest === 2) {
      lines.push(fill(w));
      paragraph('caution', 'Files at the original paths will be overwritten.');
    }
  } else if (rs.phase === 'picking') {
    lines.push(line(style('bold', 'Choose a folder')), fill(w));
    paragraph('text', "Pick restore location in the window that's just opened.");
    paragraph('dim', 'frost makes a new ' + restoreFolderName(rs.snap!.id) + ' folder inside it.');
  } else if (rs.phase === 'ready') {
    paragraph('bold', restoreTitle(rs));
    paragraph('dim', 'into a new folder, so nothing already there is touched');
    lines.push(fill(w), ...landing(rs, w), fill(w));

    // The ready screen lists its actions inside the dialog, wrapping onto more rows when they don't fit.
    let row = '';
    for (const a of readyActions()) {
      if (!row) row = a;
      else if (width(row) + 3 + width(a) <= w) row += fill(3) + a;
      else {
        lines.push(line(row));
        row = a;
      }
    }
    lines.push(line(row));
  } else if (rs.phase === 'typing') {
    lines.push(line(style('bold', 'Type a folder')));
    paragraph('dim', 'frost makes a new ' + restoreFolderName(rs.snap!.id) + ' folder inside it.');
    lines.push(fill(w), inputBox(rs.input.fields[0], false, true, w));
    if (rs.inputErr) paragraph('error', rs.inputErr);
  } else if (rs.phase === 'running') {
    // The percentage stays between 0 and 100 even if the progress counts overshoot.
    const pct = Math.max(
      0,
      Math.min(rs.total > 0 ? Math.trunc((100 * Math.max(0, Math.min(rs.done, rs.total))) / rs.total) : 0, 100),
    );
    const barW = w - 8;
    const filled = Math.trunc((barW * pct) / 100);
    const bar = style('selected', ' '.repeat(filled)) + style('faded', '·'.repeat(barW - filled));
    lines.push(
      line(style('bold', ['|', '/', '-', '\\'][m.spin % 4]) + style('text', ' Restoring and checking every chunk...')),
      fill(w),
      line(bar + style('text', ' ' + String(pct).padStart(3) + '%')),
      line(style('dim', `${rs.done} of ${rs.total}  ${shortPath(rs.current, w - 20)}`)),
    );
  } else if (rs.phase === 'done') {
    let to = line(style('dim', 'to ') + style('text', 'their original locations'));
    if (rs.dest !== 2) to = rs.folder ? line(style('dim', 'to ') + style('text', shortPath(rs.folder, w - 10))) : '';

    // A failure says how much was written and whether running it again picks up where it stopped.
    if (rs.err) {
      lines.push(
        line(style('error', 'Restore failed')),
        line(
          style(
            'text',
            rs.res.files === 0
              ? 'No files were restored.'
              : `${rs.res.files} files completed (${humanBytes(rs.res.bytes)})`,
          ),
        ),
      );
      if (to) lines.push(to);
      if (rs.res.unfinished) paragraph('caution', carryOn);
      else if (rs.res.files > 0)
        paragraph('caution', 'Earlier changes remain. A file may have been written before a metadata error.');
      lines.push(fill(w));
      paragraph('text', rs.err.message);
    } else {
      lines.push(
        line(style('good', 'Restored ') + style('text', `${rs.res.files} files (${humanBytes(rs.res.bytes)})`)),
        to,
        fill(w),
      );
      paragraph('dim', 'Every chunk was decrypted and checked against its hash.');
    }
  }

  return stack(...lines);
}
