import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import catalog from './folder-icons.json';
import {
  folderIconContext,
  folderIconIndex,
  folderIconKey,
  folderIconOf,
  folderIconsSchema,
  maxFolderIcons,
  mergeFolderIcons,
  sameFolderIcons,
  withFolderIcon,
  type FolderIcon,
} from './folder-icons';

const environmentId = crypto.randomUUID();
const icon = (path: string, name: string, chosenAt = '2026-10-02T12:00:00.000Z'): FolderIcon => ({
  environmentId,
  path,
  icon: name,
  source: { provider: 'claude', model: 'haiku' },
  chosenAt,
});
const names = catalog.categories.flatMap((category) => category.icons.map(([name]) => name));

describe('folder icons', () => {
  it('draws every icon of the catalog the model chooses from', () => {
    expect(names.length).toBeGreaterThanOrEqual(300);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain(catalog.fallback);
    const component = readFileSync('src/lib/components/FolderIcon.svelte', 'utf8').replace(
      /\r\n/g,
      '\n',
    );
    const drawn = [...component.matchAll(/^ {4}'?([a-z0-9-]+)'?: ([A-Za-z0-9]+),$/gm)];
    expect(drawn.map(([, name]) => name)).toEqual(names);
    for (const [, name, drawing] of drawn) {
      // Each name is a Lucide icon, drawn by its own component.
      expect(existsSync(`node_modules/@lucide/svelte/dist/icons/${name}.svelte`)).toBe(true);
      expect(drawing).toBe(name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase()));
      expect(component).toContain(`    ${drawing},\n`);
    }
    for (const [, suits] of catalog.categories.flatMap((category) => category.icons))
      expect(suits).toMatch(/^[^();\n]+$/);
  });

  it('names a folder whatever its spelling', () => {
    expect(folderIconKey({ environmentId, path: 'C:\\Users\\Me\\Projects\\Hoard\\' })).toBe(
      folderIconKey({ environmentId, path: 'c:/users/me/projects/hoard' }),
    );
    expect(folderIconKey({ environmentId, path: 'D:' })).toBe(`${environmentId}:d:\\`);
    expect(folderIconKey({ environmentId, path: '/home/me/hoard/' })).toBe(
      `${environmentId}:/home/me/hoard`,
    );
    // Linux folders keep their case, and the root stays a folder.
    expect(folderIconKey({ environmentId, path: '/home/me/Hoard' })).not.toBe(
      folderIconKey({ environmentId, path: '/home/me/hoard' }),
    );
    expect(folderIconKey({ environmentId, path: '/' })).toBe(`${environmentId}:/`);
    expect(folderIconKey({ environmentId: crypto.randomUUID(), path: '/home/me/hoard' })).not.toBe(
      folderIconKey({ environmentId, path: '/home/me/hoard' }),
    );
  });

  it('shows the model a folder by its name and two parent folders', () => {
    expect(folderIconContext('C:\\Users\\Me\\Documents\\Unreal Projects\\Bluevox')).toBe(
      'Documents/Unreal Projects/Bluevox',
    );
    expect(folderIconContext('/home/me/hoard/')).toBe('home/me/hoard');
    expect(folderIconContext('\\\\wsl.localhost\\Ubuntu\\home\\me\\atlas')).toBe('home/me/atlas');
    expect(folderIconContext('D:\\games')).toBe('games');
    expect(folderIconContext('D:\\')).toBe('D:\\');
    expect(folderIconContext('/')).toBe('/');
  });

  it('keeps one icon per folder, in the same order on every device', () => {
    const hoard = icon('/home/me/hoard', 'archive');
    const atlas = icon('/home/me/atlas', 'map');
    const icons = withFolderIcon(withFolderIcon(undefined, hoard), atlas);
    expect(icons).toEqual([atlas, hoard]);
    const replaced = withFolderIcon(icons, icon('/home/me/hoard/', 'gem'));
    expect(replaced.map((i) => i.icon)).toEqual(['map', 'gem']);
    const index = folderIconIndex(replaced);
    expect(folderIconOf(index, { environmentId, path: '/home/me/atlas' })).toBe(atlas);
    // Standalone chats have no folder, and folders without an icon have none.
    expect(folderIconOf(index, { environmentId, path: '' })).toBeUndefined();
    expect(folderIconOf(index, undefined)).toBeUndefined();
    expect(folderIconOf(index, { environmentId, path: '/home/me/quest' })).toBeUndefined();
    expect(sameFolderIcons(replaced, [...replaced].reverse())).toBe(true);
    expect(sameFolderIcons(replaced, icons)).toBe(false);
    expect(sameFolderIcons(undefined, [])).toBe(true);
    // Past the limit, the icons chosen longest ago go.
    const many = Array.from({ length: maxFolderIcons }, (_, i) =>
      icon(`/p/${i}`, 'code', new Date(Date.parse('2026-01-01') + i * 60_000).toISOString()),
    );
    const bounded = withFolderIcon(many, icon('/p/new', 'bot'));
    expect(bounded).toHaveLength(maxFolderIcons);
    expect(bounded.some((i) => i.path === '/p/0')).toBe(false);
    expect(bounded.some((i) => i.path === '/p/new')).toBe(true);
    expect(folderIconsSchema.safeParse(bounded).success).toBe(true);
  });

  it('accepts names a newer release adds and refuses malformed or repeated folders', () => {
    expect(folderIconsSchema.safeParse([icon('/a', 'a-future-icon')]).success).toBe(true);
    for (const name of ['Bot', 'bot ', 'bot--x', '<svg>', ''])
      expect(folderIconsSchema.safeParse([icon('/a', name)]).success).toBe(false);
    expect(folderIconsSchema.safeParse([icon('C:\\A', 'bot'), icon('c:/a/', 'map')]).success).toBe(
      false,
    );
    expect(folderIconsSchema.safeParse([{ ...icon('/a', 'bot'), chosenAt: 'now' }]).success).toBe(
      false,
    );
  });

  it('merges choices from both sides and keeps them when a side predates them', () => {
    const shared = icon('/shared', 'code', '2026-10-01T09:00:00.000Z');
    const ours = icon('/ours', 'bot');
    const theirs = icon('/theirs', 'castle');
    const base = [shared];
    const merged = mergeFolderIcons(base, [shared, ours], [shared, theirs]);
    expect(merged).toEqual(withFolderIcon(withFolderIcon(base, ours), theirs));
    // An older relay or app drops the list: this device keeps its own.
    expect(mergeFolderIcons(base, [shared, ours], undefined)).toEqual([shared, ours]);
    expect(mergeFolderIcons(base, undefined, [shared, theirs])).toEqual([shared, theirs]);
    expect(mergeFolderIcons(undefined, undefined, undefined)).toBeUndefined();
    // A side that changed a folder's icon wins over a side that kept it.
    const rechosen = icon('/shared', 'gamepad-2', '2026-10-02T09:00:00.000Z');
    expect(mergeFolderIcons(base, [rechosen], base)).toEqual([rechosen]);
    expect(mergeFolderIcons(base, base, [rechosen])).toEqual([rechosen]);
    // Both chose one for the same folder: the later choice, the same on both devices.
    const earlier = icon('/new', 'map', '2026-10-02T10:00:00.000Z');
    const later = icon('/new', 'compass', '2026-10-02T10:00:05.000Z');
    expect(mergeFolderIcons(base, [shared, earlier], [shared, later])).toEqual([later, shared]);
    expect(mergeFolderIcons(base, [shared, later], [shared, earlier])).toEqual([later, shared]);
    const tie = icon('/new', 'atlas', earlier.chosenAt);
    expect(mergeFolderIcons(base, [shared, earlier], [shared, tie])).toEqual(
      mergeFolderIcons(base, [shared, tie], [shared, earlier]),
    );
    // Removed on one side and kept on the other, it goes; a removal yields to a new choice.
    expect(mergeFolderIcons(base, [], base)).toEqual([]);
    expect(mergeFolderIcons(base, [], [rechosen])).toEqual([rechosen]);
  });
});
