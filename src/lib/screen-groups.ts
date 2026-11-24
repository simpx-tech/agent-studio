import type { Component } from 'svelte';
import type { ScreenGroup, ScreenGroups, ScreenRequest, ScreenSummary } from './screens';

/**
 * The Screens tab as a tree (requested 2026-11-24: "allow to group screens (so I can group the
 * unreal editor screens, the edvisor screens, etc), I think may be interesting to have
 * subdivisions as well (tree)"). Each computer keeps its groups beside its screens
 * (src-tauri/src/screens/groups.rs); here they become, under each computer, its groups by name,
 * each holding its own groups and then its screens, newest first, and the screens in no group.
 */

/** A group as the tree shows it, with what it holds. */
export type ScreenGroupNode = {
  group: ScreenGroup;
  /** Its name and the names of the groups it is in, from the top. */
  path: string[];
  depth: number;
  groups: ScreenGroupNode[];
  screens: ScreenSummary[];
};
/** A computer's part of the tree. */
export type ScreenSection = {
  id: string;
  name: string;
  groups: ScreenGroupNode[];
  /** Its screens in no group. */
  screens: ScreenSummary[];
};
/** The computer an environment's screens show under. */
export type ScreenComputer = { id: string; name: string };
/** A computer's part of the tree as the sidebar shows it, and what can change there now. */
export type ScreenTreeSection = ScreenSection & {
  /** The environment a new group at its top holds; none when none can be made there. */
  environmentId?: string;
  /** Whether its computer's Agent Studio groups screens. */
  groupable: boolean;
  online: boolean;
};

export const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

const matches = (text: string, search: string) => text.toLowerCase().includes(search);
const screenText = (screen: ScreenSummary) =>
  `${screen.title} ${screen.description} ${screen.project}`;

/**
 * Each computer's groups and screens as the tree shows them, the computers by name. A screen
 * whose group is gone, or holds another environment's screens, shows at the top of its computer;
 * a group whose parent is gone shows at the top. With a search, the tree keeps the screens that
 * match and the groups that match or hold a match, a matching group with all it holds.
 */
export function screenTree(
  groups: ScreenGroup[],
  screens: ScreenSummary[],
  computerOf: (environmentId: string) => ScreenComputer | undefined,
  search = '',
): ScreenSection[] {
  const query = search.trim().toLowerCase();
  const sections = new Map<string, ScreenSection & { all: ScreenGroup[]; held: ScreenSummary[] }>();
  const section = (environmentId: string) => {
    const computer = computerOf(environmentId);
    if (!computer) return;
    let found = sections.get(computer.id);
    if (!found) {
      found = { ...computer, groups: [], screens: [], all: [], held: [] };
      sections.set(computer.id, found);
    }
    return found;
  };
  for (const group of groups) section(group.environmentId)?.all.push(group);
  for (const screen of screens) section(screen.environmentId)?.held.push(screen);
  const result: ScreenSection[] = [];
  for (const found of sections.values()) {
    const known = new Map(found.all.map((group) => [group.id, group]));
    const children = new Map<string | undefined, ScreenGroup[]>();
    for (const group of found.all) {
      const parent = group.parent;
      const top =
        !parent ||
        parent === group.id ||
        known.get(parent)?.environmentId !== group.environmentId ||
        circles(known, group.id);
      const key = top ? undefined : parent;
      children.set(key, [...(children.get(key) ?? []), group]);
    }
    const inGroup = new Map<string | undefined, ScreenSummary[]>();
    for (const screen of found.held) {
      const group = screen.group ? known.get(screen.group) : undefined;
      const key = group && group.environmentId === screen.environmentId ? group.id : undefined;
      inGroup.set(key, [...(inGroup.get(key) ?? []), screen]);
    }
    const build = (group: ScreenGroup, path: string[], depth: number, shown: boolean) => {
      const named = shown || (!!query && matches(group.name, query));
      const node: ScreenGroupNode = {
        group,
        path: [...path, group.name],
        depth,
        groups: [],
        screens: (inGroup.get(group.id) ?? []).filter(
          (screen) => !query || named || matches(screenText(screen), query),
        ),
      };
      node.groups = [...(children.get(group.id) ?? [])]
        .sort(byName)
        .map((child) => build(child, node.path, depth + 1, named))
        .filter((child): child is ScreenGroupNode => !!child);
      return !query || named || node.groups.length || node.screens.length ? node : undefined;
    };
    const tops = [...(children.get(undefined) ?? [])]
      .sort(byName)
      .map((group) => build(group, [], 0, false))
      .filter((node): node is ScreenGroupNode => !!node);
    const loose = (inGroup.get(undefined) ?? []).filter(
      (screen) => !query || matches(screenText(screen), query),
    );
    if (tops.length || loose.length)
      result.push({ id: found.id, name: found.name, groups: tops, screens: loose });
  }
  return result.sort(byName);
}

/** Whether following a group's parents leads back to it, which no change makes. */
function circles(known: Map<string, ScreenGroup>, id: string) {
  const seen = new Set<string>();
  let next = known.get(id)?.parent;
  while (next) {
    if (next === id) return true;
    if (seen.has(next)) return false;
    seen.add(next);
    next = known.get(next)?.parent;
  }
  return false;
}

