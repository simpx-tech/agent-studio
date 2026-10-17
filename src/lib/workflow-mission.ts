import { z } from 'zod';
import { providerIds, type ChatLocation, type ChatSettings, type ProviderId } from './domain';
import {
  answerText,
  readRun,
  taskStatuses,
  type Actor,
  type AgentChoice,
  type RunAgent,
  type WorkflowRun,
} from './workflow-model';
import { RunDriver, chatText, clock, iso, replyText, replying, staticRun } from './workflow-engine';
import {
  ORCHESTRATOR_INSTRUCTIONS,
  agentResume,
  missionBrief,
  missionReminder,
  missionResume,
  missionRetry,
  missionUpdate,
  workerTask,
} from './workflow-prompts';
import { exhaustedUntil, usageReport } from './workflow-usage';

/**
 * Missions (docs/WORKFLOWS.md): an orchestrator agent's conversation on the computer driving
 * the run, woken with what happened since its last turn, and the agents it starts. The driver
 * keeps everything that outlives a session in the run: plan, agents, notes, questions, timers
 * and what the orchestrator has not heard yet.
 */

const minute = 60_000;
/** How long the orchestrator waits after an event before hearing it, gathering others. */
export const GATHER_MS = 3_000;
/** Reminders after turns that leave nothing in progress, in minutes. */
const reminders = [1, 5, 15, 30, 60];

export function newMission({
  title,
  text,
  location,
  orchestrator,
  driver,
  actor,
  now,
}: {
  title: string;
  text: string;
  location?: ChatLocation;
  orchestrator: AgentChoice;
  driver: WorkflowRun['driver'];
  actor: Actor;
  now: number;
}): WorkflowRun {
  const at = iso(now);
  return readRun({
    mode: 'dynamic',
    title: title.trim() || firstWords(text),
    status: 'running',
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    createdBy: actor,
    driver,
    mission: { text, ...(location ? { location } : {}), orchestrator },
  })!;
}
const firstWords = (text: string) => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || 'Mission';
};

/** In-memory state a driver keeps for its mission between ticks. */
type Memory = { online: Map<string, boolean>; gatheringSince?: number };
const memories = new WeakMap<RunDriver, Memory>();
const memory = (driver: RunDriver) => {
  let value = memories.get(driver);
  if (!value) memories.set(driver, (value = { online: new Map() }));
  return value;
};

/** Advances a mission once. */
export async function tickMission(driver: RunDriver) {
  const run = driver.run;
  watchComputers(driver);
  reconcileAgents(driver);
  fireTimers(driver);
  hearAnswers(driver);
  hearChildren(driver);
  if (run.status !== 'running') return;
  await startWaitingAgents(driver);
  await driveOrchestrator(driver);
  updateDetail(driver);
}

// ---- What the orchestrator hears ----------------------------------------------------------------

function watchComputers(driver: RunDriver) {
  const seen = memory(driver).online;
  const used = new Set(
    driver.run.agents
      .filter((a) => a.status === 'running' || a.status === 'waiting')
      .map((a) => a.environmentId),
  );
  for (const environmentId of used) {
    const online = driver.host.online(environmentId);
    if (online === undefined) continue;
    const before = seen.get(environmentId);
    seen.set(environmentId, online);
    if (before === undefined || before === online) continue;
    const name = computerName(driver, environmentId);
    const agents = driver.run.agents
      .filter(
        (a) =>
          a.environmentId === environmentId && (a.status === 'running' || a.status === 'waiting'),
      )
      .map((a) => `"${a.title}"`);
    driver.inbox(
      'computer',
      online
        ? `${name} is back online.`
        : `${name} went offline. Agents there wait for it: ${agents.join(', ')}.`,
    );
    driver.event('computer', online ? `${name} is back online` : `${name} went offline`, {
      environmentId,
    });
  }
}

function reconcileAgents(driver: RunDriver) {
  const run = driver.run;
  for (const agent of run.agents) {
    if (agent.role === 'orchestrator' || agent.status !== 'running' || !agent.replyId) continue;
    const conversation = driver.host.conversation(agent.conversationId);
    const reply = conversation?.messages.find((m) => m.id === agent.replyId);
    if (!reply || reply.status === 'running') continue;
    const set = (patch: Partial<RunAgent>) => {
      Object.assign(agent, patch, { revision: agent.revision + 1 });
      for (const [key, value] of Object.entries(patch))
        if (value === undefined) delete (agent as Record<string, unknown>)[key];
      driver.change();
    };
    if (reply.status === 'complete') {
      const queued = agent.pending;
      set({
        status: queued ? 'waiting' : 'done',
        endedAt: queued ? undefined : iso(driver.now),
        wait: queued ? 'Sending your next message' : undefined,
      });
      driver.inbox('agent', `Agent "${agent.title}" (${agent.conversationId}) finished.`, {
        conversationId: agent.conversationId,
        messageId: reply.id,
      });
      driver.event('agent', `${agent.title} finished`, {
        conversationId: agent.conversationId,
        taskId: agent.taskId,
      });
      if (!queued && !agent.listed) driver.host.releaseChat(agent.conversationId);
      continue;
    }
    if (reply.usageLimit || /usage limit|rate limit|hit your/i.test(reply.error ?? '')) {
      driver.host.refreshUsage(agent.connectionId, agent.provider);
      const until =
        exhaustedUntil(driver.host.usage(agent.connectionId, agent.provider), agent, driver.now) ??
        driver.now + 15 * minute;
      set({
        status: 'waiting',
        wait: `Waiting for a usage reset at ${clock(until)}`,
        waitUntil: iso(until),
        pending: { text: agentResume('Continue your task.'), mode: 'next' },
      });
      driver.event('usage', `${agent.title} waits for a usage reset at ${clock(until)}`, {
        conversationId: agent.conversationId,
      });
      continue;
    }
    if (
      /interrupted when the app closed|no longer running|went on in the original/i.test(
        reply.error ?? '',
      )
    ) {
      set({
        status: 'waiting',
        wait: 'Interrupted; continuing',
        pending: { text: agentResume('Continue your task.'), mode: 'next' },
      });
      continue;
    }
    if (
      /relay|disconnected|request expired|will not be replayed|no longer available|connection lost/i.test(
        reply.error ?? '',
      )
    ) {
      // Its computer may still run it; a later copy of the chat says how it ended.
      if (!agent.waitUntil) set({ waitUntil: iso(driver.now + 5 * minute) });
      else if (Date.parse(agent.waitUntil) <= driver.now)
        set({
          status: 'waiting',
          wait: 'Lost touch with its computer; continuing',
          waitUntil: undefined,
          pending: { text: agentResume('Continue your task.'), mode: 'next' },
        });
      continue;
    }
    const error =
      reply.status === 'cancelled' && !reply.error
        ? 'Its reply was stopped.'
        : (reply.error ?? 'Its reply failed.');
    set({
      status: reply.status === 'cancelled' ? 'stopped' : 'failed',
      endedAt: iso(driver.now),
      wait: error,
    });
    driver.inbox(
      'agent',
      `Agent "${agent.title}" (${agent.conversationId}) ${reply.status === 'cancelled' ? 'stopped' : 'failed'}: ${error}`,
      {
        conversationId: agent.conversationId,
        messageId: reply.id,
      },
    );
    driver.event(
      'agent',
      `${agent.title} ${reply.status === 'cancelled' ? 'stopped' : 'failed'}: ${error}`,
      { conversationId: agent.conversationId },
    );
  }
}

