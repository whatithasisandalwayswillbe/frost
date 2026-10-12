// icebreaker, the hidden game in the browser. Ice blocks holding files fall towards your ship. Shoot the ice to thaw
// the files, catch them as they drop and dodge the bit rot. The browser owns the timer and calls tick and view.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { openRootSync } from '../platform/fs-root.js';
import { Player, type Clip } from '../platform/sound.js';
import { style, box, stack, pad, width, joinFit, wordmark, wrapPlain, type Style } from './render.js';

const mask = (1n << 64n) - 1n;

// A 128-bit PCG generator with DXSM output. It matches Go's math/rand/v2 PCG, along with its float, int and perm
// draws. Seeded tests compare game frames against recordings, so keep the constants and the order of draws.
class PCG {
  private state: bigint;

  constructor(hi: bigint, lo: bigint) {
    this.state = (hi << 64n) | (lo & mask);
  }

  uint64(): bigint {
    this.state = BigInt.asUintN(
      128,
      this.state * ((2549297995355413924n << 64n) | 4865540595714422341n) +
        ((6364136223846793005n << 64n) | 1442695040888963407n),
    );
    let hi = this.state >> 64n,
      lo = this.state & mask;
    hi ^= hi >> 32n;
    hi = (hi * 0xda942042e4dd58b5n) & mask;
    hi ^= hi >> 48n;
    return (hi * (lo | 1n)) & mask;
  }

  // A float in [0, 1) from the low 53 bits.
  float(): number {
    return Number(this.uint64() & ((1n << 53n) - 1n)) / 9007199254740992;
  }

  // An unbiased integer in [0, n). Powers of two are masked, and other values use Lemire's multiply and reject.
  int(n: number): number {
    if (n <= 0) throw new Error('invalid argument to IntN');
    const b = BigInt(n);
    if (!(b & (b - 1n))) return Number(this.uint64() & (b - 1n));
    let product = this.uint64() * b;
    const threshold = ((1n << 64n) - b) % b;
    while ((product & mask) < threshold) product = this.uint64() * b;
    return Number(product >> 64n);
  }

  // The numbers below n in shuffled order, using a Fisher-Yates shuffle from the end.
  perm(n: number): number[] {
    const p = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [p[i], p[j]] = [p[j], p[i]];
    }
    return p;
  }
}

// Something falling down the field. Frozen ice holds a file and takes hp hits to break. The last hit thaws it, and
// the freed file drops fast for the ship to catch. Rot hurts the ship and blocks bullets without breaking.
interface Thing {
  kind: 'frozen' | 'thawed' | 'rot';
  x: number;
  y: number;
  vy: number;
  hp?: number;
  ext?: string;
}

// Short-lived text such as shards and score popups. Sparks fall one row a tick unless hang is set.
export interface Spark {
  x: number;
  y: number;
  text: string;
  ttl: number;
  st: Style;
  hang?: boolean;
}

// Frozen ice is the extension between two ice cells, a thawed file is just the extension, and rot is two cells.
const thingWidth = (t: Thing): number => {
  if (t.kind === 'frozen') return (t.ext?.length ?? 0) + 2;
  if (t.kind === 'thawed') return t.ext?.length ?? 0;
  return 2;
};

// A fixed grid of characters and styles. Each code point takes one cell, and anything drawn off the grid is dropped.
export class Canvas {
  chars: string[];
  styles: Style[];

  constructor(
    public w: number,
    public h: number,
  ) {
    this.chars = Array(w * h).fill(' ');
    this.styles = Array(w * h).fill('base');
  }

  put(x: number, y: number, s: string, st: Style): void {
    if (y < 0 || y >= this.h) return;
    for (const r of s) {
      if (x >= 0 && x < this.w) {
        this.chars[y * this.w + x] = r;
        this.styles[y * this.w + x] = st;
      }
      x++;
    }
  }

  center(y: number, s: string, st: Style): void {
    this.put(Math.trunc((this.w - [...s].length) / 2), y, s, st);
  }

