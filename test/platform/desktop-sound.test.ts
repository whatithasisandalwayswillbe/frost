// Tests for desktop actions (opening URLs, revealing files, picking folders) with stubbed command
// runners, and for the sound effects and WAV codec. Nothing opens a browser or plays audio.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { available, openCommand, revealCommand, openBrowser, pickFolder } from '../../src/platform/desktop.js';
import {
  Player,
  Mixer,
  decodeWAV,
  openWaveOut,
  openPulse,
  resample,
  vary,
  cut,
  effects,
  sampleRate,
  type HelperProcess,
  type Stream,
  type WinMM,
  type PulseAPI,
} from '../../src/platform/sound.js';

// An SSH session has no usable desktop even when DISPLAY is set. URLs and paths are passed as
// single arguments, never through a shell.
test('desktop integrations preserve URLs and treat paths as arguments', async () => {
  assert.equal(available({ DISPLAY: ':0' }, 'linux'), true);
  assert.equal(available({ SSH_TTY: '/dev/tty', DISPLAY: ':0' }, 'linux'), false);
  assert.deepEqual(openCommand('https://example.com/?a=1&b=2', 'win32'), [
    'rundll32',
    ['url.dll,FileProtocolHandler', 'https://example.com/?a=1&b=2'],
  ]);
  assert.deepEqual(revealCommand('/a/file', 'darwin'), ['open', ['-R', '/a/file']]);
  assert.deepEqual(revealCommand('C:\\my files\\notes.txt', 'win32'), [
    'explorer',
    ['/select,"C:\\my files\\notes.txt"'],
  ]);

  let calls = 0;
  await openBrowser('https://example.com/', {
    runner: async () => {
      calls++;
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(calls, 1);

  // A cancelled picker exits non-zero.
  await assert.rejects(
    pickFolder('title', '/start', { platform: 'darwin', runner: async () => ({ code: 1, stdout: '', stderr: '' }) }),
    /no folder chosen/,
  );

  // On macOS, choose folder fails without opening when its start folder is missing, so only a folder
  // that exists is passed.
  const scripts: string[] = [];
  const picker = async (_: string, args: string[]) => {
    scripts.push(args[1]);
    return { code: 0, stdout: '/Users/me/Picked/\n', stderr: '' };
  };
  const here = process.cwd();
  assert.equal(await pickFolder('Restore "to"', here, { platform: 'darwin', runner: picker }), '/Users/me/Picked/');
  await pickFolder('Restore to', path.join(here, 'no such folder'), { platform: 'darwin', runner: picker });
  assert.deepEqual(scripts, [
    `POSIX path of (choose folder with prompt "Restore \\"to\\"" default location (POSIX file ${JSON.stringify(here)}))`,
    'POSIX path of (choose folder with prompt "Restore to")',
  ]);

  // Picker output ends with a record newline, while spaces and an embedded final newline can
  // belong to a real POSIX filename. Windows emits its path without a record terminator.
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const selected = platform === 'win32' ? 'C:\\folder with a space ' : '/folder with a space \n';
    assert.equal(
      await pickFolder('title', '', {
        platform,
        runner: async () => ({ code: 0, stdout: selected + (platform === 'win32' ? '' : '\n'), stderr: '' }),
      }),
      selected,
    );
  }
});

const sine = (hz: number, n: number) =>
  Float32Array.from({ length: n }, (_, i) => 0.8 * Math.sin((2 * Math.PI * hz * i) / sampleRate));

// Estimates frequency by counting upward zero crossings in the middle three fifths, away from
// any fade at either end.
function pitch(samples: Float32Array): number {
  const start = Math.trunc(samples.length / 5);
  const end = Math.trunc((samples.length * 4) / 5);
  let n = 0;
  for (let i = start + 1; i < end; i++) if (samples[i - 1] < 0 && samples[i] >= 0) n++;
  return (n * sampleRate) / (end - start);
}

test('sound effects preserve independent pitch and tempo, fading, and input', () => {
  const samples = sine(440, 22050);
  assert.deepEqual(vary(samples, 1, 1), samples);

  // Raising pitch 5% keeps the length. Speeding up 5% keeps the pitch.
  const shifted = vary(samples, 1.05, 1);
  const faster = vary(samples, 1, 1.05);
  assert.ok(Math.abs(shifted.length - samples.length) <= 1);
  assert.ok(Math.abs(pitch(shifted) - 462) < 8);
  assert.ok(Math.abs(faster.length - samples.length / 1.05) < 2);
  assert.ok(Math.abs(pitch(faster) - 440) < 8);

  // Cutting to 150 ms at 44.1 kHz keeps 6615 samples, fades the tail and leaves the source alone.
  const source = Float32Array.from({ length: 44100 }, () => 1);
  const shortened = cut(source, 150);
  assert.equal(shortened.length, 6615);
  assert.ok(shortened.at(-1)! < 0.01);
  assert.equal(source[6614], 1);
  assert.equal(resample(samples, 2).length, Math.trunc(samples.length / 2));

  const processed = effects(samples, { wav: Buffer.alloc(0), shift: 2, ring: 400, crush: 4, decay: 100 });
  assert.ok(processed.length < samples.length);
  assert.equal(samples[0], 0);
});

// Encodes mono 16-bit PCM WAV, the format of the game's clips.
function encodeWAV(samples: Float32Array): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(samples[i] * 32767), 44 + i * 2);
  return b;
}

