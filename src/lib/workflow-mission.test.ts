import { describe, expect, it } from 'vitest';
import { GATHER_MS, missionCall, newMission, tickMission } from './workflow-mission';
import { RunDriver } from './workflow-engine';
import { readRun } from './workflow-model';
import { testHost } from './workflow-test-host';

async function mission(t = testHost()) {
  const run = newMission({
    title: 'Game assets',
    text: 'Make every asset of the game, reviewed.',
    location: { computerId: t.computerId, environmentId: t.environmentId, path: 'C:\\game' },
    orchestrator: { provider: 'claude', connectionId: '', model: '', reasoning: 'high' },
    driver: { preferred: t.environmentId, elsewhere: true },
    actor: { kind: 'user' },
    now: t.now(),
  });
  const driver = await t.driver(run);
  const tick = () => driver.tick(tickMission);
  return { t, driver, tick };
}

describe('missions', () => {
  it('briefs an orchestrator session on the driving computer', async () => {
    const { t, driver, tick } = await mission();
    await tick();
    expect(t.started).toHaveLength(1);
    const spec = t.started[0];
    expect(spec.mission).toEqual({ runId: driver.id, role: 'orchestrator' });
    expect(spec.location?.path).toBe('C:\\game');
    expect(spec.settings.instructions).toMatch(/orchestrator of an Agent Studio mission/);
    expect(spec.text).toContain('# Mission: Game assets');
    expect(spec.text).toContain('Make every asset of the game, reviewed.');
    expect(spec.text).toContain('"accounts"');
    expect(driver.run.sessions).toMatchObject([{ conversationId: spec.id, reason: 'start' }]);
    expect(driver.run.agents).toMatchObject([{ conversationId: spec.id, role: 'orchestrator' }]);
    // Its own chat stays out of the chat lists.
    expect(driver.run.agents[0].listed).toBe(false);
  });

  it('spawns agents with the mission and its notes, and wakes the orchestrator with their replies', async () => {
    const { t, driver, tick } = await mission();
    await tick();
    const orchestrator = t.started[0].id;
    await missionCall(driver, 'mission_note', { title: 'Style', text: 'Low poly, flat colors.' });
    await missionCall(driver, 'mission_plan', { tasks: [{ id: 'sword', title: 'Sword model' }] });
    const spawned = JSON.parse(
      await missionCall(driver, 'mission_spawn', {
        title: 'Sword',
        task: 'Model the sword.',
        taskId: 'sword',
      }),
    );
    expect(spawned).toMatchObject({ status: 'running', computer: 'Desktop', folder: 'C:\\game' });
    const worker = t.started[1];
    expect(worker.id).toBe(spawned.agent);
    expect(worker.text).toContain('## Mission');
    expect(worker.text).toContain('Low poly, flat colors.');
    expect(worker.text).toContain('Model the sword.');
    expect(driver.run.tasks[0].status).toBe('running');
    t.answer(orchestrator, 'Started the sword.');
    await tick();
    // Nothing to hear yet: the orchestrator waits for its agent.
    expect(t.sent).toHaveLength(0);
    t.answer(worker.id, 'The sword is in C:\\game\\sword.glb.');
    await tick();
    expect(t.sent).toHaveLength(0);
    t.advance(GATHER_MS);
    await tick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].conversationId).toBe(orchestrator);
    expect(t.sent[0].text).toContain('Agent "Sword"');
    expect(t.sent[0].text).toContain('The sword is in C:\\game\\sword.glb.');
    expect(driver.run.inbox).toEqual([]);
    expect(t.released).toContain(worker.id);
  });

  it('asks without blocking and hears the answer', async () => {
    const { t, driver, tick } = await mission();
    await tick();
    const reply = await missionCall(driver, 'mission_ask', {
      questions: [{ id: 'style', question: 'Which art style?', options: [{ label: 'Flat' }] }],
    });
    expect(reply).toMatch(/^Asked/);
    expect(driver.run.alerts.at(-1)).toMatchObject({ kind: 'question', text: 'Which art style?' });
    t.answer(t.started[0].id, 'Asked about the style.');
    await tick();
    expect(driver.run.detail).toBe('Waiting for your answer');
    Object.assign(driver.run.questions[0], {
      status: 'answered',
      revision: 2,
      answers: [{ id: 'style', values: ['Flat'] }],
    });
    await tick();
    t.advance(GATHER_MS);
    await tick();
    expect(t.sent[0].text).toContain('The user answered "Which art style?": Flat');
  });

  it('reminds an orchestrator that leaves nothing in progress', async () => {
    const { t, tick } = await mission();
    await tick();
    t.answer(t.started[0].id, 'Thinking about it.');
    await tick();
    expect(t.sent).toHaveLength(0);
    t.advance(60_001);
    await tick();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].text).toContain('Nothing is running, waiting or scheduled');
  });

  it('continues on another account when the orchestrator reaches a usage limit', async () => {
    const { t, tick } = await mission();
    await tick();
    const orchestrator = t.started[0].id;
    const first = t.conversations.get(orchestrator)!.settings.connectionId!;
    t.answer(orchestrator, '', 'error', {
      error: "You've hit your session limit",
      usageLimit: { text: "You've hit your session limit" } as never,
    });
    t.usage.set(first, {
      provider: 'claude',
      checkedAt: t.now() / 1000,
      windows: [
        {
          id: '5h',
          label: '5-hour',
          usedPercent: 100,
          resetsAt: (t.now() + 3_600_000) / 1000,
          windowMinutes: 300,
          model: null,
          bucket: 'claude',
        },
      ],
      context: null,
      detail: '',
    });
    await tick();
    expect(t.switched).toEqual([{ conversationId: orchestrator, connectionId: t.connections[1] }]);
    expect(t.sent[0].text).toContain('interrupted');
  });

  it('starts a new session when another computer takes the mission over', async () => {
    const pc = testHost();
    const first = await mission(pc);
    await first.tick();
    await missionCall(first.driver, 'mission_plan', { tasks: [{ id: 'a', title: 'Assets list' }] });
    await first.driver.flush();
    // The VPS reads the run from the store and drives it from its own computer.
    const vps = testHost({ environmentId: '33333333-3333-4333-8333-333333333333' });
    for (const [id, conversation] of pc.conversations) vps.conversations.set(id, conversation);
    const saved = await pc.store.read([first.driver.id]);
    const driver = new RunDriver(
      first.driver.id,
      readRun(saved.docs[0].body)!,
      saved.docs[0].revision,
      vps.host,
      pc.writer,
    );
    await driver.tick(tickMission);
    expect(driver.run.sessions.map((s) => [s.reason, !!s.endedAt])).toEqual([
      ['start', true],
      ['driver', false],
    ]);
    // The first session's orchestrator is done; the new one runs.
    expect(driver.run.agents.map((a) => [a.title, a.status])).toEqual([
      ['Orchestrator 1', 'done'],
      ['Orchestrator 2', 'running'],
    ]);
    expect(vps.started[0].text).toContain('This is session 2 of this mission');
    expect(vps.started[0].text).toContain('Assets list');
    // The project folder is on the other computer, so the new session works in its own folder.
    expect(vps.started[0].location?.path).toBe('');
  });

  it('completes the mission and stops what still runs', async () => {
    const { t, driver, tick } = await mission();
    await tick();
    await missionCall(driver, 'mission_spawn', { title: 'Extra', task: 'Something.' });
    const text = await missionCall(driver, 'mission_complete', {
      summary: 'All assets are in C:\\game.',
    });
    expect(text).toBe('The mission is complete.');
    expect(driver.run.status).toBe('completed');
    expect(driver.run.output).toBe('All assets are in C:\\game.');
    expect(driver.run.agents.find((a) => a.title === 'Extra')?.status).toBe('stopped');
    expect(t.conversations.get(t.started[1].id)!.messages.at(-1)!.status).toBe('cancelled');
    expect(driver.run.alerts.at(-1)?.kind).toBe('completed');
    // The orchestrator completed it from its reply, which still runs: its session ends as done.
    expect(driver.run.agents.find((a) => a.role === 'orchestrator')?.status).toBe('done');
    expect(driver.run.sessions.every((s) => !!s.endedAt)).toBe(true);
  });

  it('refuses malformed calls with what is wrong', async () => {
    const { driver, tick } = await mission();
    await tick();
    await expect(missionCall(driver, 'mission_spawn', { title: 'x' })).rejects.toThrow(/task/);
    await expect(
      missionCall(driver, 'mission_spawn', { title: 'x', task: 'y', computer: 'Laptop' }),
    ).rejects.toThrow(/No computer is called Laptop/);
  });
});
