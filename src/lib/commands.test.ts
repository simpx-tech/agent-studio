import { describe, expect, it } from 'vitest';
import { commandChoices, commandQuery, commandToken, filterCommands } from './commands';
import { historyFor, initialWorkspace, restoreWorkspace } from './domain';
import { sharedSchema, sharedWorkspace } from './sync';
import type { ContextSnapshot } from './context';

const catalog: ContextSnapshot = {
  provider: 'codex',
  model: '',
  checkedAt: 1,
  execution: 'WSL',
  folder: '/project',
  profile: '/profile',
  notes: [],
  truncated: false,
  commands: [],
  entries: ['reported', 'disabled', 'discovered', 'shadowed'].map((status, i) => ({
    name: `skill-${i}`,
    path: `/profile/${i}/SKILL.md`,
    kind: 'skills',
    status: status as 'reported',
    scope: 'User',
    detail: '',
  })),
};
describe('composer commands', () => {
  it('recognizes a leading command at the caret without swallowing paths, prose, or arguments', () => {
    expect(commandQuery('/skill rest', 4)).toBe('ski');
    expect(commandQuery('/skill rest', 8)).toBeUndefined();
    expect(commandQuery('/', 1)).toBe('');
    for (const text of ['//example', '/tmp/file', 'text /skill', '`/skill`'])
      expect(commandToken(text)).toBeNull();
    expect(commandToken('/plugin:skill arg')?.[1]).toBe('plugin:skill');
  });
  it('uses only confirmed skills for the selected provider and preserves duplicate source identities', () => {
    const options = commandChoices('codex', catalog);
    expect(options.filter((c) => c.kind === 'skill').map((c) => c.name)).toEqual(['/skill-0']);
    expect(
      commandChoices('claude', catalog).every((c) => c.kind === 'app' || c.kind === 'compact'),
    ).toBe(true);
    expect(
      commandChoices('codex', { ...catalog, commands: undefined }).every(
        (c) => c.kind === 'app' || c.kind === 'compact',
      ),
    ).toBe(true);
    const duplicate = {
      ...catalog,
      entries: [catalog.entries[0], { ...catalog.entries[0], path: '/project/SKILL.md' }],
    };
    const matched = filterCommands(commandChoices('codex', duplicate), 'skill-0');
    expect(matched).toHaveLength(2);
    expect(new Set(matched.map((c) => c.id)).size).toBe(2);
    const native = commandChoices('claude', {
      ...catalog,
      provider: 'claude',
      commands: [
        { name: 'plugin:review', description: 'Review files', argumentHint: '[file]' },
        { name: 'compact', description: '', argumentHint: '' },
      ],
    });
    expect(native.some((c) => c.name === '/plugin:review')).toBe(true);
    expect(native.find((c) => c.name === '/compact')?.kind).toBe('compact');
  });
  it('preserves skill identity in saved, exported and relayed user history but excludes assistant references', () => {
    const workspace = initialWorkspace(),
      now = new Date().toISOString();
    const skills = [{ name: 'review', path: '/selected/profile/skills/review/SKILL.md' }];
    workspace.conversations.push({
      id: crypto.randomUUID(),
      title: 'Skill',
      createdAt: now,
      updatedAt: now,
      settings: { provider: 'codex', model: '', reasoning: '', instructions: '' },
      messages: [
        {
          id: crypto.randomUUID(),
          role: 'user',
          blocks: [{ type: 'markdown', text: '/review arguments' }],
          skills,
          status: 'complete',
          createdAt: now,
        },
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          blocks: [{ type: 'markdown', text: 'Done' }],
          skills,
          status: 'complete',
          createdAt: now,
        },
      ],
    });
    const restored = restoreWorkspace(JSON.parse(JSON.stringify(workspace)));
    const shared = sharedSchema.parse(sharedWorkspace(restored));
    expect(shared.conversations[0].messages[0].skills).toEqual(skills);
    const history = historyFor(restored.conversations[0]);
    expect(history[0]).toMatchObject({ text: '/review arguments', skills });
    expect(history[1].skills).toBeUndefined();
  });
});