test('WAV decoder validates structure and preserves PCM', async () => {
  const samples = sine(330, 4000);
  const wav = encodeWAV(samples);
  const restored = decodeWAV(wav);
  assert.equal(restored.length, samples.length);
  assert.ok(Math.abs(restored[100] - samples[100]) < 0.0001);
  for (const bytes of [Buffer.alloc(0), Buffer.from('RIFFxxxxWAVE'), wav.subarray(0, 30), Buffer.from('BAD!')])
    assert.throws(() => decodeWAV(bytes));

  // FROST_NO_SOUND turns the player off before it ever opens an output.
  const player = new Player(
    { tone: { wav } },
    {
      env: { FROST_NO_SOUND: '1' },
      openStream: async () => {
        throw new Error('must not open audio');
      },
    },
  );
  assert.equal(player.available(), false);
  player.play('tone');
  assert.match(player.err()!.message, /disabled/);
  await player.close();
});

// A stand-in for a child process. It records what Frost writes and exits when its input ends, unless it's stuck,
// when only kill() stops it.
function fakeProcess(stuck = false) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdin.on('data', data => chunks.push(data));
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    killed: false,
    kill() {
      child.killed = true;
      child.emit('exit');
      return true;
    },
  });
  if (!stuck) stdin.on('end', () => child.emit('exit'));
  return { child: child as HelperProcess & typeof child, chunks };
}

// The macOS helper, recording each message Frost sends.
function fakeHelper(stuck = false) {
  const { child } = fakeProcess(stuck);
  const sent: unknown[][] = [];
  let text = '';
  child.stdin.on('data', data => {
    text += data;
    for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n')) {
      sent.push(JSON.parse(text.slice(0, end)));
      text = text.slice(end + 1);
    }
  });
  return { child, sent };
}

// Waits for background work without timers, so mocked timers can't stall it.
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 10000 && !done(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(done(), 'timed out');
}

const floats = (base64: string) => {
  const b = Buffer.from(base64, 'base64');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};

// A 100 ms tone. With random fixed at 0 there's no jitter, so every variant keeps its length.
const tone = encodeWAV(sine(440, 4410));

