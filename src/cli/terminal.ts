// Works out how many colours the terminal supports, and turns palette colours into escape sequences for
// that level. The CLI and the TUI both use it.

import { release } from 'node:os';

export type ColorProfile = 'ascii' | 'ansi' | 'ansi256' | 'truecolor';

// Every colour Frost prints, with its nearest 16-colour code, 256-colour code and RGB value. The four lists
// are matched by position, so keep them in step.
const hexes = [
  '#f2efe7', // TUI pri
  '#0a0a0b', // TUI sec
  '#1926c4', // TUI ter
  '#b1aea9', // TUI muted
  '#797774', // TUI subtle
  '#7ee787', // TUI ok
  '#f2cc60', // TUI warn
  '#ffa198', // TUI bad
  '#4353ff', // CLI accent
  '#3fb950', // CLI ok
  '#d29922', // CLI warn
  '#f85149', // CLI bad
];
const ansi = [93, 30, 94, 37, 90, 92, 93, 91, 94, 32, 91, 91];
const ansi256 = [230, 232, 20, 145, 102, 114, 221, 216, 63, 71, 172, 203];
const rgb = [
  '242;239;231',
  '10;10;11',
  '25;38;195',
  '177;174;169',
  '121;119;116',
  '126;231;135',
  '242;204;96',
  '255;161;152',
  '67;83;255',
  '63;185;80',
  '210;153;34',
  '248;81;73',
];

// The SGR parameters for a palette colour, without the surrounding escape. ASCII gets none.
export function colorSequence(hex: string, profile: ColorProfile, background = false): string {
  if (profile === 'ascii') return '';
  const i = hexes.indexOf(hex.toLowerCase());
  if (i < 0) throw new Error('unknown theme color ' + hex);
  if (profile === 'ansi') return String(ansi[i] + (background ? 10 : 0));
  return (background ? '48' : '38') + (profile === 'ansi256' ? ';5;' + ansi256[i] : ';2;' + rgb[i]);
}

// NO_COLOR and CLICOLOR=0 turn colour off, and CLICOLOR_FORCE turns it on even without a terminal. CI
// output gets no colour unless forced.
export function terminalProfile(
  tty: boolean,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  windowsVersion = release(),
): ColorProfile {
  const forced = !!env.CLICOLOR_FORCE && env.CLICOLOR_FORCE !== '0';
  if (env.NO_COLOR || (env.CLICOLOR === '0' && !forced)) return 'ascii';

  let profile: ColorProfile = 'ascii';
  if (tty && !env.CI) {
    if (platform === 'win32') {
      // Windows 10 build 10586 added ANSI support and build 14931 added 24-bit colour. Older consoles only
      // get colour through ConEmu or ANSICON.
      const [major, , build] = windowsVersion.split('.').map(Number);
      if (env.ConEmuANSI === 'ON') profile = 'truecolor';
      else if (major < 10 || build < 10586) {
        if (env.ANSICON) profile = Number(env.ANSICON_VER) >= 181 ? 'ansi256' : 'ansi';
      } else profile = build < 14931 ? 'ansi256' : 'truecolor';
    } else {
      // Elsewhere COLORTERM decides first, then TERM. A screen TERM outside tmux means GNU screen, which
      // can't show 24-bit colour.
      const term = env.TERM ?? '',
        color = (env.COLORTERM ?? '').toLowerCase();
      if (env.GOOGLE_CLOUD_SHELL === 'true') profile = 'truecolor';
      else if (color === '24bit' || color === 'truecolor')
        profile = term.startsWith('screen') && env.TERM_PROGRAM !== 'tmux' ? 'ansi256' : 'truecolor';
      else if (color === 'yes' || color === 'true') profile = 'ansi256';
      else if (['alacritty', 'contour', 'rio', 'wezterm', 'xterm-ghostty', 'xterm-kitty'].includes(term))
        profile = 'truecolor';
      else if (term === 'linux' || term === 'xterm') profile = 'ansi';
      else if (term.includes('256color')) profile = 'ansi256';
      else if (term.includes('color') || term.includes('ansi')) profile = 'ansi';
    }
  }

  return forced && profile === 'ascii' ? 'ansi' : profile;
}

// The TUI renders in 24-bit colour. This rewrites a rendered frame for a terminal that supports less.
export function convertProfile(text: string, profile: ColorProfile): string {
  if (profile === 'truecolor') return text;
  if (profile === 'ascii') return text.replace(/\x1b\[[\d;]*m/g, '');
  return text.replace(
    /(38|48);2;(\d+);(\d+);(\d+)/g,
    (sequence: string, kind: string, r: string, g: string, b: string) => {
      const i = rgb.indexOf([r, g, b].join(';'));
      return i < 0 ? sequence : colorSequence(hexes[i], profile, kind === '48');
    },
  );
}
