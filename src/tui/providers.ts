// These are the kinds of storage the setup wizard offers. Each provider lists the questions setup asks, and
// converts the answers to and from the storage section of the config. choices groups them into the list setup
// shows first, where S3-compatible opens a second list of S3 services.

import path from 'node:path';
import type { Storage } from './types.js';
import type { Field } from './input.js';
import { expand } from '../core/config.js';
import { permafrostName } from '../core/storage.js';

export const projectLink = 'getfro.st';

// Setup asks a provider's fields in order. read and apply use that same order, and match
// tells whether a config already points at this provider.
interface Provider {
  name: string;
  note?: string;
  fields: Field[];
  read(s: Storage): string[];
  apply(v: string[], s: Storage): void;
  match(s: Storage): boolean;
}

// Field checks return a message to show, or '' when the value looks fine.

const noSpaces =
  (name: string) =>
  (v: string): string =>
    /[ \t]/.test(v) ? 'The ' + name + ' has no spaces in it. Check you copied just the ' + name + '.' : '';

const checkRegion = (v: string): string =>
  /^[a-z]{2}(-[a-z]+)+-[0-9]+$/.test(v) ? '' : 'Regions look like us-east-1 or eu-central-1.';

const checkAccountID = (v: string): string =>
  /^[0-9a-fA-F]{32}$/.test(v) ? '' : 'An account ID is 32 letters and numbers. Copy it from the R2 overview page.';

const checkBucket = (v: string): string =>
  Buffer.byteLength(v) < 3 || Buffer.byteLength(v) > 63 || /[ /\t]/.test(v)
    ? 'Bucket names are 3 to 63 characters, with no spaces or slashes.'
    : '';

// Accepts a host, with or without a scheme, but no path. A bare host is read as https.
function checkEndpoint(v: string): string {
  if (/[ \t]/.test(v)) return 'The endpoint has no spaces in it.';
  try {
    const u = new URL(v.includes('://') ? v : 'https://' + v);
    if (!u.host || u.pathname.replaceAll('/', '')) throw new Error();
    return '';
  } catch {
    return 'Type just the host name, like s3.example.com.';
  }
}

// Returns a URL's host, or the value unchanged when it isn't a full URL.
function hostOf(v: string): string {
  try {
    return new URL(v).host || v;
  } catch {
    return v;
  }
}

// Tells whether an endpoint's host name is domain or one of its subdomains. A bare host is read as https.
// The domain appearing anywhere else in the address doesn't count.
function onDomain(endpoint: string, domain: string): boolean {
  try {
    const host = new URL(endpoint.includes('://') ? endpoint : 'https://' + endpoint).hostname;
    return host === domain || host.endsWith('.' + domain);
  } catch {
    return false;
  }
}

function checkB2Endpoint(v: string): string {
  return (
    checkEndpoint(v) ||
    (hostOf(v).replace(/\/$/, '').endsWith('.backblazeb2.com')
      ? ''
      : "That doesn't look right. Make sure you're entering the endpoint correctly.")
  );
}

// Reads the region from hosts like s3.us-west-004.backblazeb2.com.
function regionFromEndpoint(v: string): string {
  const p = hostOf(v).split('.');
  return p.length >= 3 && p[0] === 's3' ? p[1] : '';
}

// Writes the settings every S3-compatible provider shares.
function s3(s: Storage, endpoint: string, region: string, bucket: string, id: string, secret: string): void {
  s.backend = 's3';
  Object.assign(s.s3, {
    endpoint: endpoint.replace(/\/$/, ''),
    region,
    bucket,
    access_key_id: id,
    secret_access_key: secret,
  });
}

// The S3 providers all end with the same bucket, key ID and secret questions. Fields are shared
// between providers, so setup copies them before filling them in.
const fBucket: Field = {
  question: "What's the bucket called?",
  help: 'Its name, exactly as you created it.',
  name: 'bucket name',
  about: 'bucket',
  check: checkBucket,
};

const access = (question: string, name: string, about: string, help: string, secret = false): Field => ({
  question,
  name,
  about,
  help,
  secret,
  check: noSpaces(name),
});

const readKeys = (s: Storage) => [s.s3.bucket, s.s3.access_key_id, s.s3.secret_access_key];

// Splits an SSH address into its host and port: me@nas.local:2222, me@[fe80::1]:2222, or a bare host or alias
// with no port. An IPv6 address without brackets has no port.
export function splitAddress(v: string): { host: string; port: number } {
  const bracketed = /^(.*@)?\[([^\]]+)\](?::(\d+))?$/.exec(v);
  if (bracketed) return { host: (bracketed[1] ?? '') + bracketed[2], port: Number(bracketed[3] ?? 0) };
  const m = /^([^:]+):(\d+)$/.exec(v);
  return m ? { host: m[1], port: Number(m[2]) } : { host: v, port: 0 };
}

