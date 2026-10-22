// Finds the captured TUI frames for this platform. Windows uses the top level of test/fixtures/tui,
// and every other platform uses its linux/ folder.

import { readFileSync } from 'node:fs';

// Tests run from dist/test/tui, so the fixtures are three folders up.
export const referenceDir = new URL(
  '../../../test/fixtures/tui/' + (process.platform === 'win32' ? '' : 'linux/'),
  import.meta.url,
);

// Reads one captured frame, such as 'setup-01-welcome-080', with its escape sequences intact.
export const reference = (name: string): string => readFileSync(new URL(name + '.ans', referenceDir), 'utf8');

// The missing folder typed into the captured setup wizard. It's a native path, so each platform has its own.
export const setupInput: { missingDir: string } = JSON.parse(
  readFileSync(new URL('setup-input.fixture', referenceDir), 'utf8'),
);
