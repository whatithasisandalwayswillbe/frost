// Storage clients for encrypted backup objects and setup probes. This file holds the backend
// contract, the shared HTTP transport and the S3 and Permafrost clients. The self-hosted clients
// are in sftp.ts, for a server reached over SSH, and local.ts, for a folder on a drive.

import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { isIP } from 'node:net';
import { backends, sshKeyPath, type Storage } from './config.js';
import { LocalBackend } from './local.js';
import { SFTPBackend } from './sftp.js';

export const errNotFound = new Error('object not found');
export const errExists = new Error('object already exists');
export const errConditionalUnsupported = new Error(
  'storage must support conditional object creation (If-None-Match: *)',
);
// The largest sealed object: 256 MiB of plaintext plus room for the seal. A sealed chunk is at most 8 MiB
// plus that room.
export const maxObjectSize = (256 << 20) + 64;
export const maxChunkSize = (8 << 20) + 64;
export const defaultPermafrostURL = 'https://permafrost.wihiaawb.com';
export const defaultPermafrostHost = new URL(defaultPermafrostURL).host;
// Where people get a key for the default server. Setup opens it, and the key is pasted back in.
export const permafrostKeyPage = 'https://getfro.st/perma';

export const permafrostAccountPage = permafrostKeyPage + '/portal';
// Where people with an account get a new key, which stops the old one working.
export const permafrostRecoverPage = permafrostKeyPage + '/recover';
export const permafrostSupport = 'care@getfro.st';

// The host a storage.permafrost.url setting points at. Blank means the default server.
function permafrostHost(url: string): string {
  try {
    return url ? new URL(url).host : defaultPermafrostHost;
  } catch {
    return url;
  }
}

export const isDefaultPermafrost = (url: string) => permafrostHost(url) === defaultPermafrostHost;

// How output names a Permafrost server. The default server is just Permafrost, and a custom one adds its host.
export function permafrostName(url: string): string {
  return isDefaultPermafrost(url) ? 'Permafrost' : `Permafrost (${permafrostHost(url)})`;
}

export function newBackend(storage: Storage): Backend {
  if (storage.backend === 's3') return new S3Backend(storage.s3);
  if (storage.backend === 'permafrost')
    return new PermafrostBackend(storage.permafrost.url || defaultPermafrostURL, storage.permafrost.token);
  if (storage.backend === 'sftp') return new SFTPBackend(storage.sftp, { identity: sshKeyPath() });
  if (storage.backend === 'local') return new LocalBackend(storage.local);
  throw new Error(`unknown storage.backend ${JSON.stringify(storage.backend)} (${backends})`);
}

// The storage contract. putNew creates an absent key atomically or throws errExists, get throws
// errNotFound for a missing key, and deleting a missing key succeeds. Ordinary methods leave the
// caller's buffers alone.
export interface Backend {
  put(key: string, data: Buffer, signal?: AbortSignal): Promise<void>;
  putNew(key: string, data: Buffer, signal?: AbortSignal): Promise<void>;
  get(key: string, signal?: AbortSignal): Promise<Buffer>;
  // Returns a fresh exclusive buffer that frost may detach or erase after download.
  getOwned?(key: string, signal?: AbortSignal): Promise<Buffer>;
  list(prefix: string, signal?: AbortSignal): Promise<string[]>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
  // How much the account stores and may store, for storage that reports it.
  usage?(signal?: AbortSignal): Promise<Usage>;
  toString(): string;
  // Identifies the complete destination. Backup only trusts the manifest's chunk list at the
  // location where it was checked.
  location?(): string;
  // Identifies the storage behind the location, such as the drive mounted at a path, for storage where
  // two copies of one repository can take turns at the same location.
  identity?(signal?: AbortSignal): Promise<string>;
  // Creates the storage's top folder when it's missing but its parent exists. Only setup calls it, so a
  // drive that isn't connected never becomes a new repository on whatever is mounted in its place.
  prepare?(signal?: AbortSignal): Promise<void>;
  // Ends connections the backend keeps open. Idle connections don't keep the process alive anyway.
  close?(): Promise<void>;
}

