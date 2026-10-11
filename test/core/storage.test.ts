// Tests for the storage clients against small reference servers on loopback: bounded reads,
// the Permafrost and S3 backends and SigV4 signing.
// Keep the Permafrost server here in step with docs/PERMAFROST.md.

import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import {
  APIError,
  PermafrostBackend,
  S3Backend,
  readBounded,
  hash,
  signV4,
  errExists,
  errNotFound,
  errConditionalUnsupported,
  type Backend,
  type S3Config,
} from '../../src/core/storage.js';

// Starts an HTTP server on a random loopback port and returns its base URL. Handler errors become
// 500 responses, and the server closes when the test ends.
async function server(
  t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const service = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(error => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    service.closeAllConnections();
    service.close();
  });
  const address = service.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  return `http://127.0.0.1:${address.port}`;
}

// Checks what every backend must do. Conditional creation has exactly one winner, missing objects
// give errNotFound, owned downloads are independent, listing filters by prefix and deletes repeat safely.
async function conformance(backend: Backend): Promise<void> {
  await backend.putNew('conditional', Buffer.from('first'));
  await assert.rejects(backend.putNew('conditional', Buffer.from('second')), error => error === errExists);
  assert.equal((await backend.get('conditional')).toString(), 'first');
  await backend.delete('conditional');

  const creations = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => backend.putNew('concurrent-create', Buffer.from('writer ' + i))),
  );
  assert.equal(creations.filter(result => result.status === 'fulfilled').length, 1);
  await backend.delete('concurrent-create');
  await assert.rejects(backend.get('missing/key'), error => error === errNotFound);

  for (const name of ['chunks/ab/ab01', 'chunks/ab/ab02', 'chunks/cd/cd01', 'snapshots/one'])
    await backend.put(name, Buffer.from('encrypted bytes\0\x01\x02'));

  // Wiping an owned buffer mustn't affect the next download of the same object.
  if (backend.getOwned) {
    const owned = await backend.getOwned('chunks/ab/ab01');
    owned.fill(0);
    assert.equal((await backend.getOwned('chunks/ab/ab01')).toString(), 'encrypted bytes\0\x01\x02');
  }

  assert.deepEqual((await backend.list('chunks/')).sort(), ['chunks/ab/ab01', 'chunks/ab/ab02', 'chunks/cd/cd01']);
  await backend.delete('chunks/ab/ab02');
  await backend.delete('chunks/ab/ab02');
  await assert.rejects(backend.get('chunks/ab/ab02'), error => error === errNotFound);
  assert.equal((await backend.list('')).length, 3);
}

test('bounded responses enforce declared and unknown size and preserve read errors', async () => {
  async function* bytes(content: string) {
    yield Buffer.from(content);
  }
  assert.equal((await readBounded(bytes('abcd'), 4, 4)).toString(), 'abcd');
  assert.equal((await readBounded(bytes('abcd'), 4)).toString(), 'abcd');

  // Longer or shorter than declared, a declared size over the limit, and an undeclared body
  // that runs past the limit.
  for (const [body, size, limit] of [
    ['abcde', 4, 8],
    ['abc', 4, 8],
    ['abcd', 4, 3],
    ['abcde', -1, 4],
  ] as const)
    await assert.rejects(readBounded(bytes(body), limit, size));

  async function* failed() {
    yield Buffer.from('data');
    throw new Error('body checksum failure');
  }
  await assert.rejects(readBounded(failed(), 8, 4), /body checksum failure/);
});