  // Styles each run of same-styled cells once instead of every cell.
  render(): string {
    const out: string[] = [];
    for (let y = 0; y < this.h; y++) {
      let line = '',
        start = 0;
      for (let x = 1; x <= this.w; x++)
        if (x === this.w || this.styles[y * this.w + x] !== this.styles[y * this.w + start]) {
          line += style(this.styles[y * this.w + start], this.chars.slice(y * this.w + start, y * this.w + x).join(''));
          start = x;
        }
      out.push(line);
    }
    return out.join('\n');
  }
}

// File extensions frozen in the ice. Spawning picks from this list by index, so its order is part of a seeded game.
const extensions = ['pdf', 'jpg', 'doc', 'mp3', 'zip', 'txt', 'png', 'mov', 'csv', 'key', 'psd', 'wav'];

// Reads the saved best score and mute setting. A missing or broken file starts fresh.
function loadSaved(file: string): { best: number; muted: boolean } {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return { best: typeof s.best === 'number' ? s.best : 0, muted: !!s.muted };
  } catch {
    return { best: 0, muted: false };
  }
}

let clips: Record<string, Clip> | undefined;

// What the game needs from its sound effects.
export type GameSound = Pick<Player, 'available' | 'play' | 'close'>;

// Opens the game's sound effects. Each game gets its own player, and the browser closes it when the game is left,
// so the audio output isn't held open outside the game. The crack and ding cues reuse the explosion sample with
// different effects.
export function openGameSound(): Player {
  if (!clips) {
    const wav = (name: string) => readFileSync(new URL('../../assets/sfx/' + name + '.wav', import.meta.url));
    const explosion = wav('explosion');
    clips = {
      explosion: { wav: explosion, pitch: 0.05, tempo: 0.04, volume: 0.5 },
      crack: { wav: explosion, pitch: 0.05, tempo: 0.04, volume: 0.3, cut: 150 },
      ding: {
        wav: explosion,
        shift: 2.5,
        ring: 1600,
        crush: 5,
        decay: 35,
        cut: 120,
        volume: 0.35,
        pitch: 0.06,
        tempo: 0.03,
      },
      shoot: { wav: wav('laser-shoot'), pitch: 0.03, tempo: 0.02 },
      hurt: { wav: wav('hit-hurt'), pitch: 0.025, tempo: 0.02 },
      pickup: { wav: wav('pickup-file'), pitch: 0.02, tempo: 0.01 },
      powerup: { wav: wav('power-up'), pitch: 0.01, tempo: 0.01 },
    };
  }
  return new Player(clips);
}

// One game session, from the title screen to game over.
export class Arcade {
  // Field size in cells, capped at 64 by 24.
  w = 0;
  h = 0;

  rng: PCG;
  phase: 'title' | 'playing' | 'paused' | 'over' = 'title';

  // Bumped on every tick, start, resume and game over, so a tick meant for an older state does nothing.
  gen = 0;

  // The ship sits on the bottom row and is three cells wide. lastX is the centre of the last ice block spawned.
  shipX = 0;
  lastX = 0;

  bullets: { x: number; y: number }[] = [];
  things: Thing[] = [];
  sparks: Spark[] = [];

  // Ticks left before the ship can fire again, and before it can be hurt again.
  cooldown = 0;
  invuln = 0;

  ticks = 0;
  score = 0;
  lives = 0;
  combo = 0;
  rescued = 0;
  level = 0;

  // Weapon power from 0 to 3. Every 8 files caught raises it by one, and losing a life takes one away.
  power = 0;
  charge = 0;

  // Difficulty starts at 1 and rises by 1 every 3000 ticks.
  diff = 0;

  // best and muted are saved between games.
  best = 0;
  newBest = false;
  muted = false;

  snd?: GameSound;

  // Tests listen here for sound cues.
  heard?: (name: string) => void;

