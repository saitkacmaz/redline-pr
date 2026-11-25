import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/*
 * Everything that differs between macOS, Linux and Windows, as pure functions of the
 * platform (and env), so each branch is testable on any machine.
 */

/**
 * The cache root: `$XDG_CACHE_HOME/redline-pr` when set (any platform), else
 * `%LOCALAPPDATA%\redline-pr` on Windows, else `~/.cache/redline-pr`.
 */
export function cacheRoot(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const xdg = env.XDG_CACHE_HOME?.trim();
  if (xdg && p.isAbsolute(xdg)) return p.join(xdg, 'redline-pr');
  const local = env.LOCALAPPDATA?.trim();
  if (platform === 'win32' && local && p.isAbsolute(local)) return p.join(local, 'redline-pr');
  return p.join(home, '.cache', 'redline-pr');
}

const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * The full path `cmd` would run as, like `which` (POSIX) or `where` (Windows), without
 * spawning either: PATH is searched directly, with PATHEXT (.EXE, .CMD, …) on Windows.
 */
export function findExecutable(
  cmd: string,
  { pathEnv = process.env.PATH ?? process.env.Path ?? '', platform = process.platform, pathext = process.env.PATHEXT } = {},
): string | null {
  const windows = platform === 'win32';
  const exts = windows ? ['', ...(pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const dir of pathEnv.split(windows ? ';' : ':').filter(Boolean)) {
    for (const ext of exts) {
      // On Windows a bare name with no extension isn't runnable; only PATHEXT matches are.
      if (windows && ext === '' && !path.extname(cmd)) continue;
      const file = path.join(dir.replace(/^"(.*)"$/, '$1'), cmd + ext);
      if (!isFile(file)) continue;
      if (windows) return file;
      try {
        accessSync(file, constants.X_OK);
        return file;
      } catch {
        // Present but not executable: keep looking.
      }
    }
  }
  return null;
}

/**
 * The script an npm `.cmd` shim runs (`"%_prog%" "%dp0%\node_modules\pkg\cli.js" %*`), as a
 * path relative to the shim's directory. Running it with node directly avoids cmd.exe,
 * which can't pass arguments containing newlines (a system prompt) or quotes safely.
 */
export function npmShimTarget(shim: string): string | null {
  const m = /"%~?dp0%?\\([^"]+?\.[cm]?js)"/i.exec(shim);
  return m?.[1] ?? null;
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Quote one argument for `cmd.exe /d /s /c "…"` (the cross-spawn rules). */
export function quoteCmdArg(arg: string, doubleEscape = false): string {
  let quoted = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1');
  quoted = `"${quoted}"`.replace(CMD_META, '^$1');
  return doubleEscape ? quoted.replace(CMD_META, '^$1') : quoted;
}

export interface SpawnTarget {
  file: string;
  args: string[];
  /** Pass the command line as-is (already quoted for cmd.exe). */
  verbatim: boolean;
}

/**
 * How to spawn `cmd` without a shell on this platform. POSIX: as is. Windows: `.exe` as is;
 * an npm `.cmd` shim through node and the script it wraps; any other `.cmd`/`.bat` through
 * cmd.exe with every argument quoted. Stdin is a plain pipe in every case.
 */
export function resolveSpawn(
  cmd: string,
  args: readonly string[],
  { platform = process.platform, pathEnv, pathext, readFile = (f: string) => readFileSync(f, 'utf8'), node = process.execPath, comspec = process.env.ComSpec } = {} as {
    platform?: NodeJS.Platform;
    pathEnv?: string;
    pathext?: string;
    readFile?: (file: string) => string;
    node?: string;
    comspec?: string | undefined;
  },
): SpawnTarget {
  if (platform !== 'win32') return { file: cmd, args: [...args], verbatim: false };
  const found = findExecutable(cmd, { platform, ...(pathEnv !== undefined ? { pathEnv } : {}), ...(pathext !== undefined ? { pathext } : {}) });
  if (!found || !/\.(cmd|bat)$/i.test(found)) return { file: found ?? cmd, args: [...args], verbatim: false };
  let target: string | null = null;
  try {
    target = npmShimTarget(readFile(found));
  } catch {
    // Unreadable shim: fall through to cmd.exe.
  }
  if (target) return { file: node, args: [path.join(path.dirname(found), target), ...args], verbatim: false };
  const double = /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(found);
  const line = [found.replace(CMD_META, '^$1'), ...args.map((a) => quoteCmdArg(a, double))].join(' ');
  return { file: comspec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/**
 * How to open `url` in the default browser, or null where there's no display to open it
 * on (an SSH session or a headless Linux box): then redline just prints the URL.
 */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): SpawnTarget | null {
  if (platform === 'darwin') return { file: 'open', args: [url], verbatim: false };
  // `start`'s first quoted argument is the window title, hence the empty "".
  if (platform === 'win32') return { file: 'cmd', args: ['/c', 'start', '""', url], verbatim: true };
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  return { file: 'xdg-open', args: [url], verbatim: false };
}

/** Quote a path for a command the user will paste into their shell. */
export function shellPath(p: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return /^[\w@%+=:,./\\~-]+$/.test(p) ? p : `"${p.replace(/"/g, '""')}"`;
  return /^[\w@%+=:,./~-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}