test('the macOS helper loads variants once, ignores early plays and shares its voices', async () => {
  const { child, sent } = fakeHelper();
  const spawned: string[][] = [];
  let clock = 0;
  const player = new Player(
    { a: { wav: tone, pitch: 0.05, volume: 0.5 }, b: { wav: tone, pitch: 0.05 }, c: { wav: tone } },
    {
      env: {},
      platform: 'darwin',
      random: () => 0,
      now: () => clock,
      spawn: (program, args) => {
        spawned.push([program, ...args]);
        return child;
      },
    },
  );

  // Clips with jitter get four variants and the plain one gets one. They arrive as float samples at playback level,
  // and a play before the helper is ready is dropped rather than queued.
  player.play('a');
  await until(() => sent.length === 9);
  assert.deepEqual(spawned[0].slice(0, 4), ['osascript', '-l', 'JavaScript', '-e']);
  assert.deepEqual(
    sent.map(([command, id]) => [command, id]),
    Array.from({ length: 9 }, (_, i) => ['load', i]),
  );
  const plain = floats(sent[8][2] as string);
  assert.equal(plain.length, 4410);
  assert.ok(Math.abs(Math.max(...plain) - 0.8 * 0.36) < 0.001);
  assert.ok(Math.abs(Math.max(...floats(sent[0][2] as string)) - 0.8 * 0.36 * 0.5) < 0.001);
  assert.equal(player.available(), false);

  child.stdout.write('rea');
  child.stdout.write('dy\n');
  await until(() => player.available());

  // Each play takes an idle voice and avoids repeating the last variant. A fifth copy of a playing clip is dropped,
  // and with every voice busy the one that ends first is stolen.
  for (const name of ['a', 'a', 'a', 'a', 'a', 'b', 'b', 'b', 'b', 'c']) {
    player.play(name);
    clock++;
  }
  clock = 1000;
  player.play('c');
  await until(() => sent.length === 9 + 10);
  assert.deepEqual(sent.slice(9), [
    ['play', 0, 0, 0],
    ['play', 1, 1, 0],
    ['play', 2, 0, 0],
    ['play', 3, 1, 0],
    ['play', 4, 4, 0],
    ['play', 5, 5, 0],
    ['play', 6, 4, 0],
    ['play', 7, 5, 0],
    ['play', 0, 8, 1],
    ['play', 1, 8, 0],
  ]);

  // Closing ends the helper's input, and it exits by itself.
  await player.close();
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(child.killed, false);
  player.play('c');
  assert.equal(sent.length, 19);
  assert.equal(player.err(), undefined);
});

test('a stuck macOS helper is killed, and one that stops turns sound off', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stuck = fakeHelper(true);
  const player = new Player({ c: { wav: tone } }, { env: {}, platform: 'darwin', spawn: () => stuck.child });
  await until(() => stuck.sent.length === 1);
  stuck.child.stdout.write('ready\n');
  await until(() => player.available());
  const closing = player.close();
  await until(() => stuck.child.stdin.writableEnded);
  t.mock.timers.tick(1000);
  await closing;
  assert.equal(stuck.child.killed, true);

  const crashing = fakeHelper();
  const other = new Player({ c: { wav: tone } }, { env: {}, platform: 'darwin', spawn: () => crashing.child });
  await until(() => crashing.sent.length === 1);
  crashing.child.stdout.write('ready\n');
  await until(() => other.available());
  crashing.child.emit('exit');
  assert.equal(other.available(), false);
  assert.match(other.err()!.message, /helper stopped/);
  await other.close();
});

test("an output that can't start leaves the game silent", async () => {
  // A missing osascript on macOS.
  const mac = new Player(
    { a: { wav: tone } },
    {
      env: {},
      platform: 'darwin',
      spawn: () => {
        const { child } = fakeProcess();
        setImmediate(() => child.emit('error', new Error('spawn osascript ENOENT')));
        return child;
      },
    },
  );
  await until(() => !!mac.err());
  await mac.close();
  assert.equal(mac.available(), false);
  assert.match(mac.err()!.message, /ENOENT/);

  // A Linux machine without libpulse.
  const linux = new Player(
    { a: { wav: tone } },
    {
      env: {},
      platform: 'linux',
      openStream: async () => {
        throw new Error('libpulse.so.0: cannot open shared object file');
      },
    },
  );
  await until(() => !!linux.err());
  linux.play('a');
  assert.equal(linux.available(), false);
  await linux.close();
});

const int16 = (block: Buffer) => Array.from({ length: block.length / 2 }, (_, i) => block.readInt16LE(i * 2));