  constructor(
    public bestPath = '',
    seed = BigInt(Date.now()) * 1000000n,
  ) {
    this.rng = new PCG(seed, seed ^ 0x9e3779b97f4a7c15n);
    const saved = loadSaved(bestPath);
    this.best = saved.best;
    this.muted = saved.muted;
  }

  play(name: string): void {
    if (!this.muted) {
      this.heard?.(name);
      this.snd?.play(name);
    }
  }

  // Saves the best score and mute setting. Failing to save never interrupts the game.
  save(): void {
    if (!this.bestPath) return;
    try {
      const root = openRootSync(path.dirname(this.bestPath), { create: true, mode: 0o700 });
      const temporary = '.frost-' + randomUUID();
      try {
        const file = root.open(temporary, { write: true, create: true, exclusive: true, mode: 0o600 });
        try {
          file.writeFile(JSON.stringify({ best: this.best, ...(this.muted ? { muted: true } : {}) }));
          file.sync();
        } finally {
          file.close();
        }
        root.rename(temporary, root, path.basename(this.bestPath));
        if (process.platform !== 'win32') root.sync();
      } finally {
        try {
          root.remove(temporary);
        } catch {}
        root.close();
      }
    } catch {}
  }

  resize(w: number, h: number): void {
    this.w = Math.max(0, Math.min(w, 64));
    this.h = Math.max(0, Math.min(h, 24));
    this.shipX = Math.max(0, Math.min(this.shipX, this.w - 3));
  }

  tooSmall(): boolean {
    return this.w < 30 || this.h < 12;
  }

  // Resets the field for a new game and returns the new generation.
  start(): number {
    this.phase = 'playing';
    this.bullets = [];
    this.things = [];
    this.sparks = [];
    this.ticks = this.score = this.combo = this.rescued = this.cooldown = this.invuln = this.power = this.charge = 0;
    this.lives = 3;
    this.level = this.diff = 1;
    this.newBest = false;
    this.shipX = Math.trunc(this.w / 2) - 1;
    this.lastX = Math.trunc(this.w / 2);
    return ++this.gen;
  }

  // Handles a key and returns true when the player leaves the game.
  key(k: string): boolean {
    if (k === 'm') {
      this.muted = !this.muted;
      this.save();
      return false;
    }
    if (k === 'esc') {
      if (this.phase === 'playing' || this.phase === 'paused') this.gameOver();
      return true;
    }
    if (this.tooSmall()) return false;

    if ((this.phase === 'title' || this.phase === 'over') && (k === ' ' || k === 'enter')) this.start();
    else if (this.phase === 'paused' && (k === 'p' || k === ' ')) {
      this.phase = 'playing';
      this.gen++;
    } else if (this.phase === 'playing') {
      if (['left', 'a', 'h'].includes(k)) this.shipX = Math.max(0, this.shipX - 2);
      else if (['right', 'd', 'l'].includes(k)) this.shipX = Math.min(this.w - 3, this.shipX + 2);
      else if ([' ', 'up', 'w', 'k'].includes(k)) this.fire();
      else if (k === 'p') this.phase = 'paused';
    }
    return false;
  }

  // Power 1 fires faster, power 2 allows more bullets on screen and power 3 fires two at once.
  fire(): void {
    const limit = this.power >= 2 ? 6 : 4;
    const cooldown = this.power >= 1 ? 2 : 3;
    if (this.cooldown > 0 || this.bullets.length >= limit) return;
    if (this.power >= 3) this.bullets.push({ x: this.shipX, y: this.h - 2 }, { x: this.shipX + 2, y: this.h - 2 });
    else this.bullets.push({ x: this.shipX + 1, y: this.h - 2 });
    this.cooldown = cooldown;
    this.play('shoot');
  }

  // Extra pressure on top of the base difficulty, so a powered-up ship faces more and tougher ice.
  threat(): number {
    return this.diff - 1 + 0.15 * this.power;
  }

