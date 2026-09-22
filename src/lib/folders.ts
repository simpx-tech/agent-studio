// Pure helpers for the folder browser: path segmentation, filtering, and summaries.
// Listings come from the owning host through transport; nothing here touches the filesystem.
export type FolderPlaceKind = 'home' | 'root' | 'drive' | 'mount' | 'folder';
export type FolderPlace = { kind: FolderPlaceKind; name: string; path: string };
export type FolderEntry = { name: string; path: string; hidden?: boolean; repository?: boolean };
export type FolderSegment = { name: string; path: string };

const windowsDrive = /^([A-Za-z]):([\\/]|$)/;

export function isWindowsPath(path: string) {
  return windowsDrive.test(path) || path.startsWith('\\\\');
}

// Accepts the same absolute spellings the host validates: POSIX roots, drive letters, and UNC.
export function isAbsolutePath(text: string) {
  const value = text.trim();
  return value.startsWith('/') || windowsDrive.test(value) || /^\\\\[^\\/]+[\\/]/.test(value);
}

// `~` and `~/…` become the environment's reported home folder when it is known.
export function expandHome(text: string, home?: string) {
  const value = text.trim();
  if (!home || !(value === '~' || value.startsWith('~/') || value.startsWith('~\\'))) return value;
  const rest = value.slice(1).replace(/^[\\/]+/, '');
  if (!rest) return home;
  const separator = isWindowsPath(home) ? '\\' : '/';
  return `${home.replace(/[\\/]+$/, '')}${separator}${rest}`;
}

// Splits an absolute path into clickable ancestors, keeping the root's own spelling.
export function pathSegments(path: string): FolderSegment[] {
  const value = path.trim();
  if (!value) return [];
  if (value.startsWith('\\\\')) {
    const parts = value
      .slice(2)
      .split(/[\\/]+/)
      .filter(Boolean);
    if (parts.length < 2) return [{ name: value, path: value }];
    const root = `\\\\${parts[0]}\\${parts[1]}`;
    return parts.slice(2).reduce(
      (segments, part) => {
        const previous = segments[segments.length - 1].path;
        return [...segments, { name: part, path: `${previous}\\${part}` }];
      },
      [{ name: root, path: root }],
    );
  }
  const drive = windowsDrive.exec(value);
  if (drive) {
    const root = `${drive[1].toUpperCase()}:\\`;
    const parts = value
      .slice(2)
      .split(/[\\/]+/)
      .filter(Boolean);
    return parts.reduce(
      (segments, part) => {
        const previous = segments[segments.length - 1].path.replace(/\\$/, '');
        return [...segments, { name: part, path: `${previous}\\${part}` }];
      },
      [{ name: root, path: root }],
    );
  }
  if (value.startsWith('/')) {
    const parts = value.split('/').filter(Boolean);
    return parts.reduce(
      (segments, part) => {
        const previous = segments[segments.length - 1].path.replace(/\/$/, '');
        return [...segments, { name: part, path: `${previous}/${part}` }];
      },
      [{ name: '/', path: '/' }],
    );
  }
  return [{ name: value, path: value }];
}

// Keeps the root and the last `keep` folders so long paths stay recognizable in one line.
// Paths that would only lose a single folder stay intact.
export function compactPath(path: string, keep = 2) {
  const segments = pathSegments(path);
  if (segments.length <= keep + 2) return path.trim();
  const separator = isWindowsPath(path) ? '\\' : '/';
  const root = segments[0].path.replace(/[\\/]$/, '');
  return `${root}${separator}…${separator}${segments
    .slice(-keep)
    .map((s) => s.name)
    .join(separator)}`;
}

// Hidden folders stay out of the way unless requested; matches rank prefixes before substrings.
export function filterFolders<T extends FolderEntry>(
  entries: readonly T[],
  options: { query?: string; showHidden?: boolean } = {},
): T[] {
  const query = options.query?.trim().toLocaleLowerCase() ?? '';
  const visible = entries.filter((entry) => options.showHidden || !entry.hidden);
  if (!query) return visible;
  const rank = (entry: T) => {
    const name = entry.name.toLocaleLowerCase();
    return name.startsWith(query) ? 0 : name.includes(query) ? 1 : 2;
  };
  return visible
    .map((entry, index) => ({ entry, index, rank: rank(entry) }))
    .filter((item) => item.rank < 2)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.entry);
}

export function summarizeFolders(entries: readonly FolderEntry[]) {
  return {
    total: entries.length,
    hidden: entries.filter((entry) => entry.hidden).length,
    repositories: entries.filter((entry) => entry.repository).length,
  };
}

export function describeFolders(entries: readonly FolderEntry[]) {
  const { total, hidden, repositories } = summarizeFolders(entries);
  const parts = [`${total} ${total === 1 ? 'folder' : 'folders'}`];
  if (repositories)
    parts.push(`${repositories} ${repositories === 1 ? 'repository' : 'repositories'}`);
  if (hidden) parts.push(`${hidden} hidden`);
  return parts.join(' · ');
}
