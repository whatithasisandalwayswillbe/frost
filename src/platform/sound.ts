// Sound effects for the hidden game. Clips are decoded and shaped once, then rendered into a few variants with
// slightly different pitch and tempo, so a play does no audio work. On macOS a helper process keeps one audio engine
// running and plays the variants from memory. On Windows and Linux Frost mixes the variants itself and streams them to
// winmm's waveOut or to libpulse. When the output can't start, the game stays silent. FROST_NO_SOUND turns it all off.
import { spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { loadFFI, type FFIType, type FFIValue } from './ffi-loader.js';

export const sampleRate = 44100;

// A WAV clip and how to shape it. pitch and tempo are random jitter amounts, cut and decay are
// milliseconds, shift is a resampling factor, ring is a frequency in Hz and crush a bit depth.
export interface Clip {
  wav: Buffer;
  pitch?: number;
  tempo?: number;
  volume?: number;
  cut?: number;
  shift?: number;
  ring?: number;
  crush?: number;
  decay?: number;
}

// Time stretching overlaps 1024-sample Hann-windowed grains every 512 samples, searching up to
// 256 samples either way for the best fit.
const grain = 1024;
const hop = 512;
const tolerance = 256;
const window = Float32Array.from({ length: grain }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / grain));

// A random factor between 1 - amount and 1 + amount, most likely near 1.
function jitter(amount = 0, random = Math.random): number {
  return 1 + amount * (random() - random());
}

// Linear interpolation. A step above 1 shortens the clip and raises its pitch. Math.fround keeps
// the arithmetic in 32-bit floats.
export function resample(s: Float32Array, step: number): Float32Array {
  if (!s.length || step <= 0) return s;
  if (Math.abs(step - 1) < 1e-6) return s.slice();
  const out = new Float32Array(Math.trunc(s.length / step));
  for (let i = 0; i < out.length; i++) {
    const pos = i * step;
    const j = Math.trunc(pos);
    const frac = Math.fround(pos - j);
    out[i] =
      j + 1 >= s.length ? s[s.length - 1] : Math.fround(s[j] * Math.fround(1 - frac)) + Math.fround(s[j + 1] * frac);
  }
  return out;
}