  // Advances one frame. Returns true while the game keeps running, and false for stale ticks or when it ends.
  tick(gen = this.gen, owner: Arcade = this): boolean {
    if (owner !== this || gen !== this.gen || this.phase !== 'playing') return false;
    if (this.tooSmall()) {
      this.gen++;
      return true;
    }

    this.ticks++;
    this.diff = 1 + this.ticks / 3000;
    this.level = Math.trunc(this.diff);
    if (this.cooldown > 0) this.cooldown--;
    if (this.invuln > 0) this.invuln--;
    this.spawn();

    // Check hits after the bullets move and again after the ice moves, so they can't pass through each other.
    for (const b of this.bullets) b.y--;
    this.hitBullets();
    for (const t of this.things) t.y += t.vy;
    this.hitBullets();
    this.bottom();

    this.sparks = this.sparks.filter(s => {
      s.ttl--;
      if (s.ttl <= 0) return false;
      if (!s.hang) s.y++;
      return true;
    });

    if (this.lives <= 0) {
      this.gameOver();
      return false;
    }
    this.gen++;
    return true;
  }

  // Width of the window, centred on the last spawn, where the next ice block can land. It starts at 16 cells and
  // widens to the whole field as difficulty rises.
  spread(): number {
    return Math.min(this.w, 16 + Math.trunc(((this.diff - 1) * (this.w - 16)) / 4));
  }

  // Maybe drops a new ice block near the last one, with tougher and faster ice as the threat grows.
  spawn(): void {
    const lvl = 1 + this.threat();
    if (this.rng.float() >= 0.024 + 0.0065 * lvl) return;
    const f: Thing = {
      kind: 'frozen',
      ext: extensions[this.rng.int(extensions.length)],
      x: 0,
      y: 0,
      vy: 0.048 + 0.011 * lvl + this.rng.float() * 0.028,
      hp: 1 + this.rng.int(Math.min(3, 1 + Math.trunc(Math.trunc(lvl) / 2))),
    };
    const span = this.spread();
    const lo = Math.max(0, Math.min(this.lastX - Math.trunc(span / 2), this.w - thingWidth(f) - span));
    f.x = Math.min(lo + this.rng.int(Math.max(1, span)), this.w - thingWidth(f));
    if (this.crowded(f)) return;
    this.lastX = f.x + Math.trunc(thingWidth(f) / 2);
    this.things.push(f);
    this.spawnCluster(f);
  }

  // Surrounds a new ice block with up to three pieces of rot, to its left, to its right or just below it.
  spawnCluster(f: Thing): void {
    const lvl = 1 + this.threat();
    let shards = 0;
    for (let i = 0; i < Math.min(3, Math.trunc(lvl)); i++) if (this.rng.float() < 0.3 + 0.09 * lvl) shards++;
    for (const spot of this.rng.perm(3).slice(0, shards)) {
      const gap = 1 + this.rng.int(3);
      const drift = 0.9 + this.rng.float() * 0.2;
      const r: Thing = { kind: 'rot', x: 0, y: f.y, vy: f.vy * drift };
      if (spot === 0) r.x = f.x - thingWidth(r) - gap;
      else if (spot === 1) r.x = f.x + thingWidth(f) + gap;
      else {
        r.x = f.x + this.rng.int(Math.max(1, thingWidth(f) - thingWidth(r) + 1));
        r.y = f.y + 1 + gap * 0.75;
      }
      if (r.x >= 0 && r.x + thingWidth(r) <= this.w) this.things.push(r);
    }
  }

  // True when something near the top would touch t or sit right beside it.
  crowded(t: Thing): boolean {
    return this.things.some(o => o.y < 2 && t.x < o.x + thingWidth(o) + 1 && o.x < t.x + thingWidth(t) + 1);
  }