// The storage's top folder is missing, like a drive that isn't connected or a server folder that's gone.
// Its code lets scheduled backups wait for it a little while, the way they wait for the network.
export class MissingRootError extends Error {
  readonly code = 'ENOMEDIUM';
}

// A folder whose filesystem can't create a file only when its name is free, which conditional creates need.
// The storage fails closed rather than risk two machines overwriting each other's metadata.
export class UnsafeFolderError extends Error {
  readonly code = 'ENOTSUP';
}

// An account's storage use. quota is 0 when there's no limit. message is the server's own text for the
// person, such as a warning that the account is nearly full, or empty.
export interface Usage {
  used: number;
  quota: number;
  readOnly: boolean;
  message: string;
}

export function location(backend: Backend): string {
  return backend.location?.() ?? backend.toString();
}

export function hash(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

// Settles a promise early when the signal aborts. The work itself carries on.
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

// Object keys frost writes use lowercase letters, digits, `.`, `_`, `-` and `/`, with no empty,
// `.` or `..` segments.
export function validObjectKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= 1024 &&
    /^[a-z0-9._/-]+$/.test(key) &&
    key.split('/').every(segment => !!segment && segment !== '.' && segment !== '..')
  );
}

// Permafrost servers may use plain http only on these hosts.
export function isLoopback(host: string): boolean {
  host = host.replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '::1' ||
    (isIP(host) === 4 && host.split('.')[0] === '127') ||
    /^::ffff:127\./i.test(host)
  );
}

// Reads a body into one buffer, enforcing `limit` and, when `size` is known, the exact length.
// A known size is allocated once up front.
export async function readBounded(source: AsyncIterable<Uint8Array>, limit: number, size = -1): Promise<Buffer> {
  if (limit < 0 || size > limit || !Number.isSafeInteger(size)) throw new Error('storage response exceeds size limit');
  const pieces: Buffer[] = [];
  let total = 0;
  let empty = 0;
  const result = size >= 0 ? Buffer.allocUnsafe(size) : undefined;
  for await (const bytes of source) {
    // Stop after 100 empty reads in a row instead of spinning.
    if (!bytes.length) {
      if (++empty === 100) throw new Error('multiple Read calls return no data or error');
      continue;
    }
    empty = 0;
    total += bytes.length;
    if (total > limit) throw new Error('storage response exceeds size limit');
    if (size >= 0 && total > size) throw new Error("storage response length doesn't match");
    if (result) result.set(bytes, total - bytes.length);
    else pieces.push(Buffer.from(bytes));
  }
  if (size >= 0 && total !== size) throw new Error('unexpected EOF');
  return result ?? Buffer.concat(pieces, total);
}

interface HTTPResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

// Sends one HTTP request and reads at most `limit` bytes of response. Tests pass their own.
type Transport = (
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: Buffer | undefined,
  limit: number,
  signal?: AbortSignal,
) => Promise<HTTPResponse>;

// The real transport. The 5-minute timeout fires when the socket sits idle that long.
export const request: Transport = (url, method, headers, body, limit, signal) =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method, headers, signal, timeout: 5 * 60e3 }, async response => {
      try {
        const rawLength = response.headers['content-length'];
        const size = rawLength === undefined ? -1 : Number(rawLength);
        const bytes = await readBounded(response, limit, size);
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: bytes });
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(body);
  });

const sleep = async (ms: number, signal?: AbortSignal) => {
  await delay(ms, undefined, { signal });
};

// An error response from Permafrost. detail is the server's own message, when it sent one. 401 gets a
// message of its own, since it means the access key was refused.
export class APIError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public detail = '',
  ) {
    super(
      status === 401
        ? "permafrost didn't accept the access key" +
            (detail ? ': ' + detail : ', it may be wrong or expired') +
            ' (run `frost init` to set it up again)'
        : `permafrost: ${message} (${status} ${code})`,
    );
  }

  get unauthorized(): boolean {
    return this.status === 401;
  }
}