// Finds the input offset near nominal whose start best matches the audio that naturally follows
// the previous grain. The correlation uses every second sample.
function bestMatch(s: Float32Array, natural: number, nominal: number, last: number): number {
  if (natural + hop > s.length) return nominal;
  let best = nominal;
  let bestScore = -Infinity;
  for (let c = Math.max(0, nominal - tolerance); c <= Math.min(last, nominal + tolerance); c++) {
    let score = 0;
    for (let j = 0; j < hop; j += 2) score += Math.fround(s[c + j] * s[natural + j]);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

// Changes the length by factor without changing pitch, using waveform-similarity overlap-add.
// Clips too short for that come back unchanged.
function stretch(s: Float32Array, factor: number): Float32Array {
  if (factor <= 0 || Math.abs(factor - 1) < 1e-3 || s.length < 2 * grain + tolerance) return s;
  const n = Math.trunc(s.length * factor);
  const out = new Float32Array(n + grain);
  const weight = new Float32Array(n + grain);
  const last = s.length - grain;
  let prev = 0;
  for (let o = 0; o < n; o += hop) {
    let input = Math.min(Math.trunc(o / factor), last);
    if (o > 0) input = bestMatch(s, prev + hop, input, last);
    for (let j = 0; j < grain; j++) {
      out[o + j] += Math.fround(s[input + j] * window[j]);
      weight[o + j] += window[j];
    }
    prev = input;
  }
  for (let i = 0; i < n; i++) if (weight[i] > 1e-3) out[i] /= weight[i];
  return out.subarray(0, n);
}

// Raises pitch by the pitch factor and speeds playback by the tempo factor.
export function vary(s: Float32Array, pitch: number, tempo: number): Float32Array {
  return pitch <= 0 || tempo <= 0 ? s : resample(stretch(s, pitch / tempo), pitch);
}

// Shortens a clip to the given length with a 20 ms linear fade-out.
export function cut(s: Float32Array, milliseconds = 0): Float32Array {
  const n = Math.trunc((milliseconds / 1000) * sampleRate);
  if (milliseconds <= 0 || n >= s.length) return s;
  const out = s.slice(0, n);
  const fade = Math.min(n, Math.trunc(0.02 * sampleRate));
  for (let i = 0; i < fade; i++) out[n - fade + i] *= (fade - i) / fade;
  return out;
}

// Applies a clip's pitch shift, ring modulation, bit crushing and exponential decay, in that order.
export function effects(s: Float32Array, clip: Clip): Float32Array {
  const out = clip.shift && clip.shift > 0 && clip.shift !== 1 ? resample(s, clip.shift) : s.slice();
  for (let i = 0; i < out.length; i++) {
    if (clip.ring && clip.ring > 0) out[i] *= Math.fround(1.5 * Math.sin((2 * Math.PI * clip.ring * i) / sampleRate));
    if (clip.crush && clip.crush > 0 && clip.crush < 16) {
      const levels = 1 << (clip.crush - 1);
      out[i] = (Math.sign(out[i]) * Math.floor(Math.abs(out[i] * levels) + 0.5)) / levels;
    }
    if (clip.decay && clip.decay > 0) out[i] *= Math.fround(Math.exp(-i / ((clip.decay / 1000) * sampleRate)));
  }
  return out;
}

// Decodes 8 or 16-bit PCM WAV to mono samples at sampleRate. Chunks are walked by size, with
// the pad byte after odd-sized chunks, and anything other than fmt and data is skipped.
export function decodeWAV(b: Buffer): Float32Array {
  if (b.length < 12 || b.subarray(0, 4).toString() !== 'RIFF' || b.subarray(8, 12).toString() !== 'WAVE')
    throw new Error('not a WAV file');
  let channels = 0;
  let bits = 0;
  let rate = 0;
  let data: Buffer | undefined;
  let haveFmt = false;

  for (let off = 12; b.length - off >= 8;) {
    const id = b.subarray(off, off + 4).toString();
    const size = b.readUInt32LE(off + 4);
    if (size > b.length - off - 8) throw new Error('truncated WAV chunk');
    const body = b.subarray(off + 8, off + 8 + size);
    // The fmt chunk holds the format tag at 0 (1 is PCM), channels at 2, sample rate at 4 and
    // bits per sample at 14.
    if (id === 'fmt ') {
      if (body.length < 16) throw new Error('short fmt chunk');
      if (body.readUInt16LE(0) !== 1) throw new Error(`unsupported WAV encoding ${body.readUInt16LE(0)} (want PCM)`);
      channels = body.readUInt16LE(2);
      rate = body.readUInt32LE(4);
      bits = body.readUInt16LE(14);
      haveFmt = true;
    } else if (id === 'data') data = body;
    off += 8 + size;
    if (size % 2 && off < b.length) off++;
  }

  if (!haveFmt || !data) throw new Error('missing fmt or data chunk');
  if (channels < 1 || rate < 1 || ![8, 16].includes(bits))
    throw new Error(`unsupported WAV: ${channels} channels, ${rate} Hz, ${bits} bit`);
  const frame = (channels * bits) / 8;
  if (data.length % frame) throw new Error('incomplete WAV frame');

  // Average the channels. 8-bit PCM is unsigned around 128, 16-bit is signed.
  const mono = new Float32Array(data.length / frame);
  for (let i = 0; i < mono.length; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const off = i * frame + (c * bits) / 8;
      sum = Math.fround(sum + (bits === 8 ? (data[off] - 128) / 128 : data.readInt16LE(off) / 32768));
    }
    mono[i] = sum / channels;
  }
  return rate === sampleRate ? mono : resample(mono, rate / sampleRate);
}

// Clips play at 0.36 of full scale times their volume. Each clip with jitter gets four variants, and at most eight
// sounds play at once, four of them the same clip.
const level = 0.36;
const variantCount = 4;
const voiceCount = 8;
const clipLimit = 4;

// Streams are written in 10 ms blocks and kept 50 ms ahead of playback. A stream runs from the moment its output
// opens until it closes, with silence between sounds, so the output never starts up again under a new sound.
// waveOut drops audio once 20 ms or less is left, which happens when a timer or the event loop runs late, so each
// check that finds that little raises its lead by a block, up to 150 ms.
const blockMs = 10;
const blockFrames = (sampleRate * blockMs) / 1000;
const leadMs = 50;
const lowMs = 20;
const maxLeadMs = 150;

// A variant being mixed, and how many of its samples have played.
interface Voice {
  name: string;
  samples: Float32Array;
  at: number;
}

// Mixes playing variants into 16-bit little-endian blocks for the streams.
export class Mixer {
  private voices: Voice[] = [];
  private fade?: Voice;

  get active(): boolean {
    return this.voices.length > 0 || !!this.fade;
  }

  // Starts a variant, unless its clip is already playing four times. With every voice busy, the voice nearest its
  // end fades out over 3 ms instead of stopping with a click.
  add(name: string, samples: Float32Array): boolean {
    if (this.voices.filter(v => v.name === name).length >= clipLimit) return false;
    if (this.voices.length >= voiceCount) {
      const left = (v: Voice) => v.samples.length - v.at;
      const v = this.voices.reduce((a, b) => (left(b) < left(a) ? b : a));
      const fade = v.samples.slice(v.at, v.at + Math.trunc(0.003 * sampleRate));
      for (let i = 0; i < fade.length; i++) fade[i] *= 1 - i / fade.length;
      // Combine remaining tails into one short buffer, keeping both live voices and mixing work
      // bounded even when many sounds start before the next output block.
      const tail = this.fade;
      const combined = new Float32Array(Math.max(fade.length, tail ? tail.samples.length - tail.at : 0));
      combined.set(fade);
      if (tail) for (let i = tail.at; i < tail.samples.length; i++) combined[i - tail.at] += tail.samples[i];
      this.fade = { name: '', samples: combined, at: 0 };
      this.voices.splice(this.voices.indexOf(v), 1);
    }
    this.voices.push({ name, samples, at: 0 });
    return true;
  }

  // Sums the next frames of every voice, clipped to full scale, and drops the voices that finish.
  block(frames: number): Buffer {
    const out = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (const v of this.voices) if (v.at + i < v.samples.length) sum += v.samples[v.at + i];
      if (this.fade && this.fade.at + i < this.fade.samples.length) sum += this.fade.samples[this.fade.at + i];
      out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sum)) * 32767), i * 2);
    }
    for (const v of this.voices) v.at += frames;
    this.voices = this.voices.filter(v => v.at < v.samples.length);
    if (this.fade) {
      this.fade.at += frames;
      if (this.fade.at >= this.fade.samples.length) this.fade = undefined;
    }
    return out;
  }
}