  // Removes bullets that leave the field or hit something. Rot absorbs bullets, and ice loses a layer per hit and
  // thaws when the last one breaks. Thawed files let bullets through.
  hitBullets(): void {
    this.bullets = this.bullets.filter(b => {
      if (b.y < 0) return false;
      for (const t of this.things) {
        if (Math.trunc(t.y) !== b.y || b.x < t.x || b.x >= t.x + thingWidth(t) || t.kind === 'thawed') continue;
        if (t.kind === 'rot') {
          this.play('ding');
          this.sparks.push({ x: b.x, y: b.y, text: 'x', ttl: 3, st: 'dim' });
        } else {
          t.hp = (t.hp ?? 1) - 1;
          this.score += 10;
          this.shatter(t.x, Math.trunc(t.y), thingWidth(t));
          if (t.hp > 0) this.play('crack');
          else {
            this.play('explosion');
            t.kind = 'thawed';
            t.x++;
            t.vy = 0.45;
            this.score += 25;
          }
        }
        return false;
      }
      return true;
    });
  }

  shatter(x: number, y: number, w: number): void {
    for (let i = 0; i < 3; i++)
      this.sparks.push({
        x: x + this.rng.int(Math.max(w, 1)),
        y,
        ttl: 3 + this.rng.int(3),
        text: "*'.,"[this.rng.int(4)],
        st: 'dim',
      });
  }

  // Settles everything that reaches the ship's row. Catching a file scores more with each catch in a row. Rot on
  // the ship and ice falling past it cost a life, and a missed file ends the combo.
  bottom(): void {
    const row = this.h - 1;
    this.things = this.things.filter(t => {
      const overlap = t.x < this.shipX + 3 && this.shipX < t.x + thingWidth(t);
      const y = Math.trunc(t.y);

      if (y >= row && t.kind === 'thawed' && overlap) {
        this.combo++;
        const gain = 50 * this.combo;
        this.score += gain;
        this.rescued++;
        this.sparks.push({
          x: Math.max(0, this.shipX - 1),
          y: row - 2,
          text: '+' + gain,
          ttl: 12,
          st: 'warnBold',
          hang: true,
        });
        let powered = false;
        if (this.power < 3 && ++this.charge >= 8) {
          this.power++;
          this.charge = 0;
          powered = true;
          this.sparks.push({
            x: Math.max(0, Math.trunc(this.w / 2) - 4),
            y: Math.trunc(this.h / 2),
            text: 'POWER UP',
            ttl: 24,
            st: 'warnBold',
            hang: true,
          });
        }
        this.play(powered ? 'powerup' : 'pickup');
        return false;
      }

      if (y >= row && t.kind === 'rot' && overlap) {
        this.loseLife();
        return false;
      }

      if (y >= row + 1 && t.kind === 'frozen') {
        this.loseLife();
        this.sparks.push({ x: t.x, y: row - 1, text: 'lost .' + t.ext, ttl: 14, st: 'warnBold', hang: true });
        return false;
      }

      if (y >= row + 1) {
        if (t.kind === 'thawed') {
          this.combo = 0;
          this.sparks.push({ x: t.x, y: row - 1, text: 'missed .' + t.ext, ttl: 12, st: 'dim', hang: true });
        }
        return false;
      }
      return true;
    });
  }

  // Costs a life, a power level and the combo, then leaves the ship briefly invulnerable. Hits during that time are
  // ignored.
  loseLife(): void {
    if (this.invuln > 0) return;
    this.lives--;
    this.play('hurt');
    this.combo = 0;
    this.power = Math.max(0, this.power - 1);
    this.charge = 0;
    this.invuln = 27;
    this.shatter(this.shipX, this.h - 1, 3);
  }

  gameOver(): void {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.gen++;
    if (this.score > this.best) {
      this.best = this.score;
      this.newBest = true;
      this.save();
    }
  }

  // Drawing

