import type { ContextSnapshot } from './context';
import type { ProviderId, SkillReference } from './domain';

export type ComposerCommand = {
  id: string;
  name: string;
  detail: string;
  title?: string;
  kind: 'app' | 'native' | 'skill' | 'compact';
  skill?: SkillReference;
};
export const appCommands: ComposerCommand[] = [
  ['help', 'Show commands and skills'],
  ['new', 'Start a new conversation'],
  ['model', 'Choose the model for your next message'],
  ['reasoning', 'Choose reasoning for your next message'],
  ['instructions', 'Edit conversation instructions'],
  ['context', 'Inspect model context and available skills'],
  ['usage', 'Show usage and context limits'],
  ['connections', 'Manage computers and agent accounts'],
  ['settings', 'Notifications, workspace administration, and data'],
].map(([name, detail]) => ({
  id: `app:${name}`,
  name: `/${name}`,
  detail: `App · ${detail}`,
  kind: 'app',
}));

// These terminal/session operations need a live interactive session. A conversation's
// CLI process may restart between replies, so do not present them as working commands.
export const sessionCommands = new Set([
  'clear',
  'resume',
  'fork',
  'rewind',
  'exit',
  'quit',
  'workflows',
  'color',
  'config',
  'effort',
  'fast',
  'heapdump',
  'mcp',
  'reload-plugins',
  'reload-skills',
  'rename',
  'recap',
  'skill-doctor',
  '__remote-workflow',
  'workflow-launch-exec',
  'context-window',
  'loop',
]);
export function commandToken(text: string) {
  return /^\/([\w:.-]+)(?=\s|$)/.exec(text);
}
export function commandQuery(text: string, caret: number): string | undefined {
  return /^\/([\w:.-]*)$/.exec(text.slice(0, caret))?.[1];
}
export function commandChoices(
  provider: ProviderId,
  snapshot?: ContextSnapshot,
): ComposerCommand[] {
  const choices = [...appCommands];
  if (provider === 'claude' || provider === 'codex')
    choices.push({
      id: 'compact',
      name: '/compact',
      kind: 'compact',
      detail: 'Compact the current native conversation context',
    });
  // The command catalog was introduced with native skill-input support. Older
  // hosts omit it and must not silently accept then discard a skill reference.
  if (!snapshot || snapshot.provider !== provider || !Array.isArray(snapshot.commands))
    return choices;
  if (provider === 'claude') {
    for (const command of snapshot.commands ?? []) {
      if (sessionCommands.has(command.name) || choices.some((c) => c.name === `/${command.name}`))
        continue;
      choices.push({
        id: `native:${command.name}`,
        name: `/${command.name}`,
        kind: 'native',
        detail: `Claude · ${command.description || 'Command or skill'}${command.argumentHint ? ` · ${command.argumentHint}` : ''}`,
      });
    }
  } else if (provider === 'codex') {
    for (const entry of snapshot.entries) {
      if (entry.kind !== 'skills' || entry.status !== 'reported' || !/^[\w:.-]+$/.test(entry.name))
        continue;
      choices.push({
        id: `skill:${entry.path}`,
        name: `/${entry.name}`,
        kind: 'skill',
        detail: `Skill · ${entry.scope} · ${entry.path}`,
        title: entry.path,
        skill: { name: entry.name, path: entry.path },
      });
    }
  }
  return choices;
}
export function filterCommands(choices: ComposerCommand[], query: string) {
  const term = query.toLowerCase();
  return choices
    .filter((c) => c.name.toLowerCase().includes(term) || c.detail.toLowerCase().includes(term))
    .sort(
      (a, b) =>
        Number(!a.name.slice(1).toLowerCase().startsWith(term)) -
        Number(!b.name.slice(1).toLowerCase().startsWith(term)),
    );
}