// A long-running raw output. room() is how many milliseconds it wants written now.
export interface Stream {
  room(): number;
  write(block: Buffer): void;
  close(): Promise<void>;
}

// Ends a child's input so it can stop by itself, and kills it if it's still running a second later.
async function endProcess(child: HelperProcess, exited: Promise<void>): Promise<void> {
  child.stdin.end();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>(resolve => (timer = setTimeout(() => resolve(true), 1000)));
  if (await Promise.race([exited.then(() => false), late])) child.kill();
  clearTimeout(timer);
}

// The macOS helper, run with osascript. It reads one JSON array per line. ['load', id, base64] keeps a variant's
// 32-bit float samples as buffer id. ['play', voice, id, steal] schedules that buffer on a voice, stopping the voice
// first when steal is 1. It prints 'ready' once its engine runs, or 'error' and a reason, and stops at end of input.
// A new output device stops the engine, so a play rebuilds it. Completion handlers are left nil through
// performSelector, because JavaScript can't run on the audio thread. The input node is never touched, so the
// microphone stays off.
const helperScript = `
ObjC.import('AVFoundation');
const output = $.NSFileHandle.fileHandleWithStandardOutput;
const say = text => output.writeData($(text + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
const format = $.AVAudioFormat.alloc.initStandardFormatWithSampleRateChannels(${sampleRate}, 1);
const buffers = [];
let engine;
let voices = [];

function start() {
  engine = $.AVAudioEngine.alloc.init;
  voices = [];
  for (let i = 0; i < ${voiceCount}; i++) {
    const voice = $.AVAudioPlayerNode.alloc.init;
    engine.attachNode(voice);
    engine.connectToFormat(voice, engine.mainMixerNode, format);
    voices.push(voice);
  }
  if (engine.startAndReturnError(null) !== true) return false;
  for (const voice of voices) voice.play;
  return true;
}

function handle(line) {
  const [command, a, b, c] = JSON.parse(line);
  if (command === 'load') {
    const bytes = $.NSData.alloc.initWithBase64EncodedStringOptions(b, 0);
    const frames = Number(bytes.length) / 4;
    if (frames < 1) return;
    const buffer = $.AVAudioPCMBuffer.alloc.initWithPCMFormatFrameCapacity(format, frames);
    buffer.frameLength = frames;
    bytes.getBytesLength(buffer.floatChannelData[0], frames * 4);
    buffers[a] = buffer;
  } else if (command === 'play' && buffers[b] && voices[a]) {
    if (engine.running !== true && !start()) return say('error the audio output stopped');
    const voice = voices[a];
    if (c) voice.stop;
    voice.performSelectorWithObjectWithObject('scheduleBuffer:completionHandler:', buffers[b], $());
    if (c) voice.play;
  }
}

if (!start()) say('error the audio output did not start');
else {
  say('ready');
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  let pending = '';
  for (;;) {
    const data = input.availableData;
    if (Number(data.length) === 0) break;
    pending += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
    for (let end = pending.indexOf('\\n'); end >= 0; end = pending.indexOf('\\n')) {
      try {
        handle(pending.slice(0, end));
      } catch (e) {
        say('error ' + String(e).replace(/\\s+/g, ' '));
      }
      pending = pending.slice(end + 1);
    }
  }
  engine.stop;
}
`;