function fireTimers(driver: RunDriver) {
  for (const timer of driver.run.timers) {
    if (timer.status !== 'pending' || Date.parse(timer.at) > driver.now) continue;
    timer.status = 'fired';
    driver.inbox('timer', `Timer${timer.reason ? ` "${timer.reason}"` : ''} fired.`);
    driver.change();
  }
}

function hearAnswers(driver: RunDriver) {
  const run = driver.run;
  for (const question of run.questions) {
    if (question.source !== 'orchestrator' || question.status === 'pending') continue;
    const key = `q:${question.id}`;
    if (run.handled.includes(key)) continue;
    run.handled = [...run.handled, key];
    const asked = question.questions.map((q) => q.question).join(' / ');
    driver.inbox(
      'answer',
      question.status === 'cancelled'
        ? `Your question "${asked}" was withdrawn.`
        : `The user answered "${asked}": ${answerText(question)}`,
    );
  }
}

function hearChildren(driver: RunDriver) {
  for (const child of driver.run.children) {
    if (child.status !== 'running' && child.status !== 'paused') continue;
    const known = driver.host.knownRun(child.runId);
    if (!known || known.status === 'running' || known.status === 'paused') continue;
    Object.assign(child, {
      status: known.status,
      output: known.output,
      revision: child.revision + 1,
    });
    if (child.wait)
      driver.inbox(
        'workflow',
        `Workflow "${child.title}" (${child.runId}) ${known.status}.${known.output ? ` Its output:\n\n${known.output}` : ''}`,
      );
    driver.change();
  }
}

// ---- Agents -------------------------------------------------------------------------------------

/** Sends waiting agents their message once their computer, account and usage allow it. */
async function startWaitingAgents(driver: RunDriver) {
  for (const agent of driver.run.agents) {
    if (driver.run.status !== 'running') return;
    if (agent.role === 'orchestrator' || agent.status !== 'waiting' || !agent.pending) continue;
    if (agent.waitUntil && Date.parse(agent.waitUntil) > driver.now) continue;
    await startAgent(driver, agent);
  }
}

/** Starts or continues an agent's chat, or says what it waits for. */
async function startAgent(driver: RunDriver, agent: RunAgent) {
  const host = driver.host;
  const set = (patch: Partial<RunAgent>) => {
    Object.assign(agent, patch, { revision: agent.revision + 1 });
    for (const [key, value] of Object.entries(patch))
      if (value === undefined) delete (agent as Record<string, unknown>)[key];
    driver.change();
  };
  const existing = host.conversation(agent.conversationId);
  if (existing && replying(existing)) return set({ wait: 'Waiting for its reply to end' });
  const settings: ChatSettings = existing
    ? { ...existing.settings }
    : {
        provider: agent.provider,
        model: agent.model,
        reasoning: agent.reasoning,
        instructions: '',
        ...(agent.connectionId ? { connectionId: agent.connectionId } : {}),
      };
  const location = existing?.location ?? agent.location;
  const ready = host.readiness(settings, location);
  if (!ready.ready) return set({ wait: ready.reason, waitUntil: iso(driver.now + 30_000) });
  const until = exhaustedUntil(
    host.usage(settings.connectionId, settings.provider),
    settings,
    driver.now,
  );
  if (until) {
    const other = existing
      ? undefined
      : host.leastUsed(
          settings.provider,
          location,
          settings.model,
          settings.connectionId ? [settings.connectionId] : [],
        );
    if (!other || exhaustedUntil(host.usage(other, settings.provider), settings, driver.now))
      return set({ wait: `Waiting for a usage reset at ${clock(until)}`, waitUntil: iso(until) });
    settings.connectionId = other;
  }
  const pending = agent.pending!;
  try {
    const { replyId } = existing
      ? await host.sendToChat(existing.id, pending.text)
      : await host.startChat({
          id: agent.conversationId,
          title: `${driver.run.title} · ${agent.title}`,
          location,
          settings,
          text: pending.text,
          listed: agent.listed,
        });
    set({
      status: 'running',
      replyId,
      pending: undefined,
      wait: undefined,
      waitUntil: undefined,
      connectionId: settings.connectionId,
      endedAt: undefined,
    });
    driver.event('agent', `${agent.title} started`, {
      conversationId: agent.conversationId,
      taskId: agent.taskId,
      environmentId: agent.environmentId,
    });
  } catch (error) {
    set({ wait: String(error).replace(/^Error: /, ''), waitUntil: iso(driver.now + minute) });
  }
}