  // The status line above the field. joinFit drops items from the end when the field is narrow.
  hud(): string {
    if (this.phase === 'title') return style('dim', 'BEST ') + style('text', String(this.best).padStart(6, '0'));
    const parts = [
      style('dim', 'SCORE ') + style('bold', String(this.score).padStart(6, '0')),
      style('dim', 'LIVES ') + style('bold', 'A '.repeat(Math.max(this.lives, 0)).trim()),
      style('dim', 'PWR ') + style('bold', '■'.repeat(this.power)) + style('faded', '□'.repeat(3 - this.power)),
    ];
    if (this.combo > 1) parts.push(style('warnBold', 'COMBO x' + this.combo));
    parts.push(
      style('dim', 'LVL ') + style('text', String(this.level)),
      style('dim', 'BEST ') + style('text', String(Math.max(this.best, this.score)).padStart(6, '0')),
    );
    return joinFit(parts, this.w);
  }

  // The status line over a boxed field.
  view(): string {
    if (this.tooSmall()) return style('text', 'Make the window bigger to play (at least 36x22).');
    const c = new Canvas(this.w, this.h);
    if (this.phase === 'title') this.drawTitle(c);
    else if (this.phase === 'over') this.drawOver(c);
    else {
      this.drawField(c);
      if (this.phase === 'paused') {
        c.center(Math.trunc(this.h / 2) - 1, '  PAUSED  ', 'bold');
        c.center(Math.trunc(this.h / 2) + 1, '[p] resume   [esc] leave', 'dim');
      }
    }
    const b = box(c.render(), true, { padX: 0 });
    return stack(pad(this.hud(), width(b)), b);
  }

  // Ice gets denser shading with more hits left. The ship blinks while it's invulnerable.
  drawField(c: Canvas): void {
    for (const t of this.things) {
      const y = Math.trunc(t.y);
      if (t.kind === 'frozen') {
        const ice = ['░', '▒', '▓'][(t.hp ?? 1) - 1];
        const st: Style = ['faded', 'dim', 'text'][(t.hp ?? 1) - 1] as Style;
        c.put(t.x, y, ice, st);
        c.put(t.x + 1, y, t.ext ?? '', 'dim');
        c.put(t.x + 1 + (t.ext?.length ?? 0), y, ice, st);
      } else if (t.kind === 'thawed') c.put(t.x, y, t.ext ?? '', 'goodBold');
      else c.put(t.x, y, '▚▞', 'error');
    }
    for (const b of this.bullets) c.put(b.x, b.y, '|', 'bold');
    for (const s of this.sparks) c.put(s.x, s.y, s.text, s.st);
    if (!this.invuln || this.invuln % 4 < 2) c.put(this.shipX, this.h - 1, '/A\\', 'bold');
  }

  // The wordmark falls back to spaced-out text when the field is too small for it.
  drawTitle(c: Canvas): void {
    let mark = wordmark(true).split('\n');
    const markW = Math.max(...mark.map(l => [...l].length));
    if (markW + 4 > c.w || mark.length + 8 > c.h) mark = ['I C E B R E A K E R'];
    const desc = wrapPlain('Shoot the ice, catch your files, dodge the bit rot.', c.w - 6);
    let y = Math.max(1, Math.trunc((c.h - mark.length - desc.length - 6) / 2));
    const left = Math.trunc((c.w - markW) / 2);
    for (const l of mark) {
      if (mark.length === 1) c.center(y, l, 'bold');
      else c.put(left, y, l, 'bold');
      y++;
    }
    y++;
    for (const l of desc) c.center(y++, l, 'dim');
    c.center(y + 1, 'press [space] to start', 'bold');
    if (this.best > 0) c.center(y + 3, 'personal best ' + this.best, 'faded');
  }

  drawOver(c: Canvas): void {
    const y = Math.max(1, Math.trunc(this.h / 2) - 5);
    c.center(y, 'G A M E   O V E R', 'error');
    c.center(y + 2, 'score  ' + this.score, 'bold');
    c.center(
      y + 3,
      this.newBest ? 'NEW PERSONAL BEST!' : 'personal best  ' + this.best,
      this.newBest ? 'warnBold' : 'text',
    );
    c.center(y + 5, 'files rescued ' + this.rescued + '   level ' + this.level, 'dim');
    c.center(y + 7, '[enter] play again   [esc] back', 'faded');
  }
}
