import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  changelogSection,
  codeSpans,
  commitChanges,
  loadChangelog,
  parseChangelog,
  releaseNotes,
  withRelease,
} from './changelog';

const sample = [
  '# Changelog',
  '',
  'Intro text about the file.',
  '',
  '## 1.2.0 - 2026-10-02',
  '',
  'A summary that',
  'spans two lines.',
  '',
  '### Added',
  '',
  '- A feature with `code`',
  '- A long change that',
  '  continues here',
  '',
  '### Fixed',
  '',
  '- A fix',
  '',
  '## 1.1.9 - 2026-10-02',
  '',
  '### Changed',
  '',
  '- An older change',
  '',
].join('\n');

describe('the bundled changelog', () => {
  it('parses and starts with the current version', async () => {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
    const releases = parseChangelog(readFileSync('CHANGELOG.md', 'utf8'));
    // npm run release:version adds the section; a hand-edited bump must add it too.
    expect(releases[0]?.version, 'Add the new version to CHANGELOG.md.').toBe(version);
    // The app loads the same text through Vite.
    expect(await loadChangelog()).toEqual(releases);
  });
});

describe('changelog parsing', () => {
  it('reads releases, summaries, groups, and continued changes', () => {
    expect(parseChangelog(sample)).toEqual([
      {
        version: '1.2.0',
        date: '2026-10-02',
        summary: 'A summary that spans two lines.',
        groups: [
          { title: 'Added', items: ['A feature with `code`', 'A long change that continues here'] },
          { title: 'Fixed', items: ['A fix'] },
        ],
      },
      {
        version: '1.1.9',
        date: '2026-10-02',
        groups: [{ title: 'Changed', items: ['An older change'] }],
      },
    ]);
    expect(parseChangelog(sample.replace(/\n/g, '\r\n'))).toEqual(parseChangelog(sample));
    expect(parseChangelog('# Changelog\n\nNothing released yet.\n')).toEqual([]);
  });

  it('rejects text outside the format with its line number', () => {
    const cases: [string, RegExp][] = [
      [sample.replace('## 1.2.0 - 2026-10-02', '## v1.2.0'), /line 5: Write release headings/],
      [sample.replace('2026-10-02', '2026-02-30'), /line 5: 2026-02-30 is not a date/],
      [sample.replace('## 1.1.9', '## 1.2.1'), /1\.2\.1 follows 1\.2\.0/],
      [sample.replace('## 1.1.9', '## 1.2.0'), /1\.2\.0 follows 1\.2\.0/],
      [sample.replace('1.1.9 - 2026-10-02', '1.1.9 - 2026-10-03'), /dated after the newer 1\.2\.0/],
      [sample.replace('### Fixed', '### Fixes'), /line 16: Use one of Added, .* not "Fixes"/],
      [sample.replace('### Fixed', '### Added'), /1\.2\.0 lists Added twice/],
      [sample.replace('- A fix', 'A fix'), /line 18: Write changes as "- " list items/],
      [sample.replace('### Added\n\n', ''), /line 10: Put changes under a "### Group"/],
      [sample.replace('- A long change that', ''), /line 14: Only a change continues/],
      [sample.replace('### Changed\n\n- An older change\n', ''), /1\.1\.9 lists no changes\.$/],
      [
        sample.replace('### Fixed\n\n- A fix\n', '### Fixed\n'),
        /1\.2\.0 lists no changes under Fixed/,
      ],
      [sample.replace('### Fixed', '#### Fixed'), /line 16: Use "## x\.y\.z - YYYY-MM-DD"/],
      ['### Added\n\n- Early\n', /line 1: Put change groups under a release heading/],
    ];
    for (const [text, error] of cases) expect(() => parseChangelog(text)).toThrow(error);
  });
});