test('the mixer sums voices, clips to full scale, limits each clip and fades a stolen voice', () => {
  const mixer = new Mixer();
  const half = new Float32Array(100).fill(0.5);
  const loud = new Float32Array(50).fill(0.75);
  assert.equal(mixer.active, false);
  assert.ok(mixer.add('a', half));
  assert.ok(mixer.add('b', loud));
  const first = int16(mixer.block(60));
  assert.equal(first[0], 32767);
  assert.equal(first[55], Math.round(0.5 * 32767));
  assert.deepEqual(int16(mixer.block(60)).slice(40), Array(20).fill(0));
  assert.equal(mixer.active, false);

  // A fifth copy of a clip is refused. With eight voices busy, the one nearest its end fades out over 3 ms.
  for (let i = 0; i < 4; i++) assert.ok(mixer.add('a', new Float32Array(1000).fill(0.01)));
  assert.equal(mixer.add('a', half), false);
  for (let i = 0; i < 3; i++) mixer.add('b', new Float32Array(1000).fill(0.01));
  mixer.add('c', new Float32Array(500).fill(0.1));
  assert.ok(mixer.add('d', new Float32Array(1000).fill(0.01)));
  const mixed = int16(mixer.block(400));
  const fade = Math.trunc(0.003 * sampleRate);
  assert.ok(mixed[0] > mixed[fade - 1]);
  assert.equal(mixed[fade + 1], Math.round(0.08 * 32767));
});

test('a burst of stolen voices leaves eight playing voices after their short fades', () => {
  const mixer = new Mixer();
  const samples = new Float32Array(1000).fill(0.001);
  for (let i = 0; i < 1000; i++) assert.ok(mixer.add('clip-' + i, samples));
  const output = int16(mixer.block(200));
  assert.equal(output[199], Math.round(8 * samples[0] * 32767));
  assert.equal(samples[0], Math.fround(0.001));
  assert.equal(mixer.active, true);
  mixer.block(1000);
  assert.equal(mixer.active, false);
});

test('a stream is fed silence from the start, mixes sounds in as it has room and stops when closed', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  // A stream that keeps 50 ms queued, with played counting what the device has used up.
  const blocks: Buffer[] = [];
  let played = 0;
  let closed = 0;
  const stream: Stream = {
    room: () => 50 - (blocks.length * 10 - played),
    write: block => blocks.push(block),
    close: async () => {
      closed++;
    },
  };
  const player = new Player({ a: { wav: tone } }, { env: {}, platform: 'linux', openStream: async () => stream });
  await until(() => player.available());

  // 50 ms of silence goes out as soon as the stream opens, and a play with no room waits for the next block.
  assert.equal(blocks.length, 5);
  assert.ok(blocks.every(b => b.length === 882 && b.every(x => x === 0)));
  player.play('a');
  assert.equal(blocks.length, 5);
  for (let i = 0; i < 20; i++) {
    played += 10;
    t.mock.timers.tick(10);
  }

  // The 100 ms tone fills the ten blocks after the queued silence, and silence follows it.
  assert.equal(blocks.length, 25);
  const samples = blocks.flatMap(int16);
  assert.equal(samples[5 * 441 + 100], Math.round(sine(440, 4410)[100] * 0.36 * 32767));
  assert.ok(samples.slice(0, 5 * 441).every(x => x === 0));
  assert.ok(samples.slice(15 * 441).every(x => x === 0));

  // Closing stops the stream, and nothing is written after.
  await player.close();
  assert.equal(closed, 1);
  player.play('a');
  t.mock.timers.tick(100);
  assert.equal(blocks.length, 25);
});

test('a stream that fails turns sound off and closes', async () => {
  let failing = false;
  let closed = 0;
  const stream: Stream = {
    room: () => {
      if (failing) throw new Error('the sound server stopped the stream');
      return 0;
    },
    write: () => {},
    close: async () => {
      closed++;
    },
  };
  const player = new Player({ a: { wav: tone } }, { env: {}, platform: 'linux', openStream: async () => stream });
  await until(() => player.available());
  failing = true;
  player.play('a');
  assert.equal(player.available(), false);
  assert.match(player.err()!.message, /stopped the stream/);
  await player.close();
  assert.equal(closed, 1);
});

