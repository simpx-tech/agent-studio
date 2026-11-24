import { describe, expect, it } from 'vitest';
import {
  insideGroup,
  keptGroups,
  regrouped,
  regroupLocally,
  screenDestinations,
  screenTree,
  shownGroup,
  shownParent,
  type ScreenGroupNode,
  type ScreenSection,
} from './screen-groups';
import type { ScreenGroup, ScreenSummary } from './screens';

const desk = '11111111-1111-4111-8111-111111111111';
const wsl = '22222222-2222-4222-8222-222222222222';
const uuid = (n: number) => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const group = (n: number, name: string, parent?: number, environmentId = desk): ScreenGroup => ({
  id: uuid(n),
  environmentId,
  name,
  ...(parent ? { parent: uuid(parent) } : {}),
  createdAt: '2026-11-24T00:00:00.000Z',
});
const screen = (
  n: number,
  title: string,
  inGroup?: number,
  environmentId = desk,
): ScreenSummary => ({
  id: uuid(1000 + n),
  revision: 1,
  title,
  description: '',
  environmentId,
  project: '',
  folder: 'C:\\work',
  conversationId: uuid(5000),
  createdAt: '',
  updatedAt: '',
  commands: 0,
  ...(inGroup ? { group: uuid(inGroup) } : {}),
});
const computers = (environmentId: string) =>
  environmentId === desk
    ? { id: 'desk', name: 'Desktop' }
    : environmentId === wsl
      ? { id: wsl, name: 'Ubuntu' }
      : undefined;
/** A section as names: groups with what they hold, then the screens in none. */
const outline = (section: ScreenSection) => {
  const node = (item: ScreenGroupNode): unknown => ({
    [item.group.name]: [...item.groups.map(node), ...item.screens.map((s) => s.title)],
  });
  return [...section.groups.map(node), ...section.screens.map((s) => s.title)];
};

const groups = [
  group(1, 'Unreal editors'),
  group(2, 'Edvisor'),
  group(3, 'Linear', 2),
  group(4, 'archive', 2),
  group(5, 'Empty'),
  group(6, 'Edvisor', undefined, wsl),
];
const screens = [
  screen(1, 'NationGame editor', 1),
  screen(2, 'Bluevox editor', 1),
  screen(3, 'Ticket queue', 3),
  screen(4, 'Daily work log', 3),
  screen(5, 'Edvisor PR ranking', 2),
  screen(6, 'Scratch'),
  screen(7, 'Builds', 6, wsl),
];