// The transport always returns the same buffer, like a response cache would. getOwned must copy
// it so wiping the result can't damage the shared one.
test('HTTP backend owned downloads copy buffers from a custom transport', async () => {
  const cached = Buffer.alloc(1 << 20, 97);
  const transport = async () => ({ status: 200, headers: {}, body: cached });
  const adapters = [
    new PermafrostBackend('http://127.0.0.1', 'test', transport),
    new S3Backend(
      {
        endpoint: 'http://127.0.0.1',
        region: 'us-east-1',
        bucket: 'test',
        prefix: '',
        access_key_id: '',
        secret_access_key: '',
        insecure: true,
      },
      transport,
    ),
  ];
  for (const backend of adapters) {
    const first = await backend.getOwned('chunks/ab/test');
    assert.notEqual(first, cached);
    assert.deepEqual(first, cached);
    first.fill(0);
    assert.ok(cached.equals(Buffer.alloc(cached.length, 97)));
    assert.deepEqual(await backend.getOwned('chunks/ab/test'), cached);
  }
});

test('Permafrost reference server contract, retries and paginated conformance', async t => {
  const objects = new Map<string, Buffer>();
  let failNext = 0;
  let requests = 0;
  let readOnly = false;
  const quota = 1000;
  const used = () => [...objects.values()].reduce((sum, data) => sum + data.length, 0);
  const refuse = (res: ServerResponse, status: number, code: string, message: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code, message } }));
  };

  // Answers 503 while failNext is positive, checks the bearer token and the upload checksum, honours
  // If-None-Match for conditional creation, enforces a 1000-byte quota and read-only mode, reports
  // usage and pages listings two keys at a time.
  const endpoint = await server(t, async (req, res) => {
    requests++;
    if (failNext > 0) {
      failNext--;
      res.writeHead(503, { 'Retry-After': '0' });
      res.end('{"error":{"code":"unavailable","message":"try again"}}');
      return;
    }
    if (req.headers.authorization !== 'Bearer tok') {
      res.writeHead(401);
      res.end('{"error":{"code":"unauthorized","message":"bad token"}}');
      return;
    }

    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/v1/usage') {
      const message = readOnly ? 'uploads are paused' : used() >= quota * 0.9 ? 'storage is 90% full' : '';
      res.end(JSON.stringify({ used_bytes: used(), quota_bytes: quota, read_only: readOnly, message }));
      return;
    }
    if (url.pathname === '/v1/objects') {
      const keys = [...objects.keys()].filter(key => key.startsWith(url.searchParams.get('prefix') ?? '')).sort();
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const end = Math.min(start + 2, keys.length);
      res.end(JSON.stringify({ keys: keys.slice(start, end), next_cursor: end < keys.length ? String(end) : '' }));
      return;
    }

    const key = url.pathname.slice('/v1/objects/'.length);
    if (req.method === 'PUT') {
      const data = await readBounded(req, 16 << 20);
      if (req.headers['x-content-sha256'] !== hash(data)) {
        res.writeHead(400);
        res.end();
        return;
      }
      if (req.headers['if-none-match'] === '*' && objects.has(key)) {
        res.writeHead(412);
        res.end();
        return;
      }
      if (readOnly) return refuse(res, 403, 'read_only', 'uploads are paused');
      if (used() - (objects.get(key)?.length ?? 0) + data.length > quota)
        return refuse(res, 507, 'quota_exceeded', 'this upload would go over 1000 bytes');
      objects.set(key, data);
      res.writeHead(204);
      res.end();
    } else if (req.method === 'GET') {
      const data = objects.get(key);
      if (!data) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'X-Content-SHA256': hash(data) });
      res.end(data);
    } else {
      objects.delete(key);
      res.writeHead(204);
      res.end();
    }
  });

  // The last argument replaces the retry pause so the test doesn't wait.
  const backend = new PermafrostBackend(endpoint, 'tok', undefined, async () => {});
  await conformance(backend);

  // Two failures then success takes three requests. Constant failure gives up after four.
  failNext = 2;
  const before = requests;
  await backend.put('retry', Buffer.from('x'));
  assert.equal(requests - before, 3);
  failNext = 10;
  const failed = requests;
  await assert.rejects(
    backend.put('give-up', Buffer.from('x')),
    error => error instanceof APIError && error.status === 503,
  );
  assert.equal(requests - failed, 4);

  // A bad token fails at once without retries, with the server's reason. The location includes a token
  // hash, so the two differ.
  failNext = 0;
  const bad = new PermafrostBackend(endpoint, 'bad');
  const count = requests;
  await assert.rejects(
    bad.get('a'),
    error => error instanceof APIError && error.unauthorized && /accept the access key: bad token/.test(error.message),
  );
  assert.equal(requests - count, 1);
  assert.notEqual(bad.location(), backend.location());

  // Usage reports sizes and the server's message. A full account and a read-only one refuse uploads at
  // once, with the server's reason.
  for (const key of await backend.list('')) await backend.delete(key);
  assert.deepEqual(await backend.usage(), { used: 0, quota: 1000, readOnly: false, message: '' });
  await backend.put('big', Buffer.alloc(950));
  assert.deepEqual(await backend.usage(), { used: 950, quota: 1000, readOnly: false, message: 'storage is 90% full' });
  const full = requests;
  await assert.rejects(
    backend.put('more', Buffer.alloc(100)),
    error =>
      error instanceof APIError && error.status === 507 && error.detail === 'this upload would go over 1000 bytes',
  );
  assert.equal(requests - full, 1);
  readOnly = true;
  await assert.rejects(
    backend.put('small', Buffer.from('x')),
    error => error instanceof APIError && error.code === 'read_only' && /uploads are paused/.test(error.message),
  );
  assert.equal((await backend.usage()).readOnly, true);
  assert.deepEqual(await backend.get('big'), Buffer.alloc(950));
});