// The address as setup shows it again, with the port when there is one.
export function joinAddress(host: string, port: number): string {
  if (!port) return host;
  const at = host.lastIndexOf('@');
  return host.slice(at + 1).includes(':')
    ? host.slice(0, at + 1) + '[' + host.slice(at + 1) + ']:' + port
    : host + ':' + port;
}

export function checkAddress(v: string): string {
  const { host, port } = splitAddress(v);
  if (/[ \t]/.test(v)) return 'The address has no spaces in it.';
  if (host.startsWith('-') || !/^[A-Za-z0-9._%+:@-]+$/.test(host)) return 'Type a host, like me@nas.local or nas.';
  if (port > 65535 || (port === 0 && /:0+$/.test(v))) return 'Ports go from 1 to 65535.';
  return '';
}

const checkFolder = (v: string): string =>
  /[\x00-\x1f]/.test(v) || v === '~' ? 'Type a folder, like frost or /srv/backups/frost.' : '';

// The placeholder shows a drive path in this system's style.
const drivePath =
  process.platform === 'win32'
    ? 'E:\\frost'
    : process.platform === 'darwin'
      ? '/Volumes/Backup/frost'
      : '/mnt/backup/frost';

export const checkDrivePath = (v: string): string =>
  path.isAbsolute(expand(v)) ? '' : 'Type a full path, like ' + drivePath + '.';

// Setup treats index 0 as Permafrost. Other S3-compatible comes after the named S3 services because it matches
// any S3 config, so they have to be tried first.
export const providers: Provider[] = [
  {
    name: 'Permafrost',
    note: 'recommended',
    fields: [
      {
        question: 'Paste your Permafrost access key.',
        secret: true,
        name: 'access key',
        about: 'key',
        check: noSpaces('access key'),
      },
    ],
    read: s => [s.permafrost.token],
    apply: (v, s) => {
      s.backend = 'permafrost';
      s.permafrost.token = v[0];
    },
    match: s => s.backend === 'permafrost',
  },
  {
    name: 'Amazon S3',
    fields: [
      {
        question: 'Which region is the bucket in?',
        help: 'E.g. us-east-1.',
        name: 'region',
        about: 'address',
        check: checkRegion,
      },
      fBucket,
      access(
        'Paste the access key ID.',
        'access key ID',
        'key',
        'IAM > Users > your user > Security credentials > Create access key.',
      ),
      access(
        'Paste the secret access key.',
        'secret access key',
        'secret',
        'Shown once, next to the access key ID.',
        true,
      ),
    ],
    read: s => [s.s3.region, ...readKeys(s)],
    apply: (v, s) => s3(s, 's3.' + v[0] + '.amazonaws.com', v[0], v[1], v[2], v[3]),
    match: s => s.backend === 's3' && onDomain(s.s3.endpoint, 'amazonaws.com'),
  },
  {
    name: 'Backblaze B2',
    fields: [
      {
        question: "What's the bucket's endpoint?",
        help: 'Buckets > your bucket > Endpoint. E.g. s3.us-west-004.backblazeb2.com.',
        name: 'endpoint',
        about: 'address',
        check: checkB2Endpoint,
      },
      fBucket,
      access(
        "Paste the application key's keyID.",
        'keyID',
        'key',
        'Application Keys > Add a New Application Key. Limit it to this bucket.',
      ),
      access(
        'Paste the applicationKey.',
        'applicationKey',
        'secret',
        'Shown once, right after you create the key.',
        true,
      ),
    ],
    read: s => [s.s3.endpoint, ...readKeys(s)],
    apply: (v, s) => s3(s, v[0], regionFromEndpoint(v[0]), v[1], v[2], v[3]),
    match: s => s.backend === 's3' && onDomain(s.s3.endpoint, 'backblazeb2.com'),
  },
  {
    name: 'Cloudflare R2',
    fields: [
      {
        question: "What's your Cloudflare account ID?",
        help: 'On the R2 overview page, 32 letters and numbers.',
        name: 'account ID',
        about: 'address',
        check: checkAccountID,
      },
      fBucket,
      access(
        'Paste the Access Key ID.',
        'Access Key ID',
        'key',
        'R2 > Manage R2 API Tokens > Create API token, with Object Read & Write.',
      ),
      access(
        'Paste the Secret Access Key.',
        'Secret Access Key',
        'secret',
        'Shown once, next to the Access Key ID.',
        true,
      ),
    ],
    read: s => [hostOf(s.s3.endpoint).replace(/\.r2\.cloudflarestorage\.com$/, ''), ...readKeys(s)],
    apply: (v, s) => s3(s, v[0] + '.r2.cloudflarestorage.com', 'auto', v[1], v[2], v[3]),
    match: s => s.backend === 's3' && onDomain(s.s3.endpoint, 'r2.cloudflarestorage.com'),
  },
  {
    name: 'Wasabi',
    fields: [
      {
        question: 'Which region is the bucket in?',
        help: 'E.g. us-east-1 or eu-central-1.',
        name: 'region',
        about: 'address',
        check: checkRegion,
      },
      fBucket,
      access('Paste the access key.', 'access key', 'key', 'Access Keys > Create New Access Key.'),
      access('Paste the secret key.', 'secret key', 'secret', 'Shown once, when you create the key.', true),
    ],
    read: s => [s.s3.region, ...readKeys(s)],
    apply: (v, s) => s3(s, 's3.' + v[0] + '.wasabisys.com', v[0], v[1], v[2], v[3]),
    match: s => s.backend === 's3' && onDomain(s.s3.endpoint, 'wasabisys.com'),
  },
  {
    name: 'Other S3-compatible',
    note: 'Ceph, SeaweedFS',
    fields: [
      {
        question: "What's the S3 endpoint?",
        help: "Your server's or provider's docs list it. Use http:// only for local servers.",
        name: 'endpoint',
        about: 'address',
        check: checkEndpoint,
      },
      {
        question: 'Which region?',
        optional: true,
        placeholder: "leave blank if there isn't one",
        help: 'Only if your server or provider asks for one.',
        name: 'region',
        about: 'address',
        check: noSpaces('region'),
      },
      fBucket,
      access('Paste the access key ID.', 'access key ID', 'key', "From your server's or provider's console."),
      access(
        'Paste the secret access key.',
        'secret access key',
        'secret',
        "From your server's or provider's console.",
        true,
      ),
    ],
    read: s => [s.s3.endpoint, s.s3.region, ...readKeys(s)],
    apply: (v, s) => s3(s, v[0], v[1], v[2], v[3], v[4]),
    match: s => s.backend === 's3',
  },
  {
    name: 'Self-hosted',
    note: 'your server over SSH',
    fields: [
      {
        question: "What's the server's SSH address?",
        placeholder: 'like me@nas.local',
        help: 'A user and host, or a Host from your SSH config. Add :2222 for another port.',
        name: 'address',
        about: 'address',
        check: checkAddress,
      },
      {
        question: 'Which folder on the server?',
        value: 'frost',
        help: 'In your home folder there, or a full path like /srv/backups/frost. frost creates the last folder.',
        name: 'folder',
        about: 'folder',
        check: checkFolder,
      },
    ],
    read: s => [joinAddress(s.sftp.host, s.sftp.port), s.sftp.path],
    apply: (v, s) => {
      const { host, port } = splitAddress(v[0]);
      s.backend = 'sftp';
      Object.assign(s.sftp, { host, port, path: v[1] });
    },
    match: s => s.backend === 'sftp',
  },
  {
    name: 'Local drive',
    note: 'USB or internal disk',
    fields: [
      {
        question: 'Which folder should hold your backups?',
        placeholder: 'like ' + drivePath,
        help: "On a drive that's connected now. frost creates the last folder if it isn't there.",
        name: 'folder',
        about: 'folder',
        check: checkDrivePath,
      },
    ],
    read: s => [s.local.path],
    apply: (v, s) => {
      s.backend = 'local';
      s.local.path = v[0];
    },
    match: s => s.backend === 'local',
  },
];