describe('the screens tree', () => {
  it('shows each computer’s groups by name, holding their groups and then their screens', () => {
    const tree = screenTree(groups, screens, computers);
    expect(tree.map((section) => section.name)).toEqual(['Desktop', 'Ubuntu']);
    expect(outline(tree[0])).toEqual([
      {
        Edvisor: [
          { archive: [] },
          { Linear: ['Ticket queue', 'Daily work log'] },
          'Edvisor PR ranking',
        ],
      },
      { Empty: [] },
      { 'Unreal editors': ['NationGame editor', 'Bluevox editor'] },
      'Scratch',
    ]);
    expect(outline(tree[1])).toEqual([{ Edvisor: ['Builds'] }]);
    const linear = tree[0].groups[0].groups[1];
    expect(linear.path).toEqual(['Edvisor', 'Linear']);
    expect(linear.depth).toBe(1);
  });

  it('keeps screens whose group is gone or another environment’s at the top', () => {
    const tree = screenTree(
      [group(1, 'Elsewhere', undefined, wsl), group(2, 'Orphan', 99)],
      [screen(1, 'Lost', 99), screen(2, 'Crossed', 1)],
      computers,
    );
    expect(outline(tree.find((section) => section.name === 'Desktop')!)).toEqual([
      { Orphan: [] },
      'Lost',
      'Crossed',
    ]);
    expect(outline(tree.find((section) => section.name === 'Ubuntu')!)).toEqual([
      { Elsewhere: [] },
    ]);
    // A circle of parents, which no change makes, starts at the top rather than vanishing.
    const circle = screenTree([group(1, 'A', 2), group(2, 'B', 1)], [], computers);
    expect(circle[0].groups.length).toBeGreaterThan(0);
  });

  it('shows what a search finds in its groups, and a matching group with all it holds', () => {
    expect(screenTree(groups, screens, computers, 'ticket').map(outline)).toEqual([
      [{ Edvisor: [{ Linear: ['Ticket queue'] }] }],
    ]);
    expect(screenTree(groups, screens, computers, 'unreal ').map(outline)).toEqual([
      [{ 'Unreal editors': ['NationGame editor', 'Bluevox editor'] }],
    ]);
    expect(screenTree(groups, screens, computers, 'LINEAR').map(outline)).toEqual([
      [{ Edvisor: [{ Linear: ['Ticket queue', 'Daily work log'] }] }],
    ]);
    expect(screenTree(groups, screens, computers, 'nothing')).toEqual([]);
    // Computers the fleet no longer knows show nothing.
    expect(screenTree(groups, screens, () => undefined)).toEqual([]);
  });

  it('offers each place a screen or a group can go, never a group into itself', () => {
    expect(screenDestinations(groups, desk, 'Desktop')).toEqual([
      { name: 'Desktop', depth: 0 },
      { id: uuid(2), name: 'Edvisor', depth: 1 },
      { id: uuid(4), name: 'archive', depth: 2 },
      { id: uuid(3), name: 'Linear', depth: 2 },
      { id: uuid(5), name: 'Empty', depth: 1 },
      { id: uuid(1), name: 'Unreal editors', depth: 1 },
    ]);
    expect(screenDestinations(groups, desk, 'Desktop', uuid(2)).map((d) => d.name)).toEqual([
      'Desktop',
      'Empty',
      'Unreal editors',
    ]);
    expect(screenDestinations(groups, wsl, 'Ubuntu').map((d) => d.name)).toEqual([
      'Ubuntu',
      'Edvisor',
    ]);
    expect(insideGroup(groups, uuid(3), uuid(2))).toBe(true);
    expect(insideGroup(groups, uuid(2), uuid(2))).toBe(true);
    expect(insideGroup(groups, uuid(2), uuid(3))).toBe(false);
    expect(shownGroup(groups, screens[2])).toBe(uuid(3));
    expect(shownGroup(groups, screen(9, 'Crossed', 6))).toBeUndefined();
    expect(shownParent(groups, groups[2])).toBe(uuid(2));
    expect(shownParent(groups, groups[0])).toBeUndefined();
  });

  it('shows a move or a rename at once and takes the computer’s answer whole', () => {
    const shelf = { screens, groups };
    const moved = regroupLocally(shelf, { op: 'moveScreen', id: uuid(1006), group: uuid(5) })!;
    expect(moved.screens.find((s) => s.title === 'Scratch')?.group).toBe(uuid(5));
    const out = regroupLocally(shelf, { op: 'moveScreen', id: uuid(1003) })!;
    expect('group' in out.screens.find((s) => s.title === 'Ticket queue')!).toBe(false);
    const renamed = regroupLocally(shelf, { op: 'renameGroup', group: uuid(5), name: ' Later ' })!;
    expect(renamed.groups.find((g) => g.id === uuid(5))?.name).toBe('Later');
    const nested = regroupLocally(shelf, { op: 'moveGroup', group: uuid(5), parent: uuid(1) })!;
    expect(nested.groups.find((g) => g.id === uuid(5))?.parent).toBe(uuid(1));
    const top = regroupLocally(shelf, { op: 'moveGroup', group: uuid(3) })!;
    expect('parent' in top.groups.find((g) => g.id === uuid(3))!).toBe(false);
    // A new or removed group waits for the computer.
    expect(
      regroupLocally(shelf, { op: 'createGroup', environmentId: desk, name: 'New' }),
    ).toBeUndefined();
    expect(regroupLocally(shelf, { op: 'deleteGroup', group: uuid(2) })).toBeUndefined();
    const answered = regrouped(screens, { groups, members: { [uuid(1006)]: uuid(1) } });
    expect(answered.find((s) => s.title === 'Scratch')?.group).toBe(uuid(1));
    expect(answered.find((s) => s.title === 'Ticket queue')?.group).toBeUndefined();
    // A list read before a change keeps the groups the change showed.
    const listed = keptGroups([screen(6, 'Scratch'), screen(8, 'New')], moved.screens);
    expect(listed.map((s) => s.group)).toEqual([uuid(5), undefined]);
  });
});
