// CHANGELOG.md lists each release, newest first. Settings → About shows it, and each GitHub
// release uses its section as notes. See docs/UPDATES.md.
//
//   ## 0.2.1 - 2026-09-24
//
//   An optional summary paragraph.
//
//   ### Fixed
//
//   - Keep the Viewer's workspace cache in IndexedDB
//
// The release script loads this module with Node's type stripping, so it imports nothing.

export type ChangelogGroup = { title: string; items: string[] };
export type ChangelogRelease = {
  version: string;
  date: string;
  summary?: string;
  groups: ChangelogGroup[];
};

/** Allowed group headings, in the order generated sections use. */
export const changelogGroups = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

const releaseHeading = /^## (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*) - (\d{4}-\d{2}-\d{2})$/;
// Conventional commit subjects: type, optional scope, optional breaking-change mark.
const conventional = /^([a-z]+)(?:\([^)]*\))?!?:\s*(.*)$/i;
const commitGroups = new Map([
  ['feat', 'Added'],
  ['fix', 'Fixed'],
  ['perf', 'Changed'],
]);
// Commit types that describe no change to the app itself.
const internalCommits = new Set(['build', 'chore', 'ci', 'docs', 'refactor', 'style', 'test']);

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++)
    if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

function validDate(date: string): boolean {
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(date);
}

/**
 * Reads CHANGELOG.md, rejecting anything outside the format above: releases must be unique,
 * newest first, dated, and list at least one change.
 */
export function parseChangelog(text: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let release: ChangelogRelease | undefined;
  let group: ChangelogGroup | undefined;
  // Whether the previous line was a list item that an indented line continues.
  let item = false;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trimEnd();
    const fail = (reason: string) => new Error(`CHANGELOG.md line ${index + 1}: ${reason}`);
    if (!line) {
      item = false;
    } else if (line.startsWith('## ')) {
      const match = releaseHeading.exec(line);
      if (!match) throw fail('Write release headings as "## x.y.z - YYYY-MM-DD".');
      const version = `${match[1]}.${match[2]}.${match[3]}`;
      const date = match[4];
      if (!validDate(date)) throw fail(`${date} is not a date.`);
      if (release && compareVersions(version, release.version) >= 0)
        throw fail(`List releases newest first; ${version} follows ${release.version}.`);
      if (release && date > release.date)
        throw fail(`${version} is dated after the newer ${release.version}.`);
      release = { version, date, groups: [] };
      releases.push(release);
      group = undefined;
      item = false;
    } else if (line.startsWith('### ')) {
      if (!release) throw fail('Put change groups under a release heading.');
      const title = line.slice(4).trim();
      if (!changelogGroups.includes(title))
        throw fail(`Use one of ${changelogGroups.join(', ')} as a group heading, not "${title}".`);
      if (release.groups.some((existing) => existing.title === title))
        throw fail(`${release.version} lists ${title} twice.`);
      group = { title, items: [] };
      release.groups.push(group);
      item = false;
    } else if (line.startsWith('- ')) {
      if (!group) throw fail('Put changes under a "### Group" heading.');
      const change = line.slice(2).trim();
      if (!change) throw fail('A change needs a description.');
      group.items.push(change);
      item = true;
    } else if (/^\s/.test(line)) {
      if (!item || !group) throw fail('Only a change continues on an indented line.');
      group.items[group.items.length - 1] += ` ${line.trim()}`;
    } else if (line.startsWith('#')) {
      if (release)
        throw fail('Use "## x.y.z - YYYY-MM-DD" for releases and "### Group" for groups.');
    } else if (release && !group) {
      // The release's summary paragraph.
      release.summary = release.summary ? `${release.summary} ${line.trim()}` : line.trim();
    } else if (release) {
      throw fail('Write changes as "- " list items.');
    }
  }
  for (const { version, groups } of releases) {
    if (!groups.length) throw new Error(`CHANGELOG.md: ${version} lists no changes.`);
    const empty = groups.find((entry) => !entry.items.length);
    if (empty) throw new Error(`CHANGELOG.md: ${version} lists no changes under ${empty.title}.`);
  }
  return releases;
}

/**
 * Changelog groups for commit subjects since the previous release: features are Added, fixes
 * Fixed, and performance work and any other subject Changed. Build, CI, documentation,
 * refactoring, style, test and chore commits are left out.
 */
export function commitChanges(subjects: string[]): ChangelogGroup[] {
  const groups = new Map<string, string[]>();
  for (const subject of subjects) {
    const match = conventional.exec(subject.trim());
    const type = match?.[1].toLowerCase();
    if (type && internalCommits.has(type)) continue;
    const title = (type && commitGroups.get(type)) ?? 'Changed';
    const text = (match && commitGroups.has(type!) ? match[2] : subject).trim();
    if (!text) continue;
    const change = text[0].toUpperCase() + text.slice(1);
    const items = groups.get(title) ?? [];
    if (!items.includes(change)) items.push(change);
    groups.set(title, items);
  }
  return changelogGroups
    .filter((title) => groups.has(title))
    .map((title) => ({ title, items: groups.get(title)! }));
}

/** A release section in CHANGELOG.md's format, without a trailing line break. */
export function changelogSection(version: string, date: string, groups: ChangelogGroup[]): string {
  const lines = [`## ${version} - ${date}`];
  for (const group of groups)
    lines.push('', `### ${group.title}`, '', ...group.items.map((change) => `- ${change}`));
  return lines.join('\n');
}

/**
 * Adds a section for `version` above the newest release, listing `subjects()` (commit subjects
 * since the previous release) and keeping the file's line endings. A changelog that already
 * lists the version is returned unchanged, so a section written by hand is kept.
 */
export function withRelease(
  changelog: string,
  version: string,
  date: string,
  subjects: () => string[],
): string {
  if (parseChangelog(changelog).some((release) => release.version === version)) return changelog;
  const changes = commitChanges(subjects());
  const section = changelogSection(
    version,
    date,
    changes.length
      ? changes
      : [{ title: 'Changed', items: ['Maintenance and internal improvements'] }],
  );
  const text = changelog.replace(/\r\n/g, '\n');
  const newest = text.search(/^## /m);
  const updated =
    newest < 0
      ? `${text.trimEnd()}\n\n${section}\n`
      : `${text.slice(0, newest)}${section}\n\n${text.slice(newest)}`;
  // Catches a date or version that does not fit before the newest release.
  parseChangelog(updated);
  return changelog.includes('\r\n') ? updated.replace(/\n/g, '\r\n') : updated;
}

/** Plain-text release notes that read well in the app's update details and on GitHub. */
export function releaseNotes(release: ChangelogRelease): string {
  return [
    ...(release.summary ? [release.summary] : []),
    ...release.groups.map((group) =>
      [group.title, ...group.items.map((change) => `- ${change}`)].join('\n'),
    ),
  ].join('\n\n');
}

/** Splits `code` spans from plain text, so the UI renders them without interpreting HTML. */
export function codeSpans(text: string): { text: string; code: boolean }[] {
  const parts = text.split('`');
  // An unmatched backtick stays literal text.
  if (parts.length % 2 === 0) return [{ text, code: false }];
  return parts
    .map((part, index) => ({ text: part, code: index % 2 === 1 }))
    .filter((part) => part.text);
}

/** The changelog bundled with this build, loaded on demand to keep it out of the main bundle. */
export async function loadChangelog(): Promise<ChangelogRelease[]> {
  const { default: text } = await import('virtual:changelog');
  return parseChangelog(text);
}