/** Whether the group `id` is the group `outer` or lies inside it. */
export function insideGroup(groups: ScreenGroup[], id: string | undefined, outer: string) {
  const known = new Map(groups.map((group) => [group.id, group]));
  const seen = new Set<string>();
  for (let next = id; next && !seen.has(next); next = known.get(next)?.parent) {
    if (next === outer) return true;
    seen.add(next);
  }
  return false;
}

/** A place a screen or a group can go: a group, or the top of its computer when `id` is none. */
export type ScreenDestination = { id?: string; name: string; depth: number };

/**
 * Where something of `environmentId` can go, in the tree's order: the top of its computer, then
 * each group of that environment, leaving out the group `moving` and what it holds.
 */
export function screenDestinations(
  groups: ScreenGroup[],
  environmentId: string,
  top: string,
  moving?: string,
): ScreenDestination[] {
  const own = groups.filter((group) => group.environmentId === environmentId);
  const known = new Map(own.map((group) => [group.id, group]));
  const children = new Map<string | undefined, ScreenGroup[]>();
  for (const group of own) {
    const key =
      group.parent && known.has(group.parent) && !circles(known, group.id)
        ? group.parent
        : undefined;
    children.set(key, [...(children.get(key) ?? []), group]);
  }
  const list: ScreenDestination[] = [{ name: top, depth: 0 }];
  const walk = (parent: string | undefined, depth: number) => {
    for (const group of [...(children.get(parent) ?? [])].sort(byName)) {
      if (group.id === moving) continue;
      list.push({ id: group.id, name: group.name, depth });
      walk(group.id, depth + 1);
    }
  };
  walk(undefined, 1);
  return list;
}

/** Something a screen's or a group's menu does. */
export type ScreenMenuAction = {
  label: string;
  icon: Component<{ size?: number; 'aria-hidden'?: 'true' }>;
  run: () => void;
};

/** A change to how a computer's screens are grouped. */
export type RegroupRequest = Extract<
  ScreenRequest,
  { op: 'createGroup' | 'renameGroup' | 'moveGroup' | 'deleteGroup' | 'moveScreen' }
>;

/** The group a screen shows in: its own, when that group holds the screen's environment. */
export function shownGroup(groups: ScreenGroup[], screen: ScreenSummary) {
  const group = screen.group ? groups.find((known) => known.id === screen.group) : undefined;
  return group && group.environmentId === screen.environmentId ? group.id : undefined;
}
/** The group a group shows in: its parent, when that holds the same environment's screens. */
export function shownParent(groups: ScreenGroup[], group: ScreenGroup) {
  const known = new Map(groups.map((other) => [other.id, other]));
  const parent = group.parent ? known.get(group.parent) : undefined;
  return parent &&
    parent.id !== group.id &&
    parent.environmentId === group.environmentId &&
    !circles(known, group.id)
    ? parent.id
    : undefined;
}

/**
 * What a move or a rename does to a computer's screens and groups, shown at once while its
 * computer answers. Other changes wait for the answer: a new group needs its id, and a removed
 * one joins groups of the same names.
 */
export function regroupLocally(
  shelf: { screens: ScreenSummary[]; groups?: ScreenGroup[] },
  request: RegroupRequest,
): { screens: ScreenSummary[]; groups: ScreenGroup[] } | undefined {
  const groups = shelf.groups ?? [];
  switch (request.op) {
    case 'moveScreen':
      return {
        groups,
        screens: shelf.screens.map((screen) => {
          if (screen.id !== request.id) return screen;
          const { group: _old, ...rest } = screen;
          return request.group ? { ...rest, group: request.group } : rest;
        }),
      };
    case 'moveGroup':
    case 'renameGroup':
      return {
        screens: shelf.screens,
        groups: groups.map((group) => {
          if (group.id !== request.group) return group;
          if (request.op === 'renameGroup') return { ...group, name: request.name.trim() };
          const { parent: _old, ...rest } = group;
          return request.parent ? { ...rest, parent: request.parent } : rest;
        }),
      };
    default:
      return undefined;
  }
}

/** A computer's screens as a list read them, each in the group `previous` shows it in. */
export function keptGroups(screens: ScreenSummary[], previous: ScreenSummary[]): ScreenSummary[] {
  const groups = new Map(previous.map((screen) => [screen.id, screen.group]));
  return screens.map((screen) => {
    if (!groups.has(screen.id) || groups.get(screen.id) === screen.group) return screen;
    const { group: _old, ...rest } = screen;
    const group = groups.get(screen.id);
    return group ? { ...rest, group } : rest;
  });
}

/** A computer's screens and groups as a change answered them. */
export function regrouped(
  screens: ScreenSummary[],
  answer: Pick<ScreenGroups, 'groups' | 'members'>,
): ScreenSummary[] {
  return screens.map((screen) => {
    const group = answer.members[screen.id];
    if (group === screen.group) return screen;
    const { group: _old, ...rest } = screen;
    return group ? { ...rest, group } : rest;
  });
}