// ---- The orchestrator ---------------------------------------------------------------------------

function inFlight(run: WorkflowRun) {
  return (
    run.agents.some(
      (a) => a.role !== 'orchestrator' && (a.status === 'running' || a.status === 'waiting'),
    ) ||
    run.questions.some((q) => q.status === 'pending') ||
    run.timers.some((t) => t.status === 'pending') ||
    run.children.some((c) => c.wait && (c.status === 'running' || c.status === 'paused'))
  );
}

/** Ends an orchestrator session, and its chat's part in the run's agents with it. */
function endSession(
  driver: RunDriver,
  session: WorkflowRun['sessions'][number],
  status: 'done' | 'failed' = 'done',
) {
  session.endedAt ??= iso(driver.now);
  const agent = driver.run.agents.find((a) => a.conversationId === session.conversationId);
  if (agent && (agent.status === 'running' || agent.status === 'waiting'))
    Object.assign(agent, { status, endedAt: iso(driver.now), revision: agent.revision + 1 });
  driver.change();
}

/** The current session on this computer, ending one that belongs to another or failed for good. */
function currentSession(driver: RunDriver) {
  const run = driver.run;
  const self = driver.host.self().environmentId;
  for (const session of run.sessions)
    if (!session.endedAt && session.environmentId !== self) endSession(driver, session);
  return run.sessions.find(
    (s) => !s.endedAt && s.environmentId === self && driver.host.conversation(s.conversationId),
  );
}

async function driveOrchestrator(driver: RunDriver) {
  const run = driver.run;
  const host = driver.host;
  let session = currentSession(driver);
  if (!session) {
    // A session whose chat has not arrived yet, from a driver that created it before going away.
    const waiting = run.sessions.find(
      (s) => !s.endedAt && s.environmentId === host.self().environmentId,
    );
    if (waiting && Date.parse(waiting.startedAt) > driver.now - 2 * minute) return;
    if (waiting) endSession(driver, waiting);
    await startSession(driver);
    return;
  }
  const conversation = host.conversation(session.conversationId)!;
  if (replying(conversation)) return;
  const last = conversation.messages.at(-1);
  // The reply the engine sent may not have reached this copy of the chat yet.
  if (session.replyId && !conversation.messages.some((m) => m.id === session.replyId)) return;
  const set = (patch: Partial<typeof session>) => {
    Object.assign(session!, patch);
    for (const [key, value] of Object.entries(patch))
      if (value === undefined) delete (session as Record<string, unknown>)[key];
    driver.change();
  };
  if (session.retryAt && Date.parse(session.retryAt) > driver.now) return;
  if (last?.role === 'assistant' && last.status !== 'complete' && last.id === session.replyId) {
    const error = last.error ?? '';
    if (last.usageLimit || /usage limit|rate limit|hit your/i.test(error)) {
      const settings = conversation.settings;
      host.refreshUsage(settings.connectionId, settings.provider);
      const other = host.leastUsed(
        settings.provider,
        conversation.location,
        settings.model,
        settings.connectionId ? [settings.connectionId] : [],
      );
      if (other && !exhaustedUntil(host.usage(other, settings.provider), settings, driver.now)) {
        host.switchAccount(conversation.id, other);
        driver.event('usage', 'The orchestrator continues on another account');
        return send(driver, session, conversation.id, missionResume);
      }
      const until =
        exhaustedUntil(
          host.usage(settings.connectionId, settings.provider),
          settings,
          driver.now,
        ) ?? driver.now + 15 * minute;
      if (!session.retryAt) {
        driver.event('usage', `The orchestrator waits for a usage reset at ${clock(until)}`);
        return set({ retryAt: iso(until) });
      }
      set({ retryAt: undefined });
      return send(driver, session, conversation.id, missionResume);
    }
    if (/interrupted when the app closed|no longer running|went on in the original/i.test(error))
      return send(driver, session, conversation.id, missionResume);
    if (last.status === 'error') {
      const failures = session.failures + 1;
      if (failures >= 3) {
        set({ failures });
        endSession(driver, session, 'failed');
        driver.event('session', 'The orchestrator failed three times; starting a new session');
        return;
      }
      if (!session.retryAt)
        return set({ failures, retryAt: iso(driver.now + 30_000 * 4 ** (failures - 1)) });
      set({ failures, retryAt: undefined });
      return send(driver, session, conversation.id, missionRetry(error));
    }
    // Stopped in its chat: it waits for the next event or reminder.
  }
  if (run.status !== 'running') return;
  if (run.inbox.length) {
    const gather = memory(driver);
    const oldest = Math.min(...run.inbox.map((i) => Date.parse(i.at)));
    if (driver.now - oldest < GATHER_MS && run.inbox.length < 8) return;
    gather.gatheringSince = undefined;
    const items = run.inbox.map((item) => {
      const message =
        item.conversationId && item.messageId
          ? host.conversation(item.conversationId)?.messages.find((m) => m.id === item.messageId)
          : undefined;
      return message && item.kind === 'agent' && message.status === 'complete'
        ? { ...item, reply: replyText(message) }
        : item;
    });
    run.inbox = [];
    run.idle = undefined;
    driver.change();
    return send(driver, session, conversation.id, missionUpdate(items, statusLine(run)));
  }
  if (inFlight(run)) {
    if (run.idle) {
      run.idle = undefined;
      driver.change();
    }
    return;
  }
  // Nothing in progress and nothing to hear: remind it, at growing intervals.
  const count = run.idle?.count ?? 0;
  if (run.idle && Date.parse(run.idle.at) > driver.now) return;
  if (!run.idle) {
    run.idle = { count: 0, at: iso(driver.now + reminders[0] * minute) };
    driver.change();
    return;
  }
  run.idle = {
    count: count + 1,
    at: iso(driver.now + reminders[Math.min(count + 1, reminders.length - 1)] * minute),
  };
  if (count + 1 === 3) driver.alert('notify', 'The mission has nothing in progress.');
  return send(driver, session, conversation.id, missionReminder(count + 1));
}