// Client for the Permafrost API in docs/PERMAFROST.md. Objects live at /v1/objects/<key> and every
// request carries the access key as a bearer token.
export class PermafrostBackend implements Backend {
  #base: URL;
  #token: string;

  // The server URL must be https, or http on a loopback host for local testing.
  constructor(
    base: string,
    token: string,
    private transport: Transport = request,
    private pause = sleep,
  ) {
    try {
      this.#base = new URL(base.replace(/\/$/, ''));
    } catch {
      throw new Error('permafrost: invalid url');
    }
    if (!this.#base.host || this.#base.username || this.#base.password || this.#base.search || this.#base.hash)
      throw new Error('permafrost: invalid url');
    if (this.#base.protocol !== 'https:' && !(this.#base.protocol === 'http:' && isLoopback(this.#base.hostname)))
      throw new Error('permafrost: url must use https');
    if (!token) throw new Error('permafrost: token is required');
    this.#token = token;
  }

  toString(): string {
    return permafrostName(this.#base.toString());
  }

  // The server plus a short hash of the token, so a different account is a different location
  // without the token itself being recorded.
  location(): string {
    return this.#base.toString().replace(/\/$/, '') + '#' + hash(this.#token).slice(0, 16);
  }

  #objectURL(key: string): URL {
    if (!validObjectKey(key)) throw new Error('permafrost: invalid object key');
    return new URL(this.#base.toString().replace(/\/$/, '') + '/v1/objects/' + key);
  }

  // Sends a request with up to four attempts. Transport errors, 429 and 5xx other than 507
  // (account full) retry after 0.5, 1 and 2 seconds, or after the server's Retry-After up to a
  // minute. Responses are capped at 16 MiB.
  async #do(
    method: string,
    url: URL,
    data?: Buffer,
    extra: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<HTTPResponse> {
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      signal?.throwIfAborted();
      let wait = 500 * 2 ** attempt;
      try {
        const headers = { authorization: 'Bearer ' + this.#token, 'user-agent': 'frost', ...extra };
        const response = await this.transport(url, method, headers, data, 16 << 20, signal);
        if (response.status >= 200 && response.status < 300) return response;

        // Use the JSON error body when there is one.
        let code = 'unknown';
        let detail = '';
        try {
          const decoded = JSON.parse(response.body.toString());
          if (typeof decoded.error?.code === 'string') code = decoded.error.code;
          if (typeof decoded.error?.message === 'string') detail = decoded.error.message.slice(0, 1000);
        } catch {
          /* Keep the HTTP error when the body isn't JSON. */
        }

        const message = detail || (http.STATUS_CODES[response.status] ?? 'unknown');
        const error = new APIError(response.status, code, message, detail);
        if (!(response.status === 429 || (response.status >= 500 && response.status !== 507))) throw error;
        last = error;
        const retry = response.headers['retry-after'];
        if (typeof retry === 'string' && /^\d+$/.test(retry)) wait = Math.min(Number(retry), 60) * 1000;
      } catch (error) {
        // The APIError thrown above lands here too, and is rethrown unless it can be retried. An
        // oversized response would only be downloaded again, so it isn't retried either.
        signal?.throwIfAborted();
        if (error instanceof APIError && !(error.status === 429 || (error.status >= 500 && error.status !== 507)))
          throw error;
        if (error instanceof Error && error.message.startsWith('storage response')) throw error;
        last = error;
      }
      if (attempt < 3) await this.pause(wait, signal);
    }
    throw last;
  }

  // x-content-sha256 lets the server reject a damaged upload.
  async put(key: string, data: Buffer, signal?: AbortSignal): Promise<void> {
    await this.#do(
      'PUT',
      this.#objectURL(key),
      data,
      {
        'content-type': 'application/octet-stream',
        'content-length': String(data.length),
        'x-content-sha256': hash(data),
      },
      signal,
    );
  }

  // A conditional create. 412 means the key already exists.
  async putNew(key: string, data: Buffer, signal?: AbortSignal): Promise<void> {
    try {
      await this.#do(
        'PUT',
        this.#objectURL(key),
        data,
        {
          'content-type': 'application/octet-stream',
          'content-length': String(data.length),
          'x-content-sha256': hash(data),
          'if-none-match': '*',
        },
        signal,
      );
    } catch (error) {
      if (error instanceof APIError && error.status === 412) throw errExists;
      throw error;
    }
  }

  // Checks the body against the server's x-content-sha256 when it sends one.
  async #download(key: string, signal?: AbortSignal): Promise<Buffer> {
    let response: HTTPResponse;
    try {
      response = await this.#do('GET', this.#objectURL(key), undefined, {}, signal);
    } catch (error) {
      if (error instanceof APIError && error.status === 404) throw errNotFound;
      throw error;
    }
    const checksum = response.headers['x-content-sha256'];
    if (checksum && hash(response.body) !== checksum)
      throw new Error(`permafrost get ${key}: body doesn't match its checksum`);
    return response.body;
  }