describe('changelog sections from commits', () => {
  it('groups features, fixes, and other changes, leaving out internal commits', () => {
    expect(
      commitChanges([
        'feat: show the app version',
        'fix(relay): keep sessions after restarts',
        'perf: load the changelog on demand',
        'feat!: replace the settings layout',
        'Clarify standalone chats',
        'wip: something odd',
        'chore: bump the version to 0.2.1',
        'docs: explain releases',
        'ci: cache builds',
        'test: cover parsing',
        'refactor: simplify transport',
        'build: update Vite',
        'style: format',
        'fix: keep sessions after restarts',
        'feat:   ',
      ]),
    ).toEqual([
      { title: 'Added', items: ['Show the app version', 'Replace the settings layout'] },
      {
        title: 'Changed',
        items: ['Load the changelog on demand', 'Clarify standalone chats', 'Wip: something odd'],
      },
      { title: 'Fixed', items: ['Keep sessions after restarts'] },
    ]);
    expect(commitChanges(['chore: tidy', 'docs: explain'])).toEqual([]);
  });

  it('adds a parseable section above the newest release, keeping line endings', () => {
    const subjects = () => ['feat: show the app version', 'fix: keep drafts'];
    const updated = withRelease(sample, '1.3.0', '2026-10-05', subjects);
    const section = changelogSection('1.3.0', '2026-10-05', [
      { title: 'Added', items: ['Show the app version'] },
      { title: 'Fixed', items: ['Keep drafts'] },
    ]);
    expect(updated).toBe(sample.replace('## 1.2.0', `${section}\n\n## 1.2.0`));
    expect(section).toBe(
      '## 1.3.0 - 2026-10-05\n\n### Added\n\n- Show the app version\n\n### Fixed\n\n- Keep drafts',
    );
    expect(parseChangelog(updated)[0]).toMatchObject({ version: '1.3.0', date: '2026-10-05' });

    const windows = sample.replace(/\n/g, '\r\n');
    expect(withRelease(windows, '1.3.0', '2026-10-05', subjects)).toBe(
      updated.replace(/\n/g, '\r\n'),
    );
    // A section written by hand stays, and the commits are not read.
    const unread = () => {
      throw new Error('Commits were read.');
    };
    expect(withRelease(sample, '1.2.0', '2026-10-05', unread)).toBe(sample);
    // Without user-facing commits the section still lists a change to edit.
    expect(parseChangelog(withRelease(sample, '1.2.1', '2026-10-05', () => []))[0].groups).toEqual([
      { title: 'Changed', items: ['Maintenance and internal improvements'] },
    ]);
    expect(withRelease('# Changelog\n', '0.1.0', '2026-10-05', subjects)).toBe(
      `# Changelog\n\n${changelogSection('0.1.0', '2026-10-05', commitChanges(subjects()))}\n`,
    );
    // A date before the newest release is rejected instead of written.
    expect(() => withRelease(sample, '1.3.0', '2026-10-01', subjects)).toThrow(/dated after/);
  });
});

describe('changelog presentation', () => {
  it('writes plain-text release notes', () => {
    const [newest, older] = parseChangelog(sample);
    expect(releaseNotes(newest)).toBe(
      'A summary that spans two lines.\n\nAdded\n- A feature with `code`\n- A long change that continues here\n\nFixed\n- A fix',
    );
    expect(releaseNotes(older)).toBe('Changed\n- An older change');
  });

  it('separates code spans without interpreting other text', () => {
    expect(codeSpans('Run `npm test` before <b>pushing</b>')).toEqual([
      { text: 'Run ', code: false },
      { text: 'npm test', code: true },
      { text: ' before <b>pushing</b>', code: false },
    ]);
    expect(codeSpans('`--fast`')).toEqual([{ text: '--fast', code: true }]);
    expect(codeSpans('An unmatched ` stays')).toEqual([
      { text: 'An unmatched ` stays', code: false },
    ]);
    expect(codeSpans('Plain')).toEqual([{ text: 'Plain', code: false }]);
  });
});
