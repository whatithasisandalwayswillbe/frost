// The launcher every package ships. The Frost command and scheduled jobs run it with the bundled runtime. It starts
// the version that current.json names. An update replaces the version folder and current.json but never this file, so
// each install keeps the launcher it was installed with. Keep it small, and keep it working with every version folder,
// past and future. It relies only on current.json's `version` and on versions/<version>/src/cli/main.js.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('./', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('current.json', root), 'utf8'));
if (!/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error('Invalid installed version');
process.env.FROST_APP_ROOT = fileURLToPath(root);
await import(new URL('versions/' + version + '/src/cli/main.js', root));
