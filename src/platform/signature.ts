// Verifies release checksums signed with `ssh-keygen -Y sign` (OpenSSH's SSHSIG format) against
// the pinned Ed25519 release key.
import { createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';

// Same key as install/release-signing.pub and the installer's RELEASE_KEY. The release script
// rewrites this exact line, so keep it on one line.
export const releaseKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHO/g64dTbRW3poi7pdiPKgljYdHXG+TZeZQg4cfzAsV';
const errBadSignature = new Error("checksums.txt isn't signed by the Frost release key");

// Reads SSH wire format: big-endian uint32s and uint32-length-prefixed strings. Any overrun
// fails as a bad signature.
class Reader {
  private pos = 0;

  constructor(private readonly buffer: Buffer) {}

  uint32(): number {
    if (this.pos + 4 > this.buffer.length) throw errBadSignature;
    const n = this.buffer.readUInt32BE(this.pos);
    this.pos += 4;
    return n;
  }

  string(): Buffer {
    const n = this.uint32();
    if (n > this.buffer.length - this.pos) throw errBadSignature;
    const b = this.buffer.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  // Trailing bytes are refused too.
  end(): void {
    if (this.pos !== this.buffer.length) throw errBadSignature;
  }
}

// Encodes an SSH wire-format string.
export function sshString(buffer: Buffer | string): Buffer {
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const n = Buffer.alloc(4);
  n.writeUInt32BE(b.length);
  return Buffer.concat([n, b]);
}

// Checks an armored SSHSIG signature over msg for the "file" namespace. Every failure, including
// a malformed key, throws errBadSignature.
export function verifySSHSig(authorized: string, msg: Buffer, armored: Buffer | string): void {
  try {
    // The authorized key line is "ssh-ed25519 <base64>", wrapping the key type and 32 key bytes.
    const fields = authorized.trim().split(/\s+/);
    if (fields[0] !== 'ssh-ed25519' || !fields[1]) throw new Error('release key must be ed25519');
    const want = Buffer.from(fields[1], 'base64');
    const keyReader = new Reader(want);
    if (keyReader.string().toString() !== 'ssh-ed25519') throw errBadSignature;
    const publicKey = keyReader.string();
    keyReader.end();
    if (publicKey.length !== 32) throw errBadSignature;

    // The armor body must be canonical base64 that round-trips exactly, starting with "SSHSIG".
    const armor = armored.toString().replaceAll('\r\n', '\n').trim();
    const match = /^-----BEGIN SSH SIGNATURE-----\s+([A-Za-z0-9+/=\s]+)\s+-----END SSH SIGNATURE-----$/.exec(armor);
    if (!match) throw errBadSignature;
    const encoded = match[1].replace(/\s/g, '');
    const blob = Buffer.from(encoded, 'base64');
    if (blob.toString('base64') !== encoded || blob.subarray(0, 6).toString() !== 'SSHSIG') throw errBadSignature;

    // Version 1, then the signer's public key, namespace, reserved, hash algorithm and signature.
    // The signer must be the trusted key, the namespace "file" and the hash SHA-256 or SHA-512.
    const reader = new Reader(blob.subarray(6));
    if (reader.uint32() !== 1) throw errBadSignature;
    const actual = reader.string();
    const namespace = reader.string();
    const reserved = reader.string();
    const hashAlg = reader.string();
    const sig = reader.string();
    reader.end();
    if (actual.length !== want.length || !timingSafeEqual(actual, want) || namespace.toString() !== 'file')
      throw errBadSignature;
    if (!['sha256', 'sha512'].includes(hashAlg.toString())) throw errBadSignature;

    // The signature blob is the key type and a 64-byte Ed25519 signature.
    const inner = new Reader(sig);
    if (inner.string().toString() !== 'ssh-ed25519') throw errBadSignature;
    const signature = inner.string();
    inner.end();
    if (signature.length !== 64) throw errBadSignature;

    // The signed data is "SSHSIG", then namespace, reserved, hash algorithm and the message
    // hash as SSH strings. The DER prefix wraps the raw key as an Ed25519 SubjectPublicKeyInfo.
    const digest = createHash(hashAlg.toString()).update(msg).digest();
    const signed = Buffer.concat([Buffer.from('SSHSIG'), ...[namespace, reserved, hashAlg, digest].map(sshString)]);
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
      type: 'spki',
      format: 'der',
    });
    if (!verify(null, signed, key, signature)) throw errBadSignature;
  } catch {
    throw errBadSignature;
  }
}