// The parts of a child process the macOS helper needs. Tests pass a fake.
export interface HelperProcess {
  stdin: Writable;
  stdout: Readable;
  kill(): boolean;
  on(event: 'exit', listener: () => void): unknown;
  on(event: 'error', listener: (e: Error) => void): unknown;
}

const spawnHelper = (program: string, args: string[]): HelperProcess =>
  spawn(program, args, { stdio: ['pipe', 'pipe', 'ignore'] });

// The winmm calls the Windows output makes, and the raw address of a buffer. Tests pass a fake.
export interface WinMM {
  waveOutOpen(handle: Buffer, device: number, format: Buffer, callback: null, instance: null, flags: number): number;
  waveOutPrepareHeader(wave: bigint, header: Buffer, size: number): number;
  waveOutUnprepareHeader(wave: bigint, header: Buffer, size: number): number;
  waveOutWrite(wave: bigint, header: Buffer, size: number): number;
  waveOutReset(wave: bigint): number;
  waveOutClose(wave: bigint): number;
  timeBeginPeriod(ms: number): number;
  timeEndPeriod(ms: number): number;
  pointer(buffer: Buffer): bigint;
}

// Binds winmm once. Every call returns an MMRESULT, where 0 is success. The struct offsets assume a 64-bit ABI.
let winmm: WinMM | undefined;
function bindWinMM(): WinMM {
  if (winmm) return winmm;
  if (!['x64', 'arm64'].includes(process.arch)) throw new Error('unsupported Windows audio ABI');
  const ffi = loadFFI();
  const def = (...args: FFIType[]) => ({ return: 'uint32' as const, arguments: args });
  const f = ffi.dlopen('winmm.dll', {
    waveOutOpen: def('pointer', 'uint32', 'pointer', 'pointer', 'pointer', 'uint32'),
    waveOutPrepareHeader: def('pointer', 'pointer', 'uint32'),
    waveOutUnprepareHeader: def('pointer', 'pointer', 'uint32'),
    waveOutWrite: def('pointer', 'pointer', 'uint32'),
    waveOutReset: def('pointer'),
    waveOutClose: def('pointer'),
    timeBeginPeriod: def('uint32'),
    timeEndPeriod: def('uint32'),
  }).functions;
  const calls = Object.entries(f).map(([name, call]) => [name, (...args: FFIValue[]) => Number(call(...args))]);
  return (winmm = { ...Object.fromEntries(calls), pointer: (b: Buffer) => ffi.getRawPointer(b) } as WinMM);
}

function check(result: number, call: string): void {
  if (result) throw new Error(`${call} failed with error ${result}`);
}