async function send(
  driver: RunDriver,
  session: WorkflowRun['sessions'][number],
  conversationId: string,
  text: string,
) {
  try {
    const { replyId } = await driver.host.sendToChat(conversationId, text);
    Object.assign(session, { replyId, turns: session.turns + 1 });
    driver.change();
  } catch (error) {
    Object.assign(session, { retryAt: iso(driver.now + minute) });
    driver.event(
      'error',
      `The orchestrator could not be reached: ${String(error).replace(/^Error: /, '')}`,
    );
  }
}

/** Starts an orchestrator session on this computer, briefed with the mission and its state. */
async function startSession(driver: RunDriver) {
  const run = driver.run;
  const host = driver.host;
  const self = host.self();
  const mission = run.mission!;
  const choice = mission.orchestrator;
  const local = mission.location && executes(driver, mission.location, self.environmentId);
  const location: ChatLocation = local
    ? mission.location!
    : { computerId: self.computerId, environmentId: self.environmentId, path: '' };
  const fleet = host.fleet();
  const own = fleet.connections.find((c) => c.id === choice.connectionId);
  const connectionId =
    own &&
    executes(
      driver,
      { computerId: '', environmentId: own.environmentId, path: '' },
      self.environmentId,
    )
      ? own.id
      : host.leastUsed(choice.provider, location, choice.model);
  const settings: ChatSettings = {
    provider: choice.provider,
    model: choice.model,
    reasoning: choice.reasoning,
    instructions: ORCHESTRATOR_INSTRUCTIONS,
    ...(connectionId ? { connectionId } : {}),
  };
  const ready = host.readiness(settings, location);
  if (!ready.ready) {
    if (run.detail !== `Orchestrator: ${ready.reason}`) {
      run.detail = `Orchestrator: ${ready.reason}`;
      driver.change();
    }
    return;
  }
  const until = exhaustedUntil(
    host.usage(settings.connectionId, settings.provider),
    settings,
    driver.now,
  );
  if (until) {
    const detail = `The orchestrator waits for a usage reset at ${clock(until)}`;
    if (run.detail !== detail) {
      run.detail = detail;
      driver.change();
    }
    return;
  }
  const number = run.sessions.length + 1;
  const id = crypto.randomUUID();
  const previous = run.sessions.at(-1);
  run.sessions.push({
    conversationId: id,
    environmentId: self.environmentId,
    ...(settings.connectionId ? { connectionId: settings.connectionId } : {}),
    startedAt: iso(driver.now),
    reason: !previous
      ? 'start'
      : previous.environmentId !== self.environmentId
        ? 'driver'
        : previous.failures >= 3
          ? 'failure'
          : 'restart',
    turns: 1,
    failures: 0,
  });
  driver.trackAgent({
    conversationId: id,
    role: 'orchestrator',
    title: `Orchestrator ${number}`,
    environmentId: self.environmentId,
    connectionId: settings.connectionId,
    provider: settings.provider,
    model: settings.model,
    listed: false,
  });
  driver.event('session', `Orchestrator session ${number} started on ${self.name}`, {
    conversationId: id,
    environmentId: self.environmentId,
  });
  await driver.flush();
  const { replyId } = await host.startChat({
    id,
    title: `${run.title} · Orchestrator${number > 1 ? ` ${number}` : ''}`,
    location,
    settings,
    text: missionBrief(
      run,
      number,
      number > 1 || run.tasks.length || run.notes.length
        ? JSON.stringify(
            missionState(driver, [
              'plan',
              'agents',
              'notes',
              'questions',
              'timers',
              'computers',
              'accounts',
            ]),
            null,
            2,
          )
        : JSON.stringify(missionState(driver, ['computers', 'accounts']), null, 2),
    ),
    listed: false,
    mission: { runId: driver.id, role: 'orchestrator' },
  });
  const session = run.sessions.find((s) => s.conversationId === id);
  if (session) session.replyId = replyId;
  run.inbox = [];
  driver.change();
}

/** Whether chats at a location run on the computer whose environment is `self`. */
function executes(driver: RunDriver, location: ChatLocation, self: string) {
  const fleet = driver.host.fleet();
  const environment = location.executionEnvironmentId ?? location.environmentId;
  const host = fleet.environments.find((e) => e.id === environment)?.discoveredOn ?? environment;
  return host === self;
}

function statusLine(run: WorkflowRun) {
  const agents = run.agents.filter((a) => a.role !== 'orchestrator');
  const running = agents.filter((a) => a.status === 'running').length;
  const waiting = agents.filter((a) => a.status === 'waiting').length;
  const done = run.tasks.filter((t) => t.status === 'done').length;
  const questions = run.questions.filter((q) => q.status === 'pending').length;
  return `Status: ${running} agent${running === 1 ? '' : 's'} running, ${waiting} waiting; ${questions} question${questions === 1 ? '' : 's'} open; plan ${done}/${run.tasks.length} tasks done.`;
}

