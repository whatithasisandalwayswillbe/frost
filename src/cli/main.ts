// Process entry point. Runs one Frost command and turns ctrl+c into a cancelled context.

import { execute } from './index.js';
import { cleanup } from '../platform/update.js';

const controller = new AbortController();
const stop = () => controller.abort(new Error('context canceled'));

process.on('SIGINT', stop);
try {
  // On Windows an update moves the running runtime aside as a .old file. Delete any left from an earlier update.
  if (process.platform === 'win32' && process.env.FROST_APP_ROOT) await cleanup(process.env.FROST_APP_ROOT);
  process.exitCode = await execute(process.argv.slice(2), { signal: controller.signal });
} finally {
  process.off('SIGINT', stop);
}