  async get(key: string, signal?: AbortSignal): Promise<Buffer> {
    return this.#download(key, signal);
  }

  // The real transport already returns a fresh buffer. A test transport might keep its own, so
  // it gets a copy.
  async getOwned(key: string, signal?: AbortSignal): Promise<Buffer> {
    const data = await this.#download(key, signal);
    return this.transport === request ? data : Buffer.from(data);
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.#do('DELETE', this.#objectURL(key), undefined, {}, signal);
    } catch (error) {
      if (!(error instanceof APIError && error.status === 404)) throw error;
    }
  }

  // Pages through keys with a cursor. Every key must be valid and inside the prefix, and a
  // repeated cursor stops a server that would loop forever.
  async list(prefix: string, signal?: AbortSignal): Promise<string[]> {
    const result: string[] = [];
    const seen = new Set<string>();
    let cursor = '';
    do {
      const url = new URL(this.#base.toString().replace(/\/$/, '') + '/v1/objects');
      url.searchParams.set('prefix', prefix);
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await this.#do('GET', url, undefined, {}, signal);
      const page = JSON.parse(response.body.toString()) as { keys?: unknown; next_cursor?: unknown };
      if (
        !Array.isArray(page.keys) ||
        !page.keys.every(k => typeof k === 'string' && validObjectKey(k) && k.startsWith(prefix))
      )
        throw new Error('permafrost list: invalid keys');
      if (page.next_cursor !== undefined && typeof page.next_cursor !== 'string')
        throw new Error('permafrost list: invalid cursor');
      result.push(...page.keys);
      cursor = (page.next_cursor as string) ?? '';
      if (cursor && seen.has(cursor)) throw new Error('permafrost list: repeated cursor');
      seen.add(cursor);
    } while (cursor);
    return result;
  }

  // Reads /v1/usage. Sizes must be whole byte counts.
  async usage(signal?: AbortSignal): Promise<Usage> {
    const url = new URL(this.#base.toString().replace(/\/$/, '') + '/v1/usage');
    const response = await this.#do('GET', url, undefined, {}, signal);
    const body = JSON.parse(response.body.toString()) as Record<string, unknown>;
    const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : -1);
    const used = count(body.used_bytes);
    const quota = count(body.quota_bytes);
    if (used < 0 || quota < 0) throw new Error('permafrost usage: invalid sizes');
    return {
      used,
      quota,
      readOnly: body.read_only === true,
      message: typeof body.message === 'string' ? body.message.slice(0, 1000) : '',
    };
  }
}

// Field names match the [storage.s3] settings in config.toml.
export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  access_key_id: string;
  secret_access_key: string;
  insecure: boolean;
}

// SigV4 percent-encoding. encodeURIComponent leaves !'()* alone, so those are encoded here too.
function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