function updateDetail(driver: RunDriver) {
  const run = driver.run;
  if (run.status !== 'running') return;
  const session = run.sessions.find((s) => !s.endedAt);
  const conversation = session ? driver.host.conversation(session.conversationId) : undefined;
  const agents = run.agents.filter((a) => a.role !== 'orchestrator');
  const running = agents.filter((a) => a.status === 'running').length;
  const waiting = agents.filter((a) => a.status === 'waiting');
  const parts = [
    conversation && replying(conversation) ? 'Orchestrator working' : '',
    running ? `${running} agent${running === 1 ? '' : 's'} running` : '',
    waiting.length ? `${waiting.length} waiting` : '',
    run.questions.some((q) => q.status === 'pending') ? 'Waiting for your answer' : '',
  ].filter(Boolean);
  const detail =
    parts.join(' · ') ||
    (run.detail.startsWith('Orchestrator:') || run.detail.startsWith('The orchestrator')
      ? run.detail
      : '');
  if (detail !== run.detail) {
    run.detail = detail;
    driver.change();
  }
}

const computerName = (driver: RunDriver, environmentId: string) =>
  driver.host.computers().find((c) => c.environmentId === environmentId)?.name ?? 'A computer';

// ---- Mission state ------------------------------------------------------------------------------

export function missionState(driver: RunDriver, include?: string[]) {
  const run = driver.run;
  const host = driver.host;
  const wants = (part: string) => !include?.length || include.includes(part);
  const computers = host.computers();
  const name = (environmentId: string) =>
    computers.find((c) => c.environmentId === environmentId)?.name ?? environmentId;
  const accounts = host.accounts();
  const account = (connectionId?: string) => accounts.find((a) => a.connectionId === connectionId);
  return {
    mission: {
      id: driver.id,
      title: run.title,
      text: run.mission?.text,
      status: run.status,
      ...(run.mission?.location?.path
        ? {
            folder: {
              computer: name(
                run.mission.location.executionEnvironmentId ?? run.mission.location.environmentId,
              ),
              path: run.mission.location.path,
            },
          }
        : {}),
      orchestratorComputer: host.self().name,
    },
    ...(wants('plan') ? { plan: run.tasks } : {}),
    ...(wants('agents')
      ? {
          agents: run.agents
            .filter((a) => a.role !== 'orchestrator')
            .map((a) => {
              const conversation = host.conversation(a.conversationId);
              const reply = conversation?.messages.find((m) => m.id === a.replyId);
              return {
                id: a.conversationId,
                title: a.title,
                ...(a.taskId ? { taskId: a.taskId } : {}),
                status: a.status,
                ...(a.wait ? { waits: a.wait } : {}),
                computer: name(a.environmentId),
                folder: conversation?.location?.path || a.location?.path || '(Standalone)',
                account:
                  account(a.connectionId ?? conversation?.settings.connectionId)?.name ??
                  a.provider,
                provider: a.provider,
                model: a.model || 'CLI default',
                startedAt: a.startedAt,
                ...(a.endedAt ? { endedAt: a.endedAt } : {}),
                ...(reply?.status === 'complete'
                  ? { replyCharacters: replyText(reply).length }
                  : {}),
                ...(a.after.length ? { after: a.after } : {}),
              };
            }),
        }
      : {}),
    ...(wants('notes')
      ? {
          notes: run.notes
            .filter((n) => !n.deleted)
            .map(({ id, title, text, author, updatedAt }) => ({
              id,
              title,
              text,
              author,
              updatedAt,
            })),
        }
      : {}),
    ...(wants('questions')
      ? {
          questions: run.questions.map((q) => ({
            id: q.id,
            status: q.status,
            questions: q.questions.map((item) => item.question),
            ...(q.status !== 'pending' ? { answer: answerText(q) } : {}),
          })),
        }
      : {}),
    ...(wants('timers') ? { timers: run.timers.filter((t) => t.status === 'pending') } : {}),
    ...(wants('computers')
      ? {
          computers: computers.map((c) => ({
            id: c.environmentId,
            name: c.name,
            platform: c.platform,
            online: c.online ?? 'unknown',
            ...(c.server ? { server: true } : {}),
            ...(c.environmentId === host.self().environmentId ? { orchestratorHere: true } : {}),
            agents: c.providers,
            recentFolders: c.folders,
          })),
        }
      : {}),
    ...(wants('accounts')
      ? {
          accounts: accounts.map((a) => ({
            id: a.connectionId,
            name: a.name,
            provider: a.provider,
            computer: name(a.environmentId),
            ready: a.ready,
            ...(a.ready ? {} : { detail: a.detail }),
            usage: usageReport(
              host.usage(a.connectionId, a.provider),
              { provider: a.provider, model: '' },
              driver.now,
            ),
          })),
        }
      : {}),
    ...(wants('history') ? { history: driver.recent() } : {}),
  };
}

// ---- Mission tools ------------------------------------------------------------------------------

const agentChoiceInput = z
  .object({
    provider: z.enum(providerIds).optional(),
    account: z.string().optional(),
    model: z.string().optional(),
    reasoning: z.string().optional(),
  })
  .strict();
const questionsInput = z
  .array(
    z
      .object({
        id: z.string().min(1),
        header: z.string().optional(),
        question: z.string().min(1),
        multiSelect: z.boolean().optional(),
        options: z
          .array(
            z.object({ label: z.string().min(1), description: z.string().optional() }).strict(),
          )
          .optional(),
      })
      .strict(),
  )
  .min(1);