test('Permafrost usage rejects sizes that are not whole byte counts', async t => {
  for (const body of ['{"used_bytes":-1,"quota_bytes":0}', '{"used_bytes":1.5,"quota_bytes":0}', '{"quota_bytes":0}']) {
    const endpoint = await server(t, (_req, res) => {
      res.end(body);
    });
    await assert.rejects(new PermafrostBackend(endpoint, 'tok').usage(), /invalid sizes/);
  }
});

test('Permafrost refuses redirects, remote HTTP, URL credentials, cursor cycles and checksum damage', async t => {
  for (const url of [
    'http://example.com',
    'https://user:pass@example.com',
    'https://example.com?a=1',
    'https://example.com#x',
    'ftp://example.com',
  ])
    assert.throws(() => new PermafrostBackend(url, 'test'));

  // Following a redirect would send the token to another server, so the target must never be hit.
  let destination = 0;
  const target = await server(t, (_, res) => {
    destination++;
    res.end('no');
  });
  const redirect = await server(t, (_, res) => {
    res.writeHead(307, { Location: target });
    res.end();
  });
  await assert.rejects(new PermafrostBackend(redirect, 'secret').get('frost.repo'));
  assert.equal(destination, 0);

  const cycle = await server(t, (_, res) => {
    res.end('{"keys":["a"],"next_cursor":"again"}');
  });
  await assert.rejects(new PermafrostBackend(cycle, 'test').list(''), /repeated cursor/);

  const damaged = await server(t, (_, res) => {
    res.setHeader('X-Content-SHA256', '0'.repeat(64));
    res.end('data');
  });
  await assert.rejects(new PermafrostBackend(damaged, 'test').get('a'), /checksum/);

  // An oversized response would only be downloaded again, so it fails after one request.
  let oversized = 0;
  const large = await server(t, (_, res) => {
    oversized++;
    res.writeHead(200, { 'Content-Length': String((16 << 20) + 1) });
    res.end();
  });
  await assert.rejects(new PermafrostBackend(large, 'test', undefined, async () => {}).get('a'), /size limit/);
  assert.equal(oversized, 1);
});

// The fixture's date is in SigV4's compact form (YYYYMMDDTHHMMSSZ), so it's expanded to ISO first.
test('SigV4 matches the existing MinIO signer golden request', () => {
  const fixture = JSON.parse(
    readFileSync(new URL('../../../test/fixtures/core/repository.json', import.meta.url), 'utf8'),
  ).sigv4;
  const date = fixture.date as string;
  const now = new Date(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
  );
  const signed = signV4(
    'GET',
    new URL(fixture.url),
    { range: 'bytes=0-9' },
    undefined,
    'us-east-1',
    'example-access',
    'example-secret',
    now,
  );
  assert.equal(signed.authorization, fixture.authorization);
});