// Signs a request with AWS Signature Version 4 and returns the headers to send. The body's
// SHA-256 is always signed, so S3 checks the payload as well.
export function signV4(
  method: string,
  url: URL,
  headers: Record<string, string>,
  data: Buffer | undefined,
  region: string,
  accessKey: string,
  secretKey: string,
  now = new Date(),
): Record<string, string> {
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, ''),
    day = date.slice(0, 8),
    scope = `${day}/${region}/s3/aws4_request`;
  const signed: Record<string, string> = {
    ...headers,
    host: url.host,
    'x-amz-content-sha256': hash(data ?? Buffer.alloc(0)),
    'x-amz-date': date,
  };

  // Signed headers are lowercased and sorted, with runs of spaces collapsed. Query pairs sort by
  // encoded name, then value. user-agent and accept-encoding stay unsigned.
  const keys = Object.keys(signed)
    .map(k => k.toLowerCase())
    .filter(k => !['user-agent', 'accept-encoding', 'authorization'].includes(k))
    .sort();
  const canonicalHeaders = keys.map(k => `${k}:${signed[k].trim().replace(/\s+/g, ' ')}\n`).join('');
  const query = [...url.searchParams]
    .map(([key, value]) => [awsEncode(key), awsEncode(value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(pair => pair.join('='))
    .join('&');
  const canonical = [
    method,
    url.pathname,
    query,
    canonicalHeaders,
    keys.join(';'),
    signed['x-amz-content-sha256'],
  ].join('\n');

  // The signing key chains HMACs over the day, region, service and request type.
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secretKey, day), region), 's3'), 'aws4_request');
  signed.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${keys.join(';')}, Signature=${hmac(signingKey, `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`).toString('hex')}`;
  return signed;
}

class S3Error extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(`s3: ${message} (${status} ${code})`);
  }
}

// Returns the text of every <tag> element in an S3 response, with any namespace prefix. It's a
// small regex reader, so DOCTYPE and ENTITY declarations are refused instead of expanded. CDATA
// is unwrapped, and the predefined and numeric character references are decoded.
function xmlText(xml: string, tag: string): string[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('s3: XML declarations are unsupported');
  const pattern = new RegExp(
    `<(?:(?:[a-zA-Z_][\\w.-]*):)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:[a-zA-Z_][\\w.-]*):)?${tag}\\s*>`,
    'g',
  );
  return [...xml.matchAll(pattern)].map(match =>
    match[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, text: string) => text)
      .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, entity: string) =>
        entity[0] === '#'
          ? String.fromCodePoint(entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)))
          : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity]!,
      ),
  );
}

// Checks that the body ends with a complete <root> element, so a cut-off or unrelated body isn't
// read as an empty listing.
function checkXML(xml: string, root: string): void {
  const name = `(?:(?:[a-zA-Z_][\\w.-]*):)?${root}`;
  if (!new RegExp(`<${name}(?:\\s[^>]*)?(?:\\s*\\/>|>[\\s\\S]*<\\/${name}\\s*>)\\s*$`).test(xml.trim()))
    throw new Error('s3: invalid XML response');
}

// Client for S3-compatible storage, using path-style URLs. Keys live under the configured folder
// prefix. The prefix isn't part of the sealed object key, so a repository can move between folders.
export class S3Backend implements Backend {
  #base: URL;
  #prefix: string;
  #region: string;
  #regionPending?: Promise<void>;

  // An endpoint without a scheme gets https, or http when `insecure` is set. The endpoint must be
  // a bare host, and a prefix is kept with one trailing slash.
  constructor(
    private config: S3Config,
    private transport: Transport = request,
    private pause = sleep,
  ) {
    const raw = config.endpoint.includes('://')
      ? config.endpoint
      : `${config.insecure ? 'http' : 'https'}://${config.endpoint}`;
    try {
      this.#base = new URL(raw);
    } catch {
      throw new Error('s3: endpoint and bucket are required');
    }
    if (!config.endpoint || !config.bucket) throw new Error('s3: endpoint and bucket are required');
    if (
      !['https:', 'http:'].includes(this.#base.protocol) ||
      this.#base.username ||
      this.#base.password ||
      this.#base.pathname !== '/' ||
      this.#base.search ||
      this.#base.hash
    )
      throw new Error('s3: endpoint must be an http or https host URL without credentials, a path, query or fragment');
    this.#prefix = config.prefix.replace(/^\/+|\/+$/g, '');
    if (this.#prefix) this.#prefix += '/';
    this.#region = config.region;
  }

  toString(): string {
    return `s3://${this.config.bucket}/${this.#prefix}`;
  }

  // Includes the endpoint host, so the same bucket name at another provider is another location.
  location(): string {
    return `s3://${this.#base.host.toLowerCase()}/${this.config.bucket}/${this.#prefix}`;
  }

  // Path-style URL, /<bucket>/<key>, with each key segment encoded.
  #url(key = ''): URL {
    return new URL(`/${awsEncode(this.config.bucket)}/${key.split('/').map(awsEncode).join('/')}`, this.#base);
  }

  // With no region configured, asks the bucket for its location once. Concurrent callers share
  // the lookup, and a failed lookup is tried again by the next call. An empty answer means
  // us-east-1, and EU is the old name for eu-west-1.
  async #regionReady(signal?: AbortSignal): Promise<void> {
    if (this.#region) return;
    if (!this.#regionPending)
      this.#regionPending = (async () => {
        const url = this.#url();
        url.searchParams.set('location', '');
        const response = await this.#request('GET', url, undefined, {}, maxObjectSize, signal, 'us-east-1');
        const found = xmlText(response.body.toString(), 'LocationConstraint')[0] ?? '';
        this.#region = found === 'EU' ? 'eu-west-1' : found || 'us-east-1';
      })().catch(error => {
        this.#regionPending = undefined;
        throw error;
      });
    await this.#regionPending;
  }

  // Signs and sends a request with up to four attempts. A redirect to another region switches
  // regions and retries at once. 429, 5xx and network errors retry after 0.5, 1 and 2 seconds;
  // definite answers and oversized responses don't.
  async #request(
    method: string,
    url: URL,
    body: Buffer | undefined,
    extra: Record<string, string>,
    limit: number,
    signal?: AbortSignal,
    region = this.#region,
  ): Promise<HTTPResponse> {
    let last: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      signal?.throwIfAborted();
      try {
        // Without credentials, requests go unsigned.
        const unsigned = { 'user-agent': 'frost', ...extra };
        const headers =
          this.config.access_key_id && this.config.secret_access_key
            ? signV4(
                method,
                url,
                unsigned,
                body,
                region || 'us-east-1',
                this.config.access_key_id,
                this.config.secret_access_key,
              )
            : unsigned;
        const response = await this.transport(url, method, headers, body, limit, signal);
        if (response.status >= 200 && response.status < 300) return response;

        const xml = response.body.toString();
        const code = xmlText(xml, 'Code')[0] ?? 'Unknown';
        const message = xmlText(xml, 'Message')[0] ?? http.STATUS_CODES[response.status] ?? 'request failed';
        const error = new S3Error(response.status, code, message);

        // The bucket lives in another region. Switch to it and retry straight away.
        const advertised = response.headers['x-amz-bucket-region'] ?? xmlText(xml, 'Region')[0];
        if (
          (response.status === 301 || code === 'AuthorizationHeaderMalformed') &&
          typeof advertised === 'string' &&
          advertised &&
          advertised !== region
        ) {
          this.#region = advertised;
          region = advertised;
          last = error;
          continue;
        }

        // Only a missing key is errNotFound. A missing bucket stays an S3Error.
        if (response.status === 404 && (code === 'NoSuchKey' || code === 'NotFound')) throw errNotFound;
        if (response.status === 412) throw errExists;
        // 501 on a conditional create means the provider doesn't support If-None-Match.
        if (response.status === 501 && extra['if-none-match'] === '*') throw errConditionalUnsupported;
        if (!(response.status === 429 || response.status >= 500)) throw error;
        last = error;
      } catch (error) {
        signal?.throwIfAborted();
        if (
          error instanceof S3Error ||
          error === errNotFound ||
          error === errExists ||
          error === errConditionalUnsupported ||
          (error instanceof Error && error.message.startsWith('storage response'))
        )
          throw error;
        last = error;
      }
      if (attempt < 3) await this.pause(500 * 2 ** attempt, signal);
    }
    throw last;
  }

  async put(key: string, data: Buffer, signal?: AbortSignal): Promise<void> {
    await this.#regionReady(signal);
    await this.#request(
      'PUT',
      this.#url(this.#prefix + key),
      data,
      { 'content-type': 'application/octet-stream', 'content-length': String(data.length) },
      maxObjectSize,
      signal,
    );
  }

  // If-None-Match: * makes the create conditional, and #request turns 412 into errExists.
  async putNew(key: string, data: Buffer, signal?: AbortSignal): Promise<void> {
    await this.#regionReady(signal);
    await this.#request(
      'PUT',
      this.#url(this.#prefix + key),
      data,
      { 'content-type': 'application/octet-stream', 'content-length': String(data.length), 'if-none-match': '*' },
      maxObjectSize,
      signal,
    );
  }

  // Chunk downloads are capped at the largest sealed chunk, 8 MiB plus overhead. Other objects
  // can reach maxObjectSize.
  async #download(key: string, signal?: AbortSignal): Promise<Buffer> {
    await this.#regionReady(signal);
    return (
      await this.#request(
        'GET',
        this.#url(this.#prefix + key),
        undefined,
        {},
        key.startsWith('chunks/') ? maxChunkSize : maxObjectSize,
        signal,
      )
    ).body;
  }

  async get(key: string, signal?: AbortSignal): Promise<Buffer> {
    return this.#download(key, signal);
  }

  // The real transport already returns a fresh buffer. A test transport might keep its own, so
  // it gets a copy.
  async getOwned(key: string, signal?: AbortSignal): Promise<Buffer> {
    const data = await this.#download(key, signal);
    return this.transport === request ? data : Buffer.from(data);
  }

  async delete(key: string, signal?: AbortSignal): Promise<void> {
    await this.#regionReady(signal);
    try {
      await this.#request('DELETE', this.#url(this.#prefix + key), undefined, {}, maxObjectSize, signal);
    } catch (error) {
      if (error !== errNotFound) throw error;
    }
  }

  // ListObjectsV2 with URL-encoded keys. A key outside the prefix is an error, and the folder
  // prefix is stripped from the results.
  async list(prefix: string, signal?: AbortSignal): Promise<string[]> {
    await this.#regionReady(signal);
    const result: string[] = [];
    const seen = new Set<string>();
    let cursor = '';
    do {
      const url = this.#url();
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', this.#prefix + prefix);
      url.searchParams.set('encoding-type', 'url');
      if (cursor) url.searchParams.set('continuation-token', cursor);
      const response = await this.#request('GET', url, undefined, {}, maxObjectSize, signal);
      const xml = response.body.toString();
      checkXML(xml, 'ListBucketResult');
      const encoded = xmlText(xml, 'EncodingType')[0] === 'url';
      for (const rawKey of xmlText(xml, 'Key')) {
        const key = encoded ? decodeURIComponent(rawKey) : rawKey;
        if (!key.startsWith(this.#prefix + prefix)) throw new Error('s3 list: invalid key prefix');
        result.push(key.slice(this.#prefix.length));
      }
      if (xmlText(xml, 'IsTruncated')[0] !== 'true') break;
      cursor = xmlText(xml, 'NextContinuationToken')[0] ?? '';
      if (!cursor || seen.has(cursor)) throw new Error('s3 list: repeated or missing cursor');
      seen.add(cursor);
    } while (cursor);
    return result;
  }
}