// A winmm stand-in. Prepare marks a header prepared, reset marks every header done, and pointer() hands out fake
// addresses so headers can be traced back to their blocks.
function fakeWinMM(failOpen = 0, failPrepare = -1) {
  const calls: string[] = [];
  const blocks = new Map<bigint, Buffer>();
  const headers: Buffer[] = [];
  let next = 0x10000n;
  const api: WinMM = {
    waveOutOpen: (handle, device, format, _callback, _instance, flags) => {
      calls.push(`open ${device.toString(16)} ${flags} ${format.toString('hex')}`);
      handle.writeBigUInt64LE(0xabcn);
      return failOpen;
    },
    waveOutPrepareHeader: (wave, header, size) => {
      calls.push(`prepare ${wave.toString(16)} ${size}`);
      if (headers.length === failPrepare) return 11;
      header.writeUInt32LE(header.readUInt32LE(24) | 2, 24);
      headers.push(header);
      return 0;
    },
    waveOutWrite: (_wave, header, size) => {
      calls.push(`write ${header.readUInt32LE(8)} ${size}`);
      return 0;
    },
    waveOutUnprepareHeader: () => {
      calls.push('unprepare');
      return 0;
    },
    waveOutReset: () => {
      calls.push('reset');
      for (const h of headers) h.writeUInt32LE(h.readUInt32LE(24) | 1, 24);
      return 0;
    },
    waveOutClose: () => {
      calls.push('close');
      return 0;
    },
    timeBeginPeriod: ms => {
      calls.push(`begin ${ms}`);
      return 0;
    },
    timeEndPeriod: ms => {
      calls.push(`end ${ms}`);
      return 0;
    },
    pointer: buffer => {
      blocks.set((next += 0x1000n), buffer);
      return next;
    },
  };
  // Marks the first n queued blocks played.
  const play = (n: number) => {
    for (const h of headers.filter(h => !(h.readUInt32LE(24) & 1)).slice(0, n))
      h.writeUInt32LE(h.readUInt32LE(24) | 1, 24);
  };
  return { api, calls, blocks, headers, play };
}

test('waveOut queues through a prepared ring, raises its lead when it runs low and closes in order', async () => {
  const { api, calls, blocks, headers, play } = fakeWinMM();
  const out = openWaveOut(api);

  // The default device opens for 44.1 kHz 16-bit mono without a callback, timers go to 1 ms, and fifteen 882-byte
  // blocks are prepared, enough for a 150 ms lead.
  assert.deepEqual(calls.slice(0, 3), [
    'open ffffffff 0 0100010044ac000088580100020010000000',
    'begin 1',
    'prepare abc 48',
  ]);
  assert.equal(headers.length, 15);
  for (const h of headers) assert.equal(blocks.get(h.readBigUInt64LE(0))!.length, 882);

  // A fresh device wants the 50 ms lead. Written blocks are copied into their slots and count until WHDR_DONE.
  assert.equal(out.room(), 50);
  for (let i = 0; i < 5; i++) out.write(Buffer.alloc(882, i + 1));
  assert.equal(calls.at(-1), 'write 882 48');
  assert.deepEqual(blocks.get(headers[4].readBigUInt64LE(0)), Buffer.alloc(882, 5));
  assert.equal(out.room(), 0);
  play(2);
  assert.equal(out.room(), 20);

  // Finding 20 ms or less queued raises the lead by a block each time, up to 150 ms, and a full ring refuses more.
  play(3);
  assert.equal(out.room(), 60);
  for (let i = 0; i < 20; i++) out.room();
  assert.equal(out.room(), 150);
  for (let i = 0; i < 15; i++) out.write(Buffer.alloc(882));
  assert.ok(headers.every(h => !(h.readUInt32LE(24) & 1)));
  assert.throws(() => out.write(Buffer.alloc(882)), /closed or full/);

  // Closing resets, unprepares every block, closes the device and gives the timers back, once.
  await out.close();
  assert.deepEqual(calls.slice(-18), ['reset', ...Array(15).fill('unprepare'), 'close', 'end 1']);
  assert.throws(() => out.write(Buffer.alloc(882)), /closed or full/);
  await out.close();
  assert.equal(calls.filter(c => c === 'close').length, 1);

  // A device that won't open throws. One that fails partway through preparing undoes what it did.
  assert.throws(() => openWaveOut(fakeWinMM(2).api), /waveOutOpen failed with error 2/);
  const partial = fakeWinMM(0, 2);
  assert.throws(() => openWaveOut(partial.api), /waveOutPrepareHeader failed with error 11/);
  assert.deepEqual(partial.calls.slice(1), [
    'begin 1',
    'prepare abc 48',
    'prepare abc 48',
    'prepare abc 48',
    'reset',
    'unprepare',
    'unprepare',
    'close',
    'end 1',
  ]);
});