const inputs = {
  mission_state: z.object({ include: z.array(z.string()).optional() }).strict(),
  mission_plan: z
    .object({
      tasks: z
        .array(
          z
            .object({
              id: z.string().min(1),
              title: z.string().optional(),
              description: z.string().optional(),
              status: z.enum(taskStatuses).optional(),
              dependsOn: z.array(z.string()).optional(),
              phase: z.string().optional(),
              result: z.string().optional(),
            })
            .strict(),
        )
        .optional(),
      remove: z.array(z.string()).optional(),
    })
    .strict(),
  mission_spawn: z
    .object({
      title: z.string().trim().min(1),
      task: z.string().trim().min(1),
      taskId: z.string().optional(),
      computer: z.string().optional(),
      folder: z.string().optional(),
      agent: agentChoiceInput.optional(),
      includeContext: z.boolean().optional(),
      after: z.array(z.string()).optional(),
      listed: z.boolean().optional(),
    })
    .strict(),
  mission_message: z
    .object({
      chat: z.string(),
      text: z.string().trim().min(1),
      mode: z.enum(['next', 'steer']).optional(),
    })
    .strict(),
  mission_stop: z.object({ chat: z.string() }).strict(),
  mission_read: z
    .object({
      chat: z.string(),
      what: z.enum(['reply', 'messages', 'chat']).optional(),
      count: z.number().int().positive().optional(),
    })
    .strict(),
  mission_chats: z
    .object({ scope: z.enum(['mission', 'all']).optional(), query: z.string().optional() })
    .strict(),
  mission_ask: z.object({ questions: questionsInput }).strict(),
  mission_note: z
    .object({
      id: z.string().optional(),
      title: z.string().optional(),
      text: z.string().optional(),
      delete: z.boolean().optional(),
    })
    .strict(),
  mission_wait: z
    .object({
      until: z.string().optional(),
      seconds: z.number().positive().optional(),
      reason: z.string().optional(),
    })
    .strict(),
  mission_screen: z
    .object({
      op: z.enum(['run', 'load', 'save']),
      computer: z.string().optional(),
      screen: z.string(),
      action: z.string().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      key: z.string().optional(),
      value: z.unknown().optional(),
    })
    .strict(),
  mission_run_workflow: z
    .object({
      id: z.string(),
      inputs: z.record(z.string(), z.string()).optional(),
      wait: z.boolean().optional(),
    })
    .strict(),
  mission_complete: z
    .object({
      summary: z.string().trim().min(1),
      status: z.enum(['completed', 'failed']).optional(),
    })
    .strict(),
};
export type MissionTool = keyof typeof inputs;
export const missionTools = Object.keys(inputs) as MissionTool[];

/** A computer by its environment id, computer id or name. */
function findComputer(driver: RunDriver, text: string | undefined) {
  const computers = driver.host.computers();
  if (!text) return undefined;
  const wanted = text.trim().toLowerCase();
  return (
    computers.find((c) => c.environmentId === text || c.computerId === text) ??
    computers.find((c) => c.name.toLowerCase() === wanted)
  );
}
function findAccount(
  driver: RunDriver,
  text: string | undefined,
  provider: ProviderId,
  environmentId: string,
) {
  if (!text) return undefined;
  const wanted = text.trim().toLowerCase();
  const accounts = driver.host
    .accounts()
    .filter((a) => a.provider === provider && a.environmentId === environmentId);
  return (
    accounts.find((a) => a.connectionId === text) ??
    accounts.find((a) => a.name.toLowerCase() === wanted)
  )?.connectionId;
}