// The list setup shows first. Each choice holds the indexes of its providers; S3-compatible has several and
// opens a second list.
export const choices: { name: string; note: string; providers: number[] }[] = [
  { name: 'Permafrost', note: 'recommended', providers: [0] },
  { name: 'S3-compatible', note: 'AWS, B2, R2, Wasabi, Ceph', providers: [1, 2, 3, 4, 5] },
  { name: 'Self-hosted', note: 'your server over SSH', providers: [6] },
  { name: 'Local drive', note: 'USB or internal disk', providers: [7] },
];

// The choice a provider belongs to.
export const choiceOf = (provider: number): number => choices.findIndex(c => c.providers.includes(provider));

// The index of the Self-hosted provider, whose connections can need frost's SSH key added first.
export const selfHosted = choices[2].providers[0];

// Returns the index of the provider a config uses. A config without a backend, or with one setup doesn't
// know, counts as Permafrost.
export function matchProvider(s: Storage): number {
  return Math.max(
    providers.findIndex(p => p.match(s)),
    0,
  );
}

// Describes where backups go in one line, for the review screen.
export function describeStorage(s: Storage): string {
  const p = providers[matchProvider(s)];
  if (s.backend === 'permafrost') return permafrostName(s.permafrost.url);
  if (s.backend === 'sftp') return p.name + ', ' + joinAddress(s.sftp.host, s.sftp.port) + ', folder ' + s.sftp.path;
  if (s.backend === 'local') return p.name + ', ' + s.local.path;
  return p.name + ', bucket ' + s.s3.bucket + (s.s3.prefix ? '/' + s.s3.prefix.replace(/^\/+|\/+$/g, '') : '');
}
