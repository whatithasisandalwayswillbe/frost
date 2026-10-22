// BIP39 mnemonic encoding. Frost shows its 256-bit master key as a 24-word recovery phrase
// built from the English wordlist in assets/.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const words = readFileSync(new URL('../../assets/english.txt', import.meta.url), 'utf8')
  .trim()
  .split(/\s+/);
const indexes = new Map(words.map((word, i) => [word, i]));

const errChecksum = new Error('bip39: checksum mismatch (check the words and their order)');

// Turns 16 to 32 bytes of entropy into 12 to 24 words. The entropy is followed by one checksum
// bit per 4 bytes, taken from the top of its SHA-256, and every word holds 11 bits.
export function encode(entropy: Uint8Array): string {
  const n = entropy.length;
  if (n < 16 || n > 32 || n % 4 !== 0) throw new Error(`bip39: invalid entropy length ${n}`);

  const sum = createHash('sha256').update(entropy).digest();
  const checksumBits = n / 4;
  let value =
    (BigInt('0x' + Buffer.from(entropy).toString('hex')) << BigInt(checksumBits)) |
    BigInt(sum[0] >>> (8 - checksumBits));

  // Read 11-bit groups from the low end, filling the words from last to first.
  const result = new Array<string>((n * 8 + checksumBits) / 11);
  for (let i = result.length - 1; i >= 0; i--) {
    result[i] = words[Number(value & 2047n)];
    value >>= 11n;
  }
  return result.join(' ');
}

// Reverses encode. Case and extra whitespace don't matter, but every word must be in the
// wordlist and the checksum must match.
export function decode(mnemonic: string): Buffer {
  const list = mnemonic.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (![12, 15, 18, 21, 24].includes(list.length))
    throw new Error(`bip39: expected 12 to 24 words, got ${list.length}`);

  let value = 0n;
  for (let i = 0; i < list.length; i++) {
    const index = indexes.get(list[i]);
    if (index === undefined) throw new Error(`bip39: word ${i + 1} is not in the wordlist`);
    value = (value << 11n) | BigInt(index);
  }

  // Every three words carry one checksum bit, stored after the entropy.
  const checksumBits = list.length / 3;
  const checksum = Number(value & ((1n << BigInt(checksumBits)) - 1n));
  value >>= BigInt(checksumBits);
  const entropy = Buffer.from(value.toString(16).padStart((list.length * 11 - checksumBits) / 4, '0'), 'hex');
  if (createHash('sha256').update(entropy).digest()[0] >>> (8 - checksumBits) !== checksum) throw errChecksum;
  return entropy;
}
