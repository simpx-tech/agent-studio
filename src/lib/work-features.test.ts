import { describe, expect, it } from 'vitest';
import { responseArtifacts, maxArtifactBytes, artifactFilename } from './artifacts';
import { initialWorkspace, restoreWorkspace, type Message, type RunEvent } from './domain';
import { applyRunEvent, retainRunEvent } from './activity';
import { planStepLabel } from './plans';
import { workflowSchema } from './workflows';
import { mergeShared, sharedWorkspace } from './sync';

describe('artifacts and portable progress', () => {
  it('extracts only closed HTML/SVG fences and preserves exact source for download', () => {
    const source = '<h1>Hi</h1>\n<script>document.body.dataset.ready="yes"</script>';
    const a = responseArtifacts(
      '```html Dashboard\n' + source + '\n```\n```js\nalert(1)\n```\n```svg\n<svg/>\n```',
      'reply',
    );
    expect(a).toHaveLength(2);
    expect(a[0].source).toBe(source);
    expect(a[0].title).toBe('Dashboard');
    expect(responseArtifacts('```html\n' + source, 'reply')).toEqual([]);
    expect(
      responseArtifacts('```html\n' + 'x'.repeat(maxArtifactBytes + 1) + '\n```', 'reply'),
    ).toEqual([]);
    expect(artifactFilename({ ...a[0], title: '../unsafe:thing' })).not.toContain('/');
  });
  it('keeps the latest plans across replay, history, and conflicts without inventing completion', () => {
    const message: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      status: 'running',
      blocks: [],
      createdAt: new Date().toISOString(),
      runId: crypto.randomUUID(),
    };
    const plan = { revision: 2, steps: [{ id: '1', title: 'Check', status: 'running' as const }] };
    const event: RunEvent = { kind: 'plan', plan };
    applyRunEvent(message, event);
    applyRunEvent(message, { kind: 'plan', plan: { ...plan, revision: 1, steps: [] } });
    expect(message.plan).toEqual(plan);
    const events: RunEvent[] = [];
    retainRunEvent(events, event);
    retainRunEvent(events, { kind: 'plan', plan: { ...plan, revision: 0, steps: [] } });
    expect(events).toEqual([event]);
    expect(planStepLabel('running', 'complete')).toBe('Not confirmed complete');
    const workspace = initialWorkspace();
    workspace.conversations.push({
      id: crypto.randomUUID(),
      settings: { provider: 'claude', model: '', instructions: '', reasoning: '' },
      title: 'Test',
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
      messages: [message],
    });
    const restored = restoreWorkspace(workspace);
    expect(restored.conversations[0].messages[0].plan).toEqual(plan);
    expect(restored.conversations[0].messages[0].status).toBe('cancelled');
    const base = sharedWorkspace(workspace),
      left = structuredClone(base),
      right = structuredClone(base);
    left.conversations[0].messages[0].plan!.revision = 3;
    right.conversations[0].messages[0].blocks = [{ type: 'markdown', text: 'Final answer' }];
    right.conversations[0].messages[0].status = 'complete';
    const merged = mergeShared(base, left, right);
    expect(merged.conversations).toHaveLength(1);
    expect(merged.conversations[0].messages[0].plan!.revision).toBe(3);
  });
  it('bounds workflow definitions and preserves concurrent edits as copies', () => {
    const workflow = {
      id: crypto.randomUUID(),
      name: 'Draft',
      steps: [{ title: 'Write', prompt: 'Write the draft' }],
    };
    expect(workflowSchema.safeParse({ ...workflow, steps: [] }).success).toBe(false);
    const base = sharedWorkspace({ ...initialWorkspace(), workflows: [workflow] });
    const left = structuredClone(base),
      right = structuredClone(base);
    left.workflows![0].name = 'Local';
    right.workflows![0].name = 'Remote';
    const result = mergeShared(base, left, right);
    expect(result.workflows!.map((w) => w.name)).toEqual(['Remote', 'Local (conflict copy)']);
    expect(restoreWorkspace({ ...initialWorkspace(), ...result }).workflows).toHaveLength(2);
  });
});