// Opens the default waveOut device for 44.1 kHz 16-bit mono. JavaScript can't run on the audio thread, so the device
// opens without a callback, and played blocks are found by polling their WHDR_DONE flag. A ring of blocks for the
// longest lead is allocated and prepared once, in ArrayBuffers outside the JavaScript heap, so their addresses never
// move while winmm holds them. Windows timers tick every 15.6 ms unless a process asks for finer ones, so the output
// asks for 1 ms ticks while it's open, which keeps the pump and the game's frames on time.
export function openWaveOut(api: WinMM = bindWinMM()): Stream {
  // WAVEFORMATEX is the format tag (1 is PCM), channels, sample rate, bytes per second, block align and bits, then a
  // zero cbSize, in 18 bytes. WAVE_MAPPER (0xffffffff) picks the default device and CALLBACK_NULL (0) asks for no
  // callback. WAVEHDR is 48 bytes, with lpData at 0, dwBufferLength at 8 and dwFlags at 24, where WHDR_DONE is 1.
  const fixed = (size: number) => Buffer.from(new ArrayBuffer(size));
  const format = fixed(18);
  format.writeUInt16LE(1, 0);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(sampleRate, 4);
  format.writeUInt32LE(sampleRate * 2, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);
  const out = fixed(8);
  check(api.waveOutOpen(out, 0xffffffff, format, null, null, 0), 'waveOutOpen');
  const wave = out.readBigUInt64LE();
  const ring: { header: Buffer; data: Buffer; busy: boolean }[] = [];
  const finer = !api.timeBeginPeriod(1);

  // Reset hands every queued block back, so each can be unprepared before the device closes.
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    api.waveOutReset(wave);
    for (const block of ring) api.waveOutUnprepareHeader(wave, block.header, 48);
    api.waveOutClose(wave);
    if (finer) api.timeEndPeriod(1);
    ring.length = 0;
  };
  try {
    for (let i = 0; i < maxLeadMs / blockMs; i++) {
      const header = fixed(48);
      const data = fixed(blockFrames * 2);
      header.writeBigUInt64LE(api.pointer(data), 0);
      header.writeUInt32LE(data.length, 8);
      check(api.waveOutPrepareHeader(wave, header, 48), 'waveOutPrepareHeader');
      ring.push({ header, data, busy: false });
    }
  } catch (e) {
    close();
    throw e;
  }

  let lead = leadMs;
  let started = false;
  return {
    room() {
      let queued = 0;
      for (const block of ring) {
        if (block.busy && block.header.readUInt32LE(24) & 1) block.busy = false;
        if (block.busy) queued += blockMs;
      }
      if (started && queued <= lowMs) lead = Math.min(lead + blockMs, maxLeadMs);
      started = true;
      return lead - queued;
    },
    // Copies a block into a free slot and queues it, clearing WHDR_DONE from the slot's last use.
    write(block) {
      const slot = ring.find(b => !b.busy);
      if (closed || !slot) throw new Error('the audio output is closed or full');
      block.copy(slot.data);
      slot.header.writeUInt32LE(slot.header.readUInt32LE(24) & ~1, 24);
      check(api.waveOutWrite(wave, slot.header, 48), 'waveOutWrite');
      slot.busy = true;
    },
    close: async () => close(),
  };
}

// The libpulse calls the Linux output makes, with their C signatures. Pointers are bigints, and 0n is NULL. Tests pass
// a fake.
export interface PulseAPI {
  pa_threaded_mainloop_new(): bigint;
  pa_threaded_mainloop_get_api(loop: bigint): bigint;
  pa_threaded_mainloop_start(loop: bigint): number;
  pa_threaded_mainloop_lock(loop: bigint): void;
  pa_threaded_mainloop_unlock(loop: bigint): void;
  pa_threaded_mainloop_stop(loop: bigint): void;
  pa_threaded_mainloop_free(loop: bigint): void;
  pa_context_new(api: bigint, name: string): bigint;
  pa_context_connect(context: bigint, server: null, flags: number, api: null): number;
  pa_context_get_state(context: bigint): number;
  pa_context_disconnect(context: bigint): void;
  pa_context_unref(context: bigint): void;
  pa_stream_new(context: bigint, name: string, spec: Buffer, map: null): bigint;
  pa_stream_connect_playback(s: bigint, dev: null, attr: Buffer, flags: number, volume: null, sync: null): number;
  pa_stream_get_state(stream: bigint): number;
  pa_stream_writable_size(stream: bigint): bigint;
  pa_stream_write(stream: bigint, data: Buffer, bytes: bigint, free: null, offset: bigint, seek: number): number;
  pa_stream_unref(stream: bigint): void;
}