// A libpulse stand-in. States step through the given lists, one per poll, and every call after the loop starts checks
// that the lock is held.
function fakePulse(contextStates: number[], streamStates: number[]) {
  const calls: string[] = [];
  let started = false;
  let locks = 0;
  let writable = 0n;
  let state = 2;
  const locked = () => assert.ok(!started || locks === 1, 'libpulse called without the lock');
  const api: PulseAPI = {
    pa_threaded_mainloop_new: () => 1n,
    pa_threaded_mainloop_get_api: () => 2n,
    pa_threaded_mainloop_start: () => {
      started = true;
      return 0;
    },
    pa_threaded_mainloop_lock: () => void locks++,
    pa_threaded_mainloop_unlock: () => void locks--,
    pa_threaded_mainloop_stop: () => {
      assert.equal(locks, 0);
      calls.push('stop');
    },
    pa_threaded_mainloop_free: () => void calls.push('free'),
    pa_context_new: (_, name) => {
      calls.push(`context ${name}`);
      return 3n;
    },
    pa_context_connect: (_, server, flags) => {
      calls.push(`connect ${server} ${flags}`);
      return 0;
    },
    pa_context_get_state: () => (locked(), contextStates.length > 1 ? contextStates.shift()! : contextStates[0]),
    pa_context_disconnect: () => (locked(), void calls.push('disconnect')),
    pa_context_unref: () => (locked(), void calls.push('unref context')),
    pa_stream_new: (_, name, spec) => {
      locked();
      calls.push(`stream ${name} ${spec.toString('hex')}`);
      return 4n;
    },
    pa_stream_connect_playback: (_, device, attr, flags) => {
      locked();
      calls.push(`playback ${device} ${attr.toString('hex')} ${flags}`);
      return 0;
    },
    pa_stream_get_state: () => (locked(), streamStates.length > 1 ? streamStates.shift()! : state),
    pa_stream_writable_size: () => (locked(), writable),
    pa_stream_write: (_, data, bytes, free, offset, seek) => {
      locked();
      calls.push(`write ${data.length} ${bytes} ${free} ${offset} ${seek}`);
      return 0;
    },
    pa_stream_unref: () => (locked(), void calls.push('unref stream')),
  };
  return {
    api,
    calls,
    setWritable: (n: bigint) => (writable = n),
    setState: (n: number) => (state = n),
  };
}

test('libpulse connects through a polled loop, writes what the server asks for and closes in order', async () => {
  const pulse = fakePulse([1, 2, 3, 4], [1, 2]);
  const polls: number[] = [];
  const out = await openPulse(pulse.api, async ms => void polls.push(ms));

  // Connecting never starts a server. The stream is 16-bit mono at 44.1 kHz, keeps 50 ms (4410 bytes) buffered,
  // starts and refills a block at a time, and asks the server to match the device's latency.
  assert.deepEqual(pulse.calls, [
    'context frost',
    'connect null 1',
    'stream sound effects 0300000044ac000001000000',
    'playback null ffffffff3a1100007203000072030000ffffffff 8192',
  ]);
  assert.deepEqual(polls, [5, 5, 5, 5]);

  // Room is whatever the server asks for, and a block is written whole for libpulse to copy.
  pulse.setWritable(1764n);
  assert.equal(out.room(), 20);
  pulse.setWritable(88200n);
  assert.equal(out.room(), 150);
  pulse.setWritable(0xffffffffffffffffn);
  assert.throws(() => out.room(), /could not read sound stream capacity/);
  out.write(Buffer.alloc(882));
  assert.equal(pulse.calls.at(-1), 'write 882 882 null 0 0');
  pulse.setState(3);
  assert.throws(() => out.room(), /stopped the stream/);

  // Closing disconnects and frees under the lock, then stops the loop unlocked, once.
  await out.close();
  await out.close();
  assert.deepEqual(pulse.calls.slice(-5), ['disconnect', 'unref stream', 'unref context', 'stop', 'free']);
  assert.throws(() => out.room(), /closed/);

  // A server that refuses the connection fails the open and cleans up.
  const refused = fakePulse([1, 5], [2]);
  await assert.rejects(
    openPulse(refused.api, async () => {}),
    /could not connect to the sound server/,
  );
  assert.deepEqual(refused.calls.slice(-4), ['disconnect', 'unref context', 'stop', 'free']);
});
