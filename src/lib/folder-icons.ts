import { z } from 'zod';

// Each project folder's icon, which a small model chooses from the catalog in folder-icons.json
// when the folder's first conversation starts, like a chat's title. The workspace keeps one per
// folder, so every device shows it. Names are kept as written: a name a newer release adds shows
// the folder mark on older ones.
export const maxFolderIcons = 2000;
export const folderIconNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const folderIconSchema = z.object({
  // The folder: the environment that holds it and its path there.
  environmentId: z.string().uuid(),
  path: z.string().min(1).max(4096),
  icon: folderIconNameSchema,
  // The model that chose it.
  source: z.object({ provider: z.string().min(1).max(40), model: z.string().max(100) }).optional(),
  chosenAt: z.iso.datetime(),
});
export const folderIconsSchema = z
  .array(folderIconSchema)
  .max(maxFolderIcons)
  .refine(
    (icons) => new Set(icons.map(folderIconKey)).size === icons.length,
    'Each folder has one icon.',
  );
export type FolderIcon = z.infer<typeof folderIconSchema>;
type Folder = { environmentId: string; path: string };

/**
 * Names a folder whatever its spelling: Windows paths ignore case and separator style, and no
 * path keeps a trailing separator.
 */
export function folderIconKey({ environmentId, path }: Folder): string {
  const folder = path.trim();
  if (/^[A-Za-z]:([\\/]|$)/.test(folder) || folder.startsWith('\\\\')) {
    const windows = folder.replace(/\//g, '\\').replace(/\\+$/, '');
    return `${environmentId}:${(windows.endsWith(':') ? `${windows}\\` : windows).toLowerCase()}`;
  }
  return `${environmentId}:${folder.replace(/\/+$/, '') || '/'}`;
}
/**
 * The folder as the model choosing its icon reads it: its name after up to two of its parent
 * folders, which often tell what it holds (Unreal Projects/Bluevox), rather than its whole path.
 */
export function folderIconContext(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part && !/^[A-Za-z]:$/.test(part));
  return parts.slice(-3).join('/') || path.trim();
}
/** Icons by folder, so a sidebar of many folders looks each one up at once. */
export const folderIconIndex = (icons: readonly FolderIcon[] = []) =>
  new Map(icons.map((icon) => [folderIconKey(icon), icon]));
/** The icon of a chat's folder; Standalone chats have no folder and so no icon. */
export const folderIconOf = (
  index: ReadonlyMap<string, FolderIcon>,
  location: Folder | undefined,
): FolderIcon | undefined => (location?.path ? index.get(folderIconKey(location)) : undefined);

const sameIcon = (a: FolderIcon | undefined, b: FolderIcon | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.environmentId === b.environmentId &&
    a.path === b.path &&
    a.icon === b.icon &&
    a.source?.provider === b.source?.provider &&
    a.source?.model === b.source?.model &&
    a.chosenAt === b.chosenAt);
const chosen = (icon: FolderIcon) => Date.parse(icon.chosenAt);
// The later of two choices for one folder, the same one on every device.
function later(a: FolderIcon, b: FolderIcon) {
  const difference = chosen(a) - chosen(b);
  if (difference) return difference > 0 ? a : b;
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b;
}
/**
 * The order every device stores icons in, by folder, so equal lists compare equal as text. Past
 * the limit, the folders whose icons were chosen longest ago lose theirs.
 */
function stored(icons: FolderIcon[]): FolderIcon[] {
  const kept =
    icons.length > maxFolderIcons
      ? [...icons].sort((a, b) => chosen(b) - chosen(a)).slice(0, maxFolderIcons)
      : icons;
  return kept
    .map((icon) => ({ icon, key: folderIconKey(icon) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ icon }) => icon);
}
/** Gives a folder its icon, replacing the one it had. */
export const withFolderIcon = (icons: readonly FolderIcon[] | undefined, icon: FolderIcon) =>
  stored([...(icons ?? []).filter((i) => folderIconKey(i) !== folderIconKey(icon)), icon]);
/** Whether two lists hold the same icons, whatever their order. */
export function sameFolderIcons(a: readonly FolderIcon[] = [], b: readonly FolderIcon[] = []) {
  if (a.length !== b.length) return false;
  const other = folderIconIndex(b);
  return a.every((icon) => sameIcon(icon, other.get(folderIconKey(icon))));
}

/**
 * Keeps each side's changes since the shared base. When both sides chose an icon for the same
 * folder, the later choice wins, and a removal yields to a choice. A side without the list
 * predates folder icons (an older relay or app drops them), so its absence removes nothing.
 */
export function mergeFolderIcons(
  base: readonly FolderIcon[] | undefined,
  local: FolderIcon[] | undefined,
  remote: FolderIcon[] | undefined,
): FolderIcon[] | undefined {
  if (!remote) return local;
  if (!local) return remote;
  const before = folderIconIndex(base);
  const ours = folderIconIndex(local);
  const theirs = folderIconIndex(remote);
  const merged: FolderIcon[] = [];
  for (const key of new Set([...ours.keys(), ...theirs.keys()])) {
    const original = before.get(key);
    const left = ours.get(key);
    const right = theirs.get(key);
    let icon: FolderIcon | undefined;
    if (sameIcon(left, right) || sameIcon(original, right)) icon = left;
    else if (sameIcon(original, left)) icon = right;
    else icon = left && right ? later(left, right) : (left ?? right);
    if (icon) merged.push(icon);
  }
  return stored(merged);
}