// Binds libpulse once. Each entry is the return type, then the argument types.
let libpulse: PulseAPI | undefined;
function bindPulse(): PulseAPI {
  if (libpulse) return libpulse;
  const signatures: Record<keyof PulseAPI, FFIType[]> = {
    pa_threaded_mainloop_new: ['pointer'],
    pa_threaded_mainloop_get_api: ['pointer', 'pointer'],
    pa_threaded_mainloop_start: ['int32', 'pointer'],
    pa_threaded_mainloop_lock: ['void', 'pointer'],
    pa_threaded_mainloop_unlock: ['void', 'pointer'],
    pa_threaded_mainloop_stop: ['void', 'pointer'],
    pa_threaded_mainloop_free: ['void', 'pointer'],
    pa_context_new: ['pointer', 'pointer', 'string'],
    pa_context_connect: ['int32', 'pointer', 'pointer', 'uint32', 'pointer'],
    pa_context_get_state: ['int32', 'pointer'],
    pa_context_disconnect: ['void', 'pointer'],
    pa_context_unref: ['void', 'pointer'],
    pa_stream_new: ['pointer', 'pointer', 'string', 'pointer', 'pointer'],
    pa_stream_connect_playback: ['int32', 'pointer', 'pointer', 'pointer', 'uint32', 'pointer', 'pointer'],
    pa_stream_get_state: ['int32', 'pointer'],
    pa_stream_writable_size: ['uint64', 'pointer'],
    pa_stream_write: ['int32', 'pointer', 'pointer', 'uint64', 'pointer', 'int64', 'int32'],
    pa_stream_unref: ['void', 'pointer'],
  };
  const functions = Object.entries(signatures).map(([name, [result, ...args]]) => [
    name,
    { return: result, arguments: args },
  ]);
  return (libpulse = loadFFI().dlopen('libpulse.so.0', Object.fromEntries(functions)).functions as unknown as PulseAPI);
}

// Opens a stream through libpulse, the client library for PulseAudio and for PipeWire's PulseAudio server. JavaScript
// can't run on libpulse's threads, so nothing registers a callback. A threaded main loop runs the connection, and Frost
// polls its state and the stream's writable space while holding the loop's lock. Opening gives up after 3 seconds.
export async function openPulse(
  api: PulseAPI = bindPulse(),
  wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<Stream> {
  const loop = api.pa_threaded_mainloop_new();
  if (!loop) throw new Error('libpulse could not start');
  let context = 0n;
  let stream = 0n;
  let closed = false;
  const locked = <T>(f: () => T): T => {
    api.pa_threaded_mainloop_lock(loop);
    try {
      return f();
    } finally {
      api.pa_threaded_mainloop_unlock(loop);
    }
  };
  // Disconnecting the context ends its stream too. The loop's thread stops last, which has to happen unlocked.
  const close = () => {
    if (closed) return;
    closed = true;
    locked(() => {
      if (context) api.pa_context_disconnect(context);
      if (stream) api.pa_stream_unref(stream);
      if (context) api.pa_context_unref(context);
    });
    api.pa_threaded_mainloop_stop(loop);
    api.pa_threaded_mainloop_free(loop);
  };
  // Context and stream states count up to ready, 4 and 2, and anything past ready means failed or terminated.
  const until = async (state: () => number, ready: number, failure: string) => {
    for (let i = 0; i < 600; i++) {
      const now = locked(state);
      if (now === ready) return;
      if (now > ready) break;
      await wait(5);
    }
    throw new Error(failure);
  };

  try {
    // Flag 1 is PA_CONTEXT_NOAUTOSPAWN, so Frost never starts a sound server.
    const failure = 'could not connect to the sound server';
    context = api.pa_context_new(api.pa_threaded_mainloop_get_api(loop), 'frost');
    if (!context || api.pa_context_connect(context, null, 1, null) < 0 || api.pa_threaded_mainloop_start(loop) < 0)
      throw new Error(failure);
    await until(() => api.pa_context_get_state(context), 4, failure);

    // pa_sample_spec is the format (3 is PA_SAMPLE_S16LE), rate and channels. pa_buffer_attr is maxlength, tlength,
    // prebuf, minreq and fragsize, with -1 for the server's choice. The server keeps the lead buffered and starts
    // playing once a block arrives. Flag 0x2000 is PA_STREAM_ADJUST_LATENCY, which sizes the device's buffer to match.
    const spec = Buffer.alloc(12);
    spec.writeInt32LE(3, 0);
    spec.writeUInt32LE(sampleRate, 4);
    spec.writeUInt8(1, 8);
    const attr = Buffer.alloc(20, 0xff);
    attr.writeUInt32LE((leadMs * sampleRate * 2) / 1000, 4);
    attr.writeUInt32LE(blockFrames * 2, 8);
    attr.writeUInt32LE(blockFrames * 2, 12);
    locked(() => {
      stream = api.pa_stream_new(context, 'sound effects', spec, null);
      if (!stream || api.pa_stream_connect_playback(stream, null, attr, 0x2000, null, null) < 0)
        throw new Error('could not open a sound stream');
    });
    await until(() => api.pa_stream_get_state(stream), 2, 'could not open a sound stream');
  } catch (e) {
    close();
    throw e;
  }

  return {
    room() {
      if (closed) throw new Error('the sound stream is closed');
      const [state, bytes] = locked(() => [api.pa_stream_get_state(stream), api.pa_stream_writable_size(stream)]);
      if (state !== 2) throw new Error('the sound server stopped the stream');
      if (bytes === 0xffffffffffffffffn) throw new Error('could not read sound stream capacity');
      return Math.min(maxLeadMs, (Number(bytes) / (sampleRate * 2)) * 1000);
    },
    write(block) {
      if (closed || locked(() => api.pa_stream_write(stream, block, BigInt(block.length), null, 0n, 0)) < 0)
        throw new Error('could not write sound');
    },
    close: async () => close(),
  };
}

interface SoundOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: (program: string, args: string[]) => HelperProcess;
  openStream?: () => Promise<Stream>;
  random?: () => number;
  now?: () => number;
}