test('S3 reference server conditional writes, signed paths, list pagination and conformance', async t => {
  const objects = new Map<string, Buffer>();
  const xml = (value: string) => value.replaceAll('&', '&amp;');

  // A path-style S3 server. Every request must be signed, and ListObjectsV2 pages two keys at a time.
  const endpoint = await server(t, async (req, res) => {
    assert.match(req.headers.authorization ?? '', /^AWS4-HMAC-SHA256 Credential=access\//);
    assert.ok(req.headers['x-amz-date']);
    const url = new URL(req.url!, 'http://localhost');
    const key = decodeURIComponent(url.pathname.slice('/bucket/'.length));
    if (url.searchParams.has('list-type')) {
      const keys = [...objects.keys()].filter(k => k.startsWith(url.searchParams.get('prefix') ?? '')).sort();
      const start = Number(url.searchParams.get('continuation-token') ?? 0);
      const end = Math.min(keys.length, start + 2);
      res.end(
        `<ListBucketResult><IsTruncated>${end < keys.length}</IsTruncated>${keys
          .slice(start, end)
          .map(k => `<Contents><Key>${xml(k)}</Key></Contents>`)
          .join(
            '',
          )}${end < keys.length ? `<NextContinuationToken>${end}</NextContinuationToken>` : ''}</ListBucketResult>`,
      );
      return;
    }

    if (req.method === 'PUT') {
      const data = await readBounded(req, 16 << 20);
      assert.equal(req.headers['x-amz-content-sha256'], hash(data));
      if (req.headers['if-none-match'] === '*' && objects.has(key)) {
        res.writeHead(412);
        res.end('<Error><Code>PreconditionFailed</Code><Message>exists</Message></Error>');
        return;
      }
      objects.set(key, data);
      res.writeHead(200);
      res.end();
    } else if (req.method === 'GET') {
      const data = objects.get(key);
      if (!data) {
        res.writeHead(404);
        res.end('<Error><Code>NoSuchKey</Code></Error>');
        return;
      }
      res.end(data);
    } else {
      objects.delete(key);
      res.writeHead(204);
      res.end();
    }
  });

  const config: S3Config = {
    endpoint,
    region: 'us-east-1',
    bucket: 'bucket',
    prefix: 'backups/',
    access_key_id: 'access',
    secret_access_key: 'secret',
    insecure: false,
  };
  const backend = new S3Backend(config);
  await conformance(backend);
  assert.equal(backend.toString(), 's3://bucket/backups/');
  assert.ok(backend.location().includes('127.0.0.1:'));
});

test('S3 download limits and unsupported conditional creation fail closed', async t => {
  const config = (endpoint: string): S3Config => ({
    endpoint,
    region: 'us-east-1',
    bucket: 'bucket',
    prefix: '',
    access_key_id: 'access',
    secret_access_key: 'secret',
    insecure: false,
  });

  // A server that can't do If-None-Match must not be treated as if the create succeeded.
  const unsupported = await server(t, (_, res) => {
    res.writeHead(501);
    res.end('<Error><Code>NotImplemented</Code></Error>');
  });
  await assert.rejects(
    new S3Backend(config(unsupported)).putNew('frost.repo', Buffer.from('x')),
    error => error === errConditionalUnsupported,
  );

  // Chunk downloads are capped at 8 MiB plus 64 bytes, so a declared length one byte over is refused.
  const large = await server(t, (_, res) => {
    res.writeHead(200, { 'Content-Length': String((8 << 20) + 65) });
    res.end();
  });
  await assert.rejects(new S3Backend(config(large)).get('chunks/aa/test'), /size limit/);
  for (const endpoint of ['https://user:pass@example.com', 'https://example.com/path', 'https://example.com?a=1'])
    assert.throws(() => new S3Backend(config(endpoint)));
});