/** Answers one of the orchestrator's mission tools. */
export async function missionCall(
  driver: RunDriver,
  tool: MissionTool,
  raw: unknown,
): Promise<string> {
  const parsed = inputs[tool].safeParse(raw ?? {});
  if (!parsed.success)
    throw new Error(
      `Invalid ${tool} input: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`,
    );
  const input = parsed.data as never;
  const run = driver.run;
  const host = driver.host;
  if (tool !== 'mission_state' && tool !== 'mission_read' && tool !== 'mission_chats' && run.idle) {
    run.idle = undefined;
    driver.change();
  }
  switch (tool) {
    case 'mission_state':
      return JSON.stringify(
        missionState(driver, (input as { include?: string[] }).include),
        null,
        2,
      );
    case 'mission_plan': {
      const { tasks = [], remove = [] } = input as z.infer<typeof inputs.mission_plan>;
      const at = iso(driver.now);
      for (const change of tasks) {
        const existing = run.tasks.find((t) => t.id === change.id);
        if (existing) {
          const before = existing.status;
          Object.assign(
            existing,
            Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)),
            {
              revision: existing.revision + 1,
              updatedAt: at,
            },
          );
          if (change.status && change.status !== before)
            driver.event('plan', `${existing.title || existing.id}: ${change.status}`, {
              taskId: existing.id,
            });
        } else {
          run.tasks.push({
            id: change.id,
            revision: 1,
            title: change.title ?? change.id,
            description: change.description ?? '',
            status: change.status ?? 'planned',
            dependsOn: change.dependsOn ?? [],
            phase: change.phase ?? '',
            result: change.result ?? '',
            createdAt: at,
            updatedAt: at,
          });
          driver.event('plan', `Planned ${change.title ?? change.id}`, { taskId: change.id });
        }
      }
      if (remove.length) {
        run.tasks = run.tasks.filter((t) => !remove.includes(t.id));
        for (const task of run.tasks)
          task.dependsOn = task.dependsOn.filter((d) => !remove.includes(d));
      }
      driver.change();
      return `The plan has ${run.tasks.length} tasks.`;
    }
    case 'mission_spawn': {
      const spec = input as z.infer<typeof inputs.mission_spawn>;
      const self = host.self();
      const project = run.mission?.location;
      const computer = spec.computer ? findComputer(driver, spec.computer) : undefined;
      if (spec.computer && !computer)
        throw new Error(`No computer is called ${spec.computer}. mission_state lists them.`);
      const projectEnvironment = project
        ? (project.executionEnvironmentId ?? project.environmentId)
        : undefined;
      const target =
        computer ??
        host.computers().find((c) => c.environmentId === projectEnvironment) ??
        host.computers().find((c) => c.environmentId === self.environmentId)!;
      const onProject = !!project?.path && projectEnvironment === target.environmentId;
      const path = spec.folder !== undefined ? spec.folder.trim() : onProject ? project!.path : '';
      const location: ChatLocation =
        onProject && path === project!.path
          ? project!
          : { computerId: target.computerId, environmentId: target.environmentId, path };
      const choice = { ...run.mission?.workers, ...spec.agent };
      const provider = (choice.provider ??
        run.mission?.orchestrator.provider ??
        'claude') as ProviderId;
      if (!target.providers.includes(provider))
        throw new Error(
          `${target.name} has no ${provider} CLI. mission_state lists each computer's agents.`,
        );
      const named =
        'account' in choice
          ? findAccount(
              driver,
              (choice as { account?: string }).account,
              provider,
              target.environmentId,
            )
          : undefined;
      if ((choice as { account?: string }).account && !named)
        throw new Error(
          `No ${provider} account called ${(choice as { account?: string }).account} on ${target.name}.`,
        );
      const model = choice.model ?? '';
      const connectionId = named ?? host.leastUsed(provider, location, model) ?? undefined;
      const id = crypto.randomUUID();
      const after = (spec.after ?? []).filter((a) =>
        run.agents.some((x) => x.conversationId === a),
      );
      const agent: RunAgent = {
        conversationId: id,
        revision: 1,
        role: 'worker',
        title: spec.title,
        ...(spec.taskId ? { taskId: spec.taskId } : {}),
        environmentId: target.environmentId,
        ...(connectionId ? { connectionId } : {}),
        provider,
        model,
        reasoning: (choice.reasoning ?? '') as RunAgent['reasoning'],
        location,
        listed: !!spec.listed,
        status: 'waiting',
        wait: 'Starting',
        pending: { text: workerTask(run, spec.task, spec.includeContext !== false), mode: 'next' },
        after,
        startedAt: iso(driver.now),
      };
      run.agents.push(agent);
      const task = run.tasks.find((t) => t.id === spec.taskId);
      if (task && task.status === 'planned')
        Object.assign(task, {
          status: 'running',
          revision: task.revision + 1,
          updatedAt: iso(driver.now),
        });
      driver.change();
      await startAgent(driver, agent);
      await driver.flush();
      return JSON.stringify({
        agent: id,
        status: agent.status,
        ...(agent.wait ? { waits: agent.wait } : {}),
        computer: target.name,
        folder: path || '(Standalone)',
      });
    }
    case 'mission_message': {
      const { chat, text, mode = 'next' } = input as z.infer<typeof inputs.mission_message>;
      const conversation = host.conversation(chat);
      if (!conversation) throw new Error('No chat has that id. mission_chats lists them.');
      let agent = run.agents.find((a) => a.conversationId === chat);
      if (agent?.role === 'orchestrator') throw new Error('That is your own chat.');
      if (mode === 'steer' && replying(conversation)) {
        await host.steerChat(chat, text);
        return 'Steered into its running reply.';
      }
      if (!agent) {
        const environment =
          conversation.location?.executionEnvironmentId ??
          conversation.location?.environmentId ??
          host.self().environmentId;
        agent = {
          conversationId: chat,
          revision: 1,
          role: 'worker',
          title: conversation.title,
          environmentId: environment,
          ...(conversation.settings.connectionId
            ? { connectionId: conversation.settings.connectionId }
            : {}),
          provider: conversation.settings.provider,
          model: conversation.settings.model,
          reasoning: conversation.settings.reasoning,
          listed: true,
          status: 'waiting',
          after: [],
          startedAt: iso(driver.now),
        };
        run.agents.push(agent);
      }
      Object.assign(agent, {
        pending: { text, mode: 'next' },
        status: 'waiting',
        revision: agent.revision + 1,
      });
      delete agent.endedAt;
      driver.change();
      if (!replying(conversation)) await startAgent(driver, agent);
      await driver.flush();
      return agent.status === 'running'
        ? 'Sent.'
        : `Queued: ${agent.wait ?? 'it goes out when its reply ends'}.`;
    }
    case 'mission_stop': {
      const { chat } = input as z.infer<typeof inputs.mission_stop>;
      const conversation = host.conversation(chat);
      if (!conversation) throw new Error('No chat has that id.');
      const agent = run.agents.find((a) => a.conversationId === chat);
      if (agent?.pending) {
        delete agent.pending;
        if (agent.status === 'waiting')
          Object.assign(agent, { status: 'stopped', endedAt: iso(driver.now) });
        agent.revision += 1;
        driver.change();
      }
      if (replying(conversation)) await host.stopChat(chat);
      return 'Stopped.';
    }
    case 'mission_read': {
      const { chat, what = 'reply', count } = input as z.infer<typeof inputs.mission_read>;
      const conversation = host.conversation(chat);
      if (!conversation) throw new Error('No chat has that id.');
      return chatText(conversation, what, count) || '(Nothing yet.)';
    }
    case 'mission_chats': {
      const { scope = 'mission', query } = input as z.infer<typeof inputs.mission_chats>;
      const own = new Set(run.agents.map((a) => a.conversationId));
      const computers = host.computers();
      const accounts = host.accounts();
      const list = host
        .conversations()
        .filter((c) => (scope === 'all' ? true : own.has(c.id)))
        .filter((c) => !query || c.title.toLowerCase().includes(query.toLowerCase()))
        .map((c) => {
          const environment = c.location?.executionEnvironmentId ?? c.location?.environmentId;
          const last = c.messages.at(-1);
          return {
            id: c.id,
            title: c.title,
            computer: computers.find((x) => x.environmentId === environment)?.name ?? '',
            folder: c.location?.path || '(Standalone)',
            agent: c.settings.provider,
            account: accounts.find((a) => a.connectionId === c.settings.connectionId)?.name ?? '',
            status: last?.role === 'assistant' ? last.status : 'idle',
            updatedAt: c.updatedAt,
            ...(own.has(c.id) ? { mission: true } : {}),
          };
        });
      return JSON.stringify(list, null, 2);
    }
    case 'mission_ask': {
      const { questions } = input as z.infer<typeof inputs.mission_ask>;
      const ids = new Set(questions.map((q) => q.id));
      if (ids.size !== questions.length) throw new Error('Give each question its own id.');
      const id = crypto.randomUUID();
      run.questions.push({
        id,
        revision: 1,
        status: 'pending',
        source: 'orchestrator',
        createdAt: iso(driver.now),
        questions: questions.map((q) => ({
          id: q.id,
          header: q.header ?? '',
          question: q.question,
          options: (q.options ?? []).map((o) => ({
            label: o.label,
            description: o.description ?? '',
          })),
          multiSelect: !!q.multiSelect,
        })),
      });
      driver.alert('question', questions.map((q) => q.question).join(' / '));
      driver.event('question', questions.map((q) => q.question).join(' / '));
      return `Asked (question ${id}). The answer arrives with a later turn; keep working meanwhile.`;
    }
    case 'mission_note': {
      const note = input as z.infer<typeof inputs.mission_note>;
      const existing = note.id ? run.notes.find((n) => n.id === note.id) : undefined;
      if (note.delete) {
        if (!existing) throw new Error('No note has that id.');
        Object.assign(existing, {
          deleted: true,
          revision: existing.revision + 1,
          updatedAt: iso(driver.now),
        });
        driver.change();
        return 'Deleted.';
      }
      if (existing) {
        Object.assign(existing, {
          ...(note.title !== undefined ? { title: note.title } : {}),
          ...(note.text !== undefined ? { text: note.text } : {}),
          revision: existing.revision + 1,
          updatedAt: iso(driver.now),
          author: 'orchestrator',
        });
        delete existing.deleted;
        driver.change();
        return `Note ${existing.id} updated.`;
      }
      const id = note.id || crypto.randomUUID().slice(0, 8);
      run.notes.push({
        id,
        revision: 1,
        title: note.title ?? '',
        text: note.text ?? '',
        author: 'orchestrator',
        updatedAt: iso(driver.now),
      });
      driver.event('note', `Noted ${note.title || id}`);
      return `Note ${id} saved.`;
    }
    case 'mission_wait': {
      const { until, seconds, reason } = input as z.infer<typeof inputs.mission_wait>;
      const at = until ? Date.parse(until) : seconds ? driver.now + seconds * 1000 : NaN;
      if (!Number.isFinite(at)) throw new Error('Give until as an ISO time, or seconds.');
      const id = crypto.randomUUID().slice(0, 8);
      run.timers.push({
        id,
        at: iso(at),
        reason: reason ?? '',
        status: 'pending',
        createdAt: iso(driver.now),
      });
      driver.event('wait', `Timer for ${clock(at)}${reason ? `: ${reason}` : ''}`);
      return `Timer ${id} set for ${iso(at)}. End your turn; you are woken then.`;
    }
    case 'mission_screen': {
      const request = input as z.infer<typeof inputs.mission_screen>;
      const computer =
        findComputer(driver, request.computer) ??
        host.computers().find((c) => c.environmentId === host.self().environmentId)!;
      if (request.op === 'run') {
        if (!request.action) throw new Error('Name the action to run.');
        const outcome = await host.screens.run(
          computer.environmentId,
          request.screen,
          request.action,
          request.params ?? {},
        );
        return JSON.stringify(outcome, null, 2);
      }
      if (request.op === 'load')
        return JSON.stringify(
          await host.screens.load(computer.environmentId, request.screen),
          null,
          2,
        );
      if (!request.key) throw new Error('Name the key to save.');
      await host.screens.save(
        computer.environmentId,
        request.screen,
        request.key,
        request.value ?? null,
      );
      return 'Saved.';
    }
    case 'mission_run_workflow': {
      const {
        id,
        inputs: values = {},
        wait = true,
      } = input as z.infer<typeof inputs.mission_run_workflow>;
      const definition = await host.definition(id);
      if (!definition) throw new Error('No saved workflow has that id. workflow_list lists them.');
      const runId = crypto.randomUUID();
      const child = staticRun(
        id,
        definition.body,
        definition.revision,
        values,
        { preferred: host.self().environmentId, elsewhere: run.driver.elsewhere },
        { kind: 'workflow', runId: driver.id },
        driver.now,
      );
      await host.createRun(runId, child);
      run.children.push({ runId, revision: 1, title: child.title, wait, status: 'running' });
      driver.event('workflow', `Started workflow ${child.title}`);
      return `Workflow run ${runId} started.${wait ? ' Its output arrives with a later turn.' : ''}`;
    }
    case 'mission_complete': {
      const { summary, status = 'completed' } = input as z.infer<typeof inputs.mission_complete>;
      run.output = summary;
      for (const agent of run.agents)
        if (
          agent.role !== 'orchestrator' &&
          (agent.status === 'running' || agent.status === 'waiting')
        ) {
          const conversation = host.conversation(agent.conversationId);
          if (conversation && replying(conversation))
            await host.stopChat(agent.conversationId).catch(() => {});
          Object.assign(agent, {
            status: 'stopped',
            endedAt: iso(driver.now),
            revision: agent.revision + 1,
          });
          delete agent.pending;
        }
      for (const question of run.questions)
        if (question.status === 'pending')
          Object.assign(question, { status: 'cancelled', revision: question.revision + 1 });
      for (const timer of run.timers) if (timer.status === 'pending') timer.status = 'cancelled';
      run.status = status;
      run.endedAt = iso(driver.now);
      run.detail = '';
      run.inbox = [];
      for (const session of run.sessions) if (!session.endedAt) endSession(driver, session);
      driver.event(status, status === 'completed' ? 'Mission complete' : 'Mission failed');
      driver.alert(
        status,
        summary
          .split('\n')
          .find((l) => l.trim())
          ?.trim() ?? summary,
      );
      for (const agent of run.agents) if (!agent.listed) host.releaseChat(agent.conversationId);
      driver.change();
      return status === 'completed' ? 'The mission is complete.' : 'The mission ended as failed.';
    }
  }
}