// A shaped clip and its variants. ids are the helper's buffer numbers, and last is the variant played last, which the
// next play avoids.
interface Sound {
  clip: Clip;
  samples: Float32Array;
  variants: Float32Array[];
  ids: number[];
  last: number;
}

// Plays named clips. Setup and playback failures don't throw, and sound stays off after one. err() reports it.
export class Player {
  private readonly sounds = new Map<string, Sound>();
  private readonly platform: NodeJS.Platform;
  private readonly random: () => number;
  private readonly now: () => number;
  private ready = false;
  private error?: Error;
  private closed = false;
  private starting?: Promise<void>;
  private closing?: Promise<void>;

  // The helper and when each of its voices falls silent, in now() milliseconds.
  private helper?: HelperProcess;
  private helperExit?: Promise<void>;
  private readonly voices = Array.from({ length: voiceCount }, () => ({ name: '', until: -Infinity }));

  // The stream, its mixer and the timer that keeps it fed.
  private stream?: Stream;
  private readonly mixer = new Mixer();
  private timer?: NodeJS.Timeout;

  // Clips are decoded and shaped up front. Variants render and the output starts in the background, and play()
  // does nothing until the output is ready.
  constructor(
    clips: Record<string, Clip>,
    private readonly options: SoundOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => performance.now());
    if ((options.env ?? process.env).FROST_NO_SOUND) {
      this.error = new Error('sound disabled by FROST_NO_SOUND');
      return;
    }
    try {
      for (const [name, clip] of Object.entries(clips))
        this.sounds.set(name, {
          clip,
          samples: cut(effects(decodeWAV(clip.wav), clip), clip.cut),
          variants: [],
          ids: [],
          last: -1,
        });
    } catch (e) {
      this.error = e as Error;
      return;
    }
    this.starting = this.init();
  }

  // The output takes a moment to start, so it starts while the variants render. A stream is fed from then until it
  // closes.
  private async init(): Promise<void> {
    try {
      if (this.platform === 'darwin') {
        const started = this.startHelper();
        await this.render();
        this.loadHelper();
        if (await started) this.ready = !this.closed;
        else await this.stopHelper();
        return;
      }
      const open = this.options.openStream ?? (async () => (this.platform === 'win32' ? openWaveOut() : openPulse()));
      const opening = open();
      opening.catch(() => {});
      await this.render();
      const stream = await opening;
      if (this.closed) {
        await stream.close();
        return;
      }
      this.stream = stream;
      this.ready = true;
      this.timer = setInterval(() => this.pump(), blockMs);
      this.timer.unref();
      this.pump();
    } catch (e) {
      if (!this.closed) this.error = e as Error;
    }
  }

  // Renders every variant at playback level, clipped to full scale. Clips without jitter get one. Each variant
  // takes a few milliseconds, so the event loop gets a turn between them.
  private async render(): Promise<void> {
    for (const sound of this.sounds.values()) {
      const count = sound.clip.pitch || sound.clip.tempo ? variantCount : 1;
      const gain = level * (sound.clip.volume || 1);
      for (let i = 0; i < count && !this.closed; i++) {
        const v = vary(sound.samples, jitter(sound.clip.pitch, this.random), jitter(sound.clip.tempo, this.random));
        sound.variants.push(v.map(x => Math.max(-1, Math.min(1, x * gain))));
        await new Promise(resolve => setImmediate(resolve));
      }
    }
  }

  // Starts the macOS helper. The promise resolves true once its engine runs, and false if it can't start, reports
  // an error, exits or stays silent for 10 seconds. A helper that stops later turns sound off.
  private startHelper(): Promise<boolean> {
    let child: HelperProcess;
    try {
      child = (this.options.spawn ?? spawnHelper)('osascript', ['-l', 'JavaScript', '-e', helperScript]);
    } catch (e) {
      this.error = e as Error;
      return Promise.resolve(false);
    }
    this.helper = child;
    child.stdin.on('error', () => {});
    let exited!: () => void;
    this.helperExit = new Promise(resolve => (exited = resolve));
    return new Promise(resolve => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), 10_000);
      let lines = '';
      child.stdout.on('data', (data: Buffer) => {
        lines += data;
        for (let end = lines.indexOf('\n'); end >= 0; end = lines.indexOf('\n')) {
          const line = lines.slice(0, end).trim();
          lines = lines.slice(end + 1);
          if (line === 'ready') done(true);
          else if (line.startsWith('error ')) {
            this.error = new Error(line.slice(6));
            done(false);
          }
        }
      });
      const stopped = () => {
        exited();
        if (this.helper === child) {
          this.ready = false;
          this.error ??= new Error('the audio helper stopped');
        }
        done(false);
      };
      child.on('error', e => {
        if (this.helper === child) this.error = e;
        stopped();
      });
      child.on('exit', stopped);
    });
  }

  // Sends every variant to the helper, which reads them after its engine starts.
  private loadHelper(): void {
    let id = 0;
    for (const sound of this.sounds.values())
      for (const v of sound.variants) {
        sound.ids.push(id);
        this.send(['load', id++, Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64')]);
      }
  }

  private send(message: unknown[]): void {
    this.helper?.stdin.write(JSON.stringify(message) + '\n');
  }

  // The helper stops its engine and exits at the end of its input.
  private async stopHelper(): Promise<void> {
    const child = this.helper;
    if (!child) return;
    this.helper = undefined;
    await endProcess(child, this.helperExit!);
  }

  available(): boolean {
    return this.ready;
  }

  err(): Error | undefined {
    return this.error;
  }

  // Fire and forget. Picks a variant other than the last one, then plays it on the helper or the stream.
  play(name: string): void {
    const sound = this.sounds.get(name);
    if (!sound || !this.ready || this.closed) return;
    let variant = Math.floor(this.random() * sound.variants.length);
    if (variant === sound.last && sound.variants.length > 1) variant = (variant + 1) % sound.variants.length;
    const played = this.helper ? this.playHelper(name, sound, variant) : this.mixer.add(name, sound.variants[variant]);
    if (!played) return;
    sound.last = variant;
    this.pump();
  }

  // Writes as many blocks as the stream has room for, with whatever is playing mixed in and silence otherwise. A
  // stream that fails turns sound off.
  private pump(): void {
    const stream = this.stream;
    if (!stream) return;
    try {
      for (let ms = stream.room(); ms > 0; ms -= blockMs) stream.write(this.mixer.block(blockFrames));
    } catch (e) {
      this.stream = undefined;
      this.ready = false;
      clearInterval(this.timer);
      this.error = e as Error;
      void stream.close().catch(() => {});
    }
  }

  // Takes the voice that falls silent first, which is an idle one when any are free, and steals it otherwise.
  // Voices count as busy for 50 ms past the clip, in case it started late.
  private playHelper(name: string, sound: Sound, variant: number): boolean {
    const now = this.now();
    let pick = 0;
    let playing = 0;
    for (let i = 0; i < this.voices.length; i++) {
      if (this.voices[i].name === name && this.voices[i].until > now) playing++;
      if (this.voices[i].until < this.voices[pick].until) pick = i;
    }
    if (playing >= clipLimit) return false;
    const steal = this.voices[pick].until > now;
    this.voices[pick] = { name, until: now + (sound.variants[variant].length / sampleRate) * 1000 + 50 };
    this.send(['play', pick, sound.ids[variant], steal ? 1 : 0]);
    return true;
  }

  // Stops new plays and the helper or stream. A stream still opening is closed when it opens.
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      this.ready = false;
      clearInterval(this.timer);
      await this.stopHelper();
      await this.stream?.close().catch(() => {});
      this.stream = undefined;
      await this.starting;
    })());
  }
}
