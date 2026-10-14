import { expect, it } from 'vitest';
import { leaveChats, type ArtifactView, type SubagentView } from './side-panels';

const artifact = (id: string, mode: ArtifactView['mode']): ArtifactView => ({
  artifact: { id, title: id, language: 'html', source: `<p>${id}</p>` },
  mode,
  focus: true,
});
const subagent = (agentId: string): SubagentView => ({ messageId: 'reply', agentId, focus: true });

it('keeps the side panels of the chats left behind, which no longer take focus', () => {
  const artifacts = { a: artifact('a:0', 'panel'), b: artifact('b:0', 'panel') };
  const subagents = { c: subagent('reader'), b: subagent('writer') };
  leaveChats(artifacts, subagents, 'b');
  expect(artifacts).toEqual({
    a: { ...artifact('a:0', 'panel'), focus: false },
    b: artifact('b:0', 'panel'),
  });
  expect(subagents).toEqual({ c: { ...subagent('reader'), focus: false }, b: subagent('writer') });
});

it('closes the modal of a chat left behind, and keeps the one on screen', () => {
  const artifacts = { a: artifact('a:0', 'modal'), b: artifact('b:0', 'modal') };
  const subagents = { a: subagent('reader') };
  leaveChats(artifacts, subagents, 'b');
  expect(artifacts).toEqual({ b: artifact('b:0', 'modal') });
  // Its sub-agent stays beside the chat beneath the modal.
  expect(subagents).toEqual({ a: { ...subagent('reader'), focus: false } });
});

it('leaves every chat while none is on screen', () => {
  const artifacts = { a: artifact('a:0', 'modal'), b: artifact('b:0', 'panel') };
  const subagents = { c: subagent('reader') };
  leaveChats(artifacts, subagents, null);
  expect(artifacts).toEqual({ b: { ...artifact('b:0', 'panel'), focus: false } });
  expect(subagents).toEqual({ c: { ...subagent('reader'), focus: false } });
});
