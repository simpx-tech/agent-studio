import { describe, expect, it } from 'vitest';
import {
  responseArtifacts,
  messageArtifacts,
  artifactFilename,
  artifactFence,
  artifactKey,
  artifactTitle,
  shownAsArtifact,
} from './artifacts';
import { initialWorkspace, restoreWorkspace, type Message, type RunEvent } from './domain';
import { applyRunEvent, retainRunEvent } from './activity';
import {
  planCountText,
  planProgress,
  planStepLabel,
  runningPlanProgress,
  type Plan,
} from './plans';
import { nativeWorkflowStatus, workflowSchema } from './workflows';
import { mergeShared, sharedWorkspace } from './sync';
import { nativeWorkflowFixture } from '../../tests/native-workflow-fixture';

describe('artifacts and portable progress', () => {
  it('keeps parent artifacts after a native completion summary without treating tool output as source', () => {
    const html = '```html Counter\n<h1>Counter</h1>\n```';
    const message: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      status: 'complete',
      createdAt: new Date().toISOString(),
      blocks: [
        { type: 'markdown', text: 'All tasks done. The artifact is above.' },
        { type: 'activity', progress: { id: 'parent', revision: 2 }, text: html },
        { type: 'activity', text: '```html\n<h1>Tool output</h1>\n```' },
      ],
    };
    expect(messageArtifacts(message).map((a) => a.source)).toEqual(['<h1>Counter</h1>']);
    message.blocks.push({ type: 'markdown', text: html });
    expect(messageArtifacts(message)).toHaveLength(1);
    message.role = 'user';
    expect(messageArtifacts(message)).toEqual([]);
  });
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
      responseArtifacts('```html\n' + 'x'.repeat(600_000) + '\n```', 'reply'),
    ).toHaveLength(1);
    expect(artifactFilename({ ...a[0], title: '../unsafe:thing' })).not.toContain('/');
  });
  it('shows named fences and whole pages as artifacts, and other html and svg as code', () => {
    expect(artifactFence('html Sales report')).toEqual({ language: 'html', name: 'Sales report' });
    expect(artifactFence('SVG  title="Logo"')).toEqual({ language: 'svg', name: 'Logo' });
    expect(artifactFence('html')).toEqual({ language: 'html', name: '' });
    expect(artifactFence('htmlbars Page')).toBeUndefined();
    expect(artifactFence('js Page')).toBeUndefined();
    expect(artifactFence(undefined)).toBeUndefined();
    const named = artifactFence('html Page')!;
    const unnamed = artifactFence('html')!;
    const svg = artifactFence('svg')!;
    // The name a model gives its artifact makes one, whatever the source.
    expect(shownAsArtifact(named, '<button>Go</button>')).toBe(true);
    expect(shownAsArtifact(artifactFence('svg Logo')!, '<svg/>')).toBe(true);
    // A whole page is an artifact by itself, also after comments and in any case.
    for (const page of [
      '<!doctype html><title>x</title>',
      '\n  <!DOCTYPE HTML>\n<html>',
      '<!-- generated -->\n<html lang="pt-BR">',
      '<html>',
    ])
      expect(shownAsArtifact(unnamed, page)).toBe(true);
    // Snippets stay code a reply explains, and open from below it.
    for (const snippet of ['<div>Safe code</div>', '<htmlish/>', '<p>See <html></p>'])
      expect(shownAsArtifact(unnamed, snippet)).toBe(false);
    expect(shownAsArtifact(svg, '<svg viewBox="0 0 1 1"/>')).toBe(false);
    expect(artifactTitle(named, '<title>Ignored</title>', 0)).toBe('Page');
    expect(artifactTitle(unnamed, '<html><title>Quarterly</title>', 0)).toBe('Quarterly');
    expect(artifactTitle(svg, '<svg/>', 2)).toBe('SVG artifact 3');
    expect(artifactKey({ language: 'html', source: '<p>' })).not.toBe(
      artifactKey({ language: 'svg', source: '<p>' }),
    );
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
  it('summarizes plans and workflow runs for the footer without claiming unfinished work', () => {
    const reply = {
      role: 'assistant',
      status: 'running',
      plan: {
        revision: 1,
        steps: [
          { id: 'a', title: 'Write the Dockerfile', status: 'complete' },
          {
            id: 'b',
            title: 'Build the image',
            activeForm: 'Building the image',
            status: 'running',
          },
          { id: 'c', title: 'Test the image', status: 'pending' },
        ],
      },
    } as Message;
    expect(planProgress(reply)).toEqual({
      title: 'Plan',
      count: 2,
      complete: 1,
      total: 3,
      current: 'Building the image',
    });
    // A finished reply names no step in progress and counts the steps it completed; a legacy
    // sequence keeps its own name.
    expect(planProgress({ ...reply, status: 'complete' })?.current).toBeUndefined();
    expect(planProgress({ ...reply, status: 'complete' })).toMatchObject({ count: 1, total: 3 });
    const legacy = {
      ...reply,
      plan: undefined,
      workflow: { revision: 1, name: 'Release', steps: [{ title: 'Tag', status: 'running' }] },
    } as Message;
    expect(planProgress(legacy)).toMatchObject({ title: 'Release', current: 'Tag' });
    expect(planProgress({ ...reply, plan: undefined })).toBeUndefined();
    expect(nativeWorkflowStatus('running', 'running')).toBe('Running');
    expect(nativeWorkflowStatus('running', 'cancelled')).toBe('Stopped');
    expect(nativeWorkflowStatus('paused', 'complete')).toBe('Unconfirmed');
    expect(nativeWorkflowStatus('error', 'complete')).toBe('Failed');
    expect(nativeWorkflowStatus('arbitrary', 'running')).toBe('Unknown');
  });
  it('counts a plan step from its start while its reply runs, so the last step reads 5/5', () => {
    const status = (i: number, done: number, started: boolean): Plan['steps'][number]['status'] =>
      i < done ? 'complete' : i === done && started ? 'running' : 'pending';
    const reply = (state: Message['status'], done: number, started: boolean) =>
      ({
        role: 'assistant',
        status: state,
        plan: {
          revision: 1,
          steps: Array.from({ length: 5 }, (_, i) => ({
            id: String(i),
            title: `Step ${i + 1}`,
            status: status(i, done, started),
          })),
        },
      }) as Message;
    const last = planProgress(reply('running', 4, true))!;
    expect(last).toMatchObject({ count: 5, complete: 4, total: 5, current: 'Step 5' });
    expect(planCountText(last)).toBe('Step 5 of 5');
    expect(planCountText(last, 'plan step')).toBe('Plan step 5 of 5');
    // The first step counts once it starts, and a plan none of whose steps started counts none.
    expect(planProgress(reply('running', 0, true))).toMatchObject({ count: 1, complete: 0 });
    const unstarted = planProgress(reply('running', 0, false))!;
    expect(unstarted).toMatchObject({ count: 0, complete: 0 });
    expect(planCountText(unstarted, 'plan step')).toBe('0 of 5 plan steps complete');
    // Between steps, and once every step is done, the count is the steps completed.
    const between = planProgress(reply('running', 2, false))!;
    expect(between).toMatchObject({ count: 2, complete: 2 });
    expect(planCountText(between)).toBe('2 of 5 steps complete');
    expect(planProgress(reply('running', 5, false))).toMatchObject({ count: 5, complete: 5 });
    // A reply that ended with a step in progress counts only what it completed.
    for (const state of ['complete', 'cancelled', 'error'] as const) {
      const ended = planProgress(reply(state, 4, true))!;
      expect(ended).toMatchObject({ count: 4, complete: 4, total: 5 });
      expect(planCountText(ended)).toBe('4 of 5 steps complete');
    }
  });
  it('counts the plan of a running reply for its sidebar row, and none once replies end', () => {
    const steps = [
      { id: 'a', title: 'Inspect', status: 'complete' as const },
      { id: 'b', title: 'Change', status: 'running' as const },
      { id: 'c', title: 'Verify', status: 'pending' as const },
    ];
    const reply = (status: Message['status'], plan?: Message['plan']) =>
      ({ role: 'assistant', status, plan }) as Message;
    const ended = reply('complete', { revision: 1, steps });
    expect(runningPlanProgress([ended])).toBeUndefined();
    expect(runningPlanProgress([ended, reply('running')])).toBeUndefined();
    expect(runningPlanProgress([reply('running', { revision: 1, steps: [] })])).toBeUndefined();
    expect(runningPlanProgress([ended, reply('running', { revision: 1, steps })])).toMatchObject({
      count: 2,
      complete: 1,
      total: 3,
    });
    // A reply taking over another runs beside it: the newest plan reported counts.
    const earlier = reply('running', { revision: 2, steps: steps.slice(0, 2) });
    expect(runningPlanProgress([earlier, reply('running')])).toMatchObject({ total: 2 });
    expect(runningPlanProgress([earlier, reply('running', { revision: 1, steps })])).toMatchObject({
      total: 3,
    });
  });
  it('retains legacy definitions for export without converting them to native scripts', () => {
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
  it('retains native run identity and latest metadata across history and same-run relay merges', () => {
    const message: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      status: 'running',
      blocks: [],
      createdAt: new Date().toISOString(),
      runId: crypto.randomUUID(),
    };
    const snapshot = nativeWorkflowFixture();
    const event: RunEvent = { kind: 'nativeworkflow', nativeWorkflows: snapshot };
    applyRunEvent(message, event);
    applyRunEvent(message, { kind: 'nativeworkflow', nativeWorkflows: { revision: 1, runs: [] } });
    const events: RunEvent[] = [];
    retainRunEvent(events, event);
    retainRunEvent(events, { kind: 'nativeworkflow', nativeWorkflows: { revision: 0, runs: [] } });
    expect(events).toEqual([event]);
    expect(message.nativeWorkflows).toEqual(snapshot);
    const workspace = initialWorkspace();
    workspace.conversations.push({
      id: crypto.randomUUID(),
      title: 'Native',
      settings: { provider: 'claude', model: '', reasoning: '', instructions: '' },
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
      messages: [message],
    });
    expect(restoreWorkspace(workspace).conversations[0].messages[0].nativeWorkflows).toEqual(
      snapshot,
    );
    const base = sharedWorkspace(workspace),
      left = structuredClone(base),
      right = structuredClone(base);
    left.conversations[0].messages[0].nativeWorkflows!.revision = 4;
    left.conversations[0].messages[0].nativeWorkflows!.runs[0].status = 'complete';
    right.conversations[0].messages[0].blocks = [{ type: 'markdown', text: 'Result' }];
    right.conversations[0].messages[0].status = 'complete';
    const merged = mergeShared(base, left, right);
    expect(merged.conversations).toHaveLength(1);
    expect(merged.conversations[0].messages[0].nativeWorkflows!.runs[0].status).toBe('complete');
    // However many runs a snapshot reports; a malformed one changes nothing.
    const many = { ...snapshot, revision: 99, runs: Array(17).fill(snapshot.runs[0]) };
    applyRunEvent(message, { kind: 'nativeworkflow', nativeWorkflows: many });
    expect(message.nativeWorkflows).toEqual(many);
    const malformed = { ...snapshot.runs[0], tokens: -1 };
    applyRunEvent(message, {
      kind: 'nativeworkflow',
      nativeWorkflows: { ...snapshot, revision: 100, runs: [malformed] },
    });
    expect(message.nativeWorkflows!.revision).toBe(99);
  });
});
