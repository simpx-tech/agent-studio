import {
  abandonedReplyError,
  copiedReplyError,
  interruptedReplyError,
  messageText,
  type ChatLocation,
  type ChatSettings,
  type Conversation,
  type Message,
  type ProviderId,
} from './domain';
import type { Fleet } from './fleet';
import type { UsageSnapshot } from './usage';
import {
  KEPT_ALERTS,
  answerText,
  nodeConfig,
  readRun,
  triggerOf,
  type Activation,
  type EventInput,
  type NodeType,
  type RunAgent,
  type RunAlert,
  type StepOutput,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowRun,
} from './workflow-model';
import { mergeRun } from './workflow-merge';
import {
  conditionHolds,
  loopItems,
  renderTemplate,
  replyJson,
  valueAt,
  valueText,
} from './workflow-templates';
import { exhaustedUntil } from './workflow-usage';
import type { PutResult } from './workflow-store';

/**
 * The workflow engine (docs/WORKFLOWS.md). One desktop page drives each active run, the one
 * holding its lease (src/lib/workflow-client.svelte.ts), through a `RunDriver`: it keeps the run
 * in memory, advances it on every tick and writes it back with compare-and-set, merging what
 * others wrote meanwhile. Everything a run does to chats, accounts, screens and computers goes
 * through the page's `WorkflowHost`.
 */

export type Readiness = { ready: true } | { ready: false; reason: string };
export type ChatSpec = {
  /** The conversation's id, chosen first so a driver that stops before saving it reuses it. */
  id: string;
  title: string;
  location?: ChatLocation;
  settings: ChatSettings;
  text: string;
  listed: boolean;
  mission?: { runId: string; role: 'orchestrator' };
};
export type ScreenOutcome = { exitCode: number | null; stdout: string; stderr: string };
export interface WorkflowHost {
  self(): { environmentId: string; computerId: string; server: boolean; name: string };
  now(): number;
  fleet(): Fleet;
  /** Whether an environment's computer is online, or undefined when unknown. */
  online(environmentId: string): boolean | undefined;
  conversation(id: string): Conversation | undefined;
  conversations(): readonly Conversation[];
  /** Creates the chat and sends its first message, returning the reply's message id. */
  startChat(spec: ChatSpec): Promise<{ replyId: string }>;
  /** Sends an idle chat its next message, returning the reply's message id. */
  sendToChat(conversationId: string, text: string): Promise<{ replyId: string }>;
  steerChat(conversationId: string, text: string): Promise<void>;
  stopChat(conversationId: string): Promise<void>;
  /** Ends a chat's parked CLI process; its next message resumes its session. */
  releaseChat(conversationId: string): void;
  /** Moves a chat's next replies to another account of its agent. */
  switchAccount(conversationId: string, connectionId: string): void;
  readiness(settings: ChatSettings, location?: ChatLocation): Readiness;
  usage(connectionId: string | undefined, provider: ProviderId): UsageSnapshot | undefined;
  refreshUsage(connectionId: string | undefined, provider: ProviderId): void;
  /** The least used ready account of an agent at a location, leaving out `exclude`. */
  leastUsed(
    provider: ProviderId,
    location: ChatLocation | undefined,
    model: string,
    exclude?: string[],
  ): string | undefined;
  screens: {
    run(
      environmentId: string,
      id: string,
      action: string,
      params: Record<string, unknown>,
    ): Promise<ScreenOutcome>;
    load(environmentId: string, id: string): Promise<Record<string, unknown>>;
    save(environmentId: string, id: string, key: string, value: unknown): Promise<void>;
  };
  /** Creates another run, for Run workflow steps and missions. */
  createRun(id: string, run: WorkflowRun): Promise<void>;
  /** The latest known copy of a run, for parents following their children. */
  knownRun(id: string): WorkflowRun | undefined;
  definition(id: string): Promise<{ body: WorkflowDefinition; revision: number } | undefined>;
  /** Every computer (each environment a chat can run in), as missions choose between them. */
  computers(): {
    environmentId: string;
    computerId: string;
    name: string;
    platform: string;
    online: boolean | undefined;
    server: boolean;
    providers: ProviderId[];
    folders: string[];
  }[];
  /** Every account connection, with whether it can answer now. */
  accounts(): {
    connectionId: string;
    name: string;
    provider: ProviderId;
    environmentId: string;
    ready: boolean;
    detail: string;
  }[];
}
export interface RunWriter {
  put(id: string, expected: number, body: WorkflowRun, events: EventInput[]): Promise<PutResult>;
}

export const iso = (at: number) => new Date(at).toISOString();
const interrupted = (message: Message) =>
  message.error === interruptedReplyError ||
  message.error === abandonedReplyError ||
  message.error === copiedReplyError;
// A reply its requester lost touch with may still be running on its computer.
const uncertain = (message: Message) =>
  /relay|disconnected|request expired|will not be replayed|no longer available|connection lost/i.test(
    message.error ?? '',
  );
/** A reply's text, or the screens it saved for a Screen step. */
export const replyText = (message: Message) => messageText(message);
/** Whether a chat's latest reply is still running. */
export const replying = (conversation: Conversation) => {
  const last = conversation.messages.at(-1);
  return last?.role === 'assistant' && last.status === 'running';
};
const agentLike = (type: string) => type === 'agent' || type === 'screen';
const minute = 60_000;

export class RunDriver {
  run: WorkflowRun;
  /** The copy last written or read, which a conflicting write merges against. */
  private base: WorkflowRun;
  revision: number;
  private events: EventInput[] = [];
  private dirty = false;
  private writing: Promise<void> | undefined;
  /** Set when the run's document is gone from the store. */
  removed = false;
  /** Set by the supervisor while its lease is unconfirmed: nothing new starts. */
  suspended = false;
  constructor(
    readonly id: string,
    run: WorkflowRun,
    revision: number,
    readonly host: WorkflowHost,
    readonly writer: RunWriter,
  ) {
    this.run = structuredClone(run);
    this.base = structuredClone(run);
    this.revision = revision;
  }

  get now() {
    return this.host.now();
  }
  /** Marks the run changed, for the next write. */
  change() {
    this.dirty = true;
    this.run.updatedAt = iso(this.now);
  }
  event(kind: string, text: string, extra: Partial<EventInput> = {}) {
    const event = { kind, text, ...extra, at: iso(this.now) };
    this.events.push(event);
    this.recentEvents = [...this.recentEvents, event].slice(-50);
    this.change();
  }
  /** History this driver recorded lately, for the orchestrator's state. */
  private recentEvents: EventInput[] = [];
  recent() {
    return this.recentEvents.map(({ at, kind, text }) => ({ at, kind, text }));
  }
  alert(kind: RunAlert['kind'], text: string) {
    this.run.alerts = [
      ...this.run.alerts,
      { id: crypto.randomUUID(), kind, title: this.run.title, text, at: iso(this.now) },
    ].slice(-KEPT_ALERTS);
    this.change();
  }

  /** Takes in a newer copy someone else wrote: answers, commands, notes. */
  absorb(theirs: WorkflowRun, revision: number) {
    if (revision <= this.revision) return;
    this.run = mergeRun(this.base, this.run, theirs);
    this.base = structuredClone(theirs);
    this.revision = revision;
    this.dirty = true;
  }

  /** Writes what changed, merging over anything written meanwhile. */
  async flush(): Promise<void> {
    while (this.writing) await this.writing;
    if ((!this.dirty && !this.events.length) || this.removed) return;
    this.writing = (async () => {
      for (;;) {
        const body = structuredClone(this.run);
        const events = this.events.splice(0);
        this.dirty = false;
        let result: PutResult;
        try {
          result = await this.writer.put(this.id, this.revision, body, events);
        } catch (error) {
          this.events.unshift(...events);
          this.dirty = true;
          throw error;
        }
        if (result.ok) {
          this.base = body;
          this.revision = result.doc.revision;
          if (!this.dirty && !this.events.length) return;
          continue;
        }
        this.events.unshift(...events);
        const theirs = result.current ? readRun(result.current.body) : undefined;
        if (!result.current || !theirs) {
          this.removed = true;
          return;
        }
        this.run = mergeRun(this.base, this.run, theirs);
        this.base = structuredClone(theirs);
        this.revision = result.current.revision;
        this.dirty = true;
      }
    })();
    try {
      await this.writing;
    } finally {
      this.writing = undefined;
    }
  }

  /** Advances the run once: commands, then its steps or its mission. */
  async tick(mission?: (driver: RunDriver) => Promise<void>) {
    if (this.removed) return;
    this.applyCommands();
    if (!this.suspended && this.run.status === 'running') {
      if (this.run.mode === 'static') await this.tickStatic();
      else if (mission) await mission(this);
    }
    if (this.run.mode === 'static') this.updateDetail();
    await this.flush();
  }

  // ---- Commands -------------------------------------------------------------------------------

  private applyCommands() {
    const run = this.run;
    for (const command of run.commands) {
      if (run.handled.includes(command.id)) continue;
      run.handled = [...run.handled, command.id];
      this.change();
      switch (command.kind) {
        case 'pause':
          if (run.status === 'running') {
            run.status = 'paused';
            run.detail = 'Paused';
            this.event('command', 'Paused');
          }
          break;
        case 'resume':
          if (run.status === 'paused') {
            run.status = 'running';
            run.detail = '';
            this.event('command', 'Resumed');
            if (run.mode === 'dynamic') this.inbox('command', 'The user resumed the mission.');
          }
          break;
        case 'stop':
          if (run.status === 'running' || run.status === 'paused') void this.stop('Stopped');
          break;
        case 'driver':
          // Where the run continues: the computer it prefers and those that may take over.
          if (command.driver) {
            run.driver = structuredClone(command.driver);
            const name = this.host
              .computers()
              .find((c) => c.environmentId === command.driver!.preferred)?.name;
            this.event('command', `Runs on ${name ?? 'another computer'}`);
          }
          break;
        case 'retry':
        case 'skip': {
          const activation = run.activations.find((a) => a.id === command.activationId);
          if (!activation || !['failed', 'waiting', 'stopped'].includes(activation.status)) break;
          if (command.kind === 'retry') {
            this.update(activation, {
              status: 'queued',
              error: undefined,
              attempts: 0,
              wait: undefined,
              waitFor: undefined,
              waitUntil: undefined,
            });
            this.event('command', `Retrying ${this.label(activation)}`, {
              nodeId: activation.nodeId,
            });
          } else {
            this.event('command', `Skipped ${this.label(activation)}`, {
              nodeId: activation.nodeId,
            });
            this.finish(activation, { text: '' });
          }
          if (run.status === 'failed') {
            run.status = 'running';
            run.endedAt = undefined;
            run.detail = '';
          }
          break;
        }
      }
    }
  }

  /** Ends the run as stopped (or failed), stopping its replies. */
  async stop(text: string, status: 'stopped' | 'failed' = 'stopped') {
    const run = this.run;
    run.status = status;
    run.endedAt = iso(this.now);
    run.detail = status === 'failed' ? text : '';
    for (const activation of run.activations)
      if (['queued', 'running', 'waiting'].includes(activation.status))
        this.update(activation, { status: 'stopped', endedAt: iso(this.now) });
    for (const agent of run.agents) {
      if (agent.status === 'running' || agent.status === 'waiting') {
        const conversation = this.host.conversation(agent.conversationId);
        if (conversation && replying(conversation))
          await this.host.stopChat(agent.conversationId).catch(() => {});
        Object.assign(agent, {
          status: 'stopped',
          endedAt: iso(this.now),
          revision: agent.revision + 1,
        });
      }
    }
    for (const session of run.sessions) session.endedAt ??= iso(this.now);
    for (const question of run.questions)
      if (question.status === 'pending')
        Object.assign(question, { status: 'cancelled', revision: question.revision + 1 });
    for (const timer of run.timers) if (timer.status === 'pending') timer.status = 'cancelled';
    this.event(status, text);
    // A run you stopped needs no alert.
    if (status === 'failed') this.alert('failed', text);
    this.change();
  }

  /** An item the orchestrator hears with its next turn. */
  inbox(
    kind: WorkflowRun['inbox'][number]['kind'],
    text: string,
    extra: Partial<WorkflowRun['inbox'][number]> = {},
  ) {
    this.run.inbox = [
      ...this.run.inbox,
      { id: crypto.randomUUID(), at: iso(this.now), kind, text, ...extra },
    ];
    this.change();
  }

  // ---- Static runs ----------------------------------------------------------------------------

  node(id: string): WorkflowNode | undefined {
    return this.run.graph.nodes.find((n) => n.id === id);
  }
  label(activation: Activation) {
    const node = this.node(activation.nodeId);
    return node?.title || node?.key || 'a step';
  }
  update(activation: Activation, patch: Partial<Activation>) {
    Object.assign(activation, patch, { revision: activation.revision + 1 });
    for (const [key, value] of Object.entries(patch))
      if (value === undefined) delete (activation as Record<string, unknown>)[key];
    this.change();
  }
  /** A new activation of a step, queued to start. */
  activate(
    nodeId: string,
    scope: string,
    input: StepOutput | undefined,
    from?: Activation['from'],
  ) {
    const activation: Activation = {
      id: crypto.randomUUID(),
      revision: 1,
      nodeId,
      scope,
      status: 'queued',
      ...(input ? { input } : {}),
      attempts: 0,
      createdAt: iso(this.now),
      ...(from ? { from } : {}),
    };
    this.run.activations.push(activation);
    this.change();
    return activation;
  }

  private async tickStatic() {
    const run = this.run;
    for (const activation of run.activations) {
      if (run.status !== 'running') return;
      if (activation.status === 'running' && activation.replyId) this.reconcileReply(activation);
      else if (activation.status === 'waiting') this.reconcileWait(activation);
    }
    // Steps that end at once hand over to more, and ended loop items and merges to the steps
    // after them; a tick goes on until nothing more is ready, and leaves a long chain of
    // instant steps to the next tick.
    for (let started = 0; started < 500 && run.status === 'running'; ) {
      const next = run.activations.find((a) => a.status === 'queued');
      if (next) {
        await this.start(next);
        started++;
        continue;
      }
      this.settleScopes();
      if (!run.activations.some((a) => a.status === 'queued')) break;
    }
    if (run.status !== 'running') return;
    this.complete();
  }

  /** Whether nothing of a scope, or of the loop items inside it, is still to do. */
  quiescent(scope: string): boolean {
    return !this.run.activations.some(
      (a) =>
        (a.scope === scope || (scope ? a.scope.startsWith(`${scope}/`) : true)) &&
        ['queued', 'running', 'waiting'].includes(a.status) &&
        a.waitFor !== 'merge',
    );
  }

  /** Loop items and merges whose scope has nothing left to do. */
  private settleScopes() {
    const run = this.run;
    // Deeper scopes first, so an inner loop ends before the outer item it belongs to.
    const controllers = run.activations
      .filter((a) => a.status === 'running' && a.loop)
      .sort((a, b) => b.scope.split('/').length - a.scope.split('/').length);
    for (const loop of controllers) {
      const state = loop.loop!;
      let moved = false;
      for (let index = 0; index < state.next; index++) {
        if (state.finished.includes(index)) continue;
        const scope = childScope(loop, index);
        if (!this.quiescent(scope)) continue;
        // Merges of the item that still wait go on with what reached them.
        this.fireMerges(scope);
        if (!this.quiescent(scope)) continue;
        const outputs = [...state.outputs];
        outputs[index] = this.lastOutput(scope);
        Object.assign(state, {
          finished: [...state.finished, index],
          done: state.done + 1,
          outputs,
        });
        moved = true;
      }
      if (
        !state.parallel &&
        state.next < state.items.length &&
        state.finished.length === state.next
      ) {
        this.iterate(loop, state.next);
        state.next += 1;
        moved = true;
      }
      if (moved) this.update(loop, { loop: { ...state } });
      if (state.finished.length >= state.items.length) {
        const outputs = state.outputs.map((o) => o ?? '');
        this.finish(loop, { text: JSON.stringify(outputs, null, 2), json: outputs }, 'done');
      }
    }
    if (this.quiescent('')) this.fireMerges('');
  }
  private fireMerges(scope: string) {
    for (const merge of this.run.activations.filter(
      (a) => a.status === 'waiting' && a.waitFor === 'merge' && a.scope === scope,
    ))
      this.finish(merge, this.combine(merge.arrivals ?? {}));
  }
  /** The text of the latest step to end in a scope, for a loop item's output. */
  private lastOutput(scope: string): string {
    const ended = this.run.activations
      .filter((a) => (a.scope === scope || a.scope.startsWith(`${scope}/`)) && a.status === 'done')
      .sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? ''));
    const last = ended.at(-1);
    return last ? this.outputText(last.output) : '';
  }

  /** Completes the run once nothing is left to do. */
  private complete() {
    const run = this.run;
    if (run.status !== 'running' || !this.quiescent('')) return;
    if (run.activations.some((a) => a.waitFor === 'merge' && a.status === 'waiting')) return;
    const ended = run.activations
      .filter((a) => a.status === 'done')
      .sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? ''));
    const end = [...ended].reverse().find((a) => this.node(a.nodeId)?.type === 'end');
    run.output ??= this.outputText((end ?? ended.at(-1))?.output);
    run.status = 'completed';
    run.endedAt = iso(this.now);
    run.detail = '';
    this.event('completed', 'Completed');
    this.alert('completed', firstLine(run.output) || 'Completed');
    this.change();
  }

  /** Starts a queued activation. */
  private async start(activation: Activation) {
    const node = this.node(activation.nodeId);
    if (!node) return this.fail(activation, 'This step is no longer in the workflow.');
    const now = this.now;
    // Waiting for a computer, an account, a chat or a usage reset, or continuing an interrupted
    // reply, is not another try.
    const again =
      activation.resume || ['usage', 'ready', 'chat', 'reply'].includes(activation.waitFor ?? '');
    const first = !again && activation.attempts === 0;
    this.update(activation, {
      status: 'running',
      attempts: again ? Math.max(1, activation.attempts) : activation.attempts + 1,
      startedAt: activation.startedAt ?? iso(now),
      wait: undefined,
      waitFor: undefined,
      waitUntil: undefined,
    });
    if (first)
      this.event('step', `${node.title || node.key} started`, {
        nodeId: node.id,
        activationId: activation.id,
      });
    try {
      await this.perform(activation, node);
    } catch (error) {
      this.fail(activation, String(error).replace(/^Error: /, ''));
    }
  }

  private async perform(activation: Activation, node: WorkflowNode) {
    const type = node.type as NodeType;
    const render = (text: string) => this.render(text, activation);
    switch (type) {
      case 'start': {
        // The trigger that started the run hands over what fired it; a manual one, its inputs.
        const trigger = this.run.trigger;
        if (trigger?.nodeId === node.id && trigger.payload !== undefined)
          return this.finish(activation, {
            json: trigger.payload,
            text: trigger.text || JSON.stringify(trigger.payload, null, 2),
          });
        return this.finish(activation, {
          json: this.run.inputs,
          text: JSON.stringify(this.run.inputs, null, 2),
        });
      }
      case 'agent':
      case 'screen':
        return this.startAgentStep(activation, node);
      case 'message':
        return this.startMessage(activation, node);
      case 'read': {
        const config = nodeConfig(node, 'read');
        const conversation = this.targetChat(config, activation);
        if (!conversation) return this.fail(activation, 'Its chat is not available.');
        return this.finish(activation, { text: chatText(conversation, config.what, config.count) });
      }
      case 'condition': {
        const config = nodeConfig(node, 'condition');
        const holds = conditionHolds(
          config.op,
          render(config.left),
          render(config.right),
          config.ignoreCase,
        );
        return this.finish(activation, activation.input ?? {}, holds ? 'true' : 'false');
      }
      case 'loop': {
        const config = nodeConfig(node, 'loop');
        const items = loopItems(this.raw(config.items, activation));
        if (!items.length) return this.finish(activation, { json: [], text: '[]' }, 'done');
        const loop = {
          items,
          next: config.parallel ? items.length : 1,
          done: 0,
          outputs: [],
          parallel: config.parallel,
          finished: [],
        };
        this.update(activation, { loop });
        for (let index = 0; index < loop.next; index++) this.iterate(activation, index);
        return;
      }
      case 'merge':
        return;
      case 'wait': {
        const config = nodeConfig(node, 'wait');
        const until =
          config.mode === 'for'
            ? this.now +
              config.amount * { seconds: 1e3, minutes: 6e4, hours: 36e5, days: 864e5 }[config.unit]
            : untilTime(render(config.until), this.now);
        if (until == null)
          return this.fail(activation, 'Give a time like 14:30 or a date and time.');
        if (until <= this.now) return this.finish(activation, activation.input ?? {});
        return this.wait(activation, 'time', `Waiting until ${clock(until)}`, until);
      }
      case 'ask': {
        const config = nodeConfig(node, 'ask');
        const id = crypto.randomUUID();
        const question = render(config.question);
        this.run.questions.push({
          id,
          revision: 1,
          status: 'pending',
          source: 'step',
          activationId: activation.id,
          createdAt: iso(this.now),
          questions: [
            {
              id: 'answer',
              header: render(config.header),
              question,
              options: config.choices
                .filter((c) => c.trim())
                .map((label) => ({ label: render(label), description: '' })),
              multiSelect: config.multiple,
            },
          ],
        });
        this.alert('question', question);
        this.event('question', question, { nodeId: node.id, activationId: activation.id });
        this.update(activation, { questionId: id });
        return this.wait(activation, 'question', 'Waiting for your answer');
      }
      case 'confirm': {
        const config = nodeConfig(node, 'confirm');
        const id = crypto.randomUUID();
        const question = render(config.question);
        const approve = render(config.approve).trim() || 'Approve';
        let reject = render(config.reject).trim() || 'Reject';
        if (reject === approve) reject = `${reject} (no)`;
        this.run.questions.push({
          id,
          revision: 1,
          status: 'pending',
          source: 'step',
          activationId: activation.id,
          confirm: { approve, reject },
          createdAt: iso(this.now),
          questions: [
            {
              id: 'answer',
              header: render(config.header),
              question,
              options: [
                { label: approve, description: '' },
                { label: reject, description: '' },
              ],
              multiSelect: false,
            },
          ],
        });
        this.alert('question', question);
        this.event('question', question, { nodeId: node.id, activationId: activation.id });
        this.update(activation, { questionId: id });
        return this.wait(activation, 'question', 'Waiting for your approval');
      }
      case 'notify': {
        const config = nodeConfig(node, 'notify');
        const text = [render(config.title), render(config.text)].filter((t) => t.trim()).join(': ');
        this.alert('notify', text || node.title || 'Notification');
        this.event('notify', text, { nodeId: node.id });
        return this.finish(activation, activation.input ?? {});
      }
      case 'set': {
        const config = nodeConfig(node, 'set');
        const values: Record<string, unknown> = {};
        for (const entry of config.values) {
          const text = render(entry.value);
          if (!entry.json) values[entry.name] = text;
          else
            try {
              values[entry.name] = JSON.parse(text);
            } catch {
              return this.fail(activation, `${entry.name} is not valid JSON.`);
            }
        }
        return this.finish(activation, { json: values, text: JSON.stringify(values, null, 2) });
      }
      case 'screenAction': {
        const config = nodeConfig(node, 'screenAction');
        const params: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(config.params)) params[name] = render(value);
        const outcome = await this.host.screens.run(
          config.environmentId,
          config.screenId,
          config.action,
          params,
        );
        if (outcome.exitCode !== 0)
          return this.fail(
            activation,
            outcome.stderr.trim() || `The action ended with code ${outcome.exitCode}.`,
          );
        return this.finish(activation, { text: outcome.stdout, json: parseJson(outcome.stdout) });
      }
      case 'screenData': {
        const config = nodeConfig(node, 'screenData');
        if (config.op === 'load') {
          const values = await this.host.screens.load(config.environmentId, config.screenId);
          const value = values[render(config.key)];
          return this.finish(activation, { json: value, text: valueText(value) });
        }
        const text = render(config.value);
        let value: unknown = text;
        if (config.json)
          try {
            value = JSON.parse(text);
          } catch {
            return this.fail(activation, 'The value is not valid JSON.');
          }
        await this.host.screens.save(
          config.environmentId,
          config.screenId,
          render(config.key),
          value,
        );
        return this.finish(activation, { json: value, text });
      }
      case 'workflow':
        return this.startChild(activation, node);
      case 'end': {
        const config = nodeConfig(node, 'end');
        const output = render(config.output);
        this.run.output = output;
        this.finish(activation, { text: output });
        if (config.status === 'failed') await this.stop(output || 'Failed', 'failed');
        return;
      }
      default:
        return this.fail(activation, `This release cannot run ${node.type} steps.`);
    }
  }

  private iterate(loop: Activation, index: number) {
    const item = loop.loop!.items[index];
    this.follow(loop, 'each', { text: valueText(item), json: item }, childScope(loop, index));
  }

  /** Ends an activation and hands its output to the steps its port connects to. */
  finish(activation: Activation, output: StepOutput, port = 'out') {
    this.update(activation, {
      status: 'done',
      output: { ...output, port },
      endedAt: iso(this.now),
      wait: undefined,
      waitFor: undefined,
      waitUntil: undefined,
    });
    const node = this.node(activation.nodeId);
    if (node && node.type !== 'start')
      this.event('step', `${node.title || node.key} finished`, {
        nodeId: node.id,
        activationId: activation.id,
      });
    this.follow(activation, port, output);
  }

  private follow(
    activation: Activation,
    port: string,
    output: StepOutput,
    scope = activation.scope,
  ) {
    for (const edge of this.run.graph.edges) {
      if (edge.source !== activation.nodeId || edge.sourcePort !== port) continue;
      const target = this.node(edge.target);
      if (!target) continue;
      // A connection back into the loop an item belongs to only ends that item.
      if (
        target.type === 'loop' &&
        scope.split('/').some((part) => this.loopOf(part) === target.id)
      )
        continue;
      if (target.type === 'merge') {
        this.arrive(target, edge.id, scope, output);
        continue;
      }
      this.activate(target.id, scope, output, { activationId: activation.id, edgeId: edge.id });
    }
  }
  private loopOf(part: string) {
    const id = part.split('#')[0];
    return this.run.activations.find((a) => a.id === id)?.nodeId;
  }
  private arrive(node: WorkflowNode, edgeId: string, scope: string, output: StepOutput) {
    const incoming = this.run.graph.edges.filter((e) => e.target === node.id).map((e) => e.id);
    let merge = this.run.activations.find(
      (a) =>
        a.nodeId === node.id &&
        a.scope === scope &&
        a.status === 'waiting' &&
        a.waitFor === 'merge',
    );
    if (!merge) {
      merge = this.activate(node.id, scope, undefined);
      this.update(merge, {
        status: 'waiting',
        waitFor: 'merge',
        wait: 'Waiting for its branches',
        arrivals: {},
      });
    }
    const arrivals = { ...merge.arrivals, [edgeId]: output };
    this.update(merge, { arrivals });
    if (incoming.every((id) => id in arrivals)) this.finish(merge, this.combine(arrivals, incoming));
  }

  /** A failure: retried, routed to the error port, passed over, or ending the run. */
  fail(activation: Activation, error: string) {
    const node = this.node(activation.nodeId);
    this.event('error', `${node?.title || node?.key || 'A step'} failed: ${error}`, {
      nodeId: activation.nodeId,
      activationId: activation.id,
    });
    if (node && activation.attempts <= node.retries)
      return this.wait(
        activation,
        'retry',
        `Retrying after: ${firstLine(error)}`,
        this.now + node.retryDelay * 1000,
        {
          error,
        },
      );
    const routed = this.run.graph.edges.some(
      (e) => e.source === activation.nodeId && e.sourcePort === 'error',
    );
    if (routed) {
      this.update(activation, {
        status: 'failed',
        error,
        endedAt: iso(this.now),
        output: { port: 'error', text: error },
        wait: undefined,
        waitFor: undefined,
      });
      this.follow(activation, 'error', { text: error });
      return;
    }
    if (node?.onError === 'continue') {
      this.update(activation, { error });
      return this.finish(activation, { text: '' });
    }
    this.update(activation, {
      status: 'failed',
      error,
      endedAt: iso(this.now),
      wait: undefined,
      waitFor: undefined,
    });
    void this.stop(`${node?.title || node?.key || 'A step'} failed: ${error}`, 'failed');
  }

  wait(
    activation: Activation,
    kind: NonNullable<Activation['waitFor']>,
    text: string,
    until?: number,
    extra: Partial<Activation> = {},
  ) {
    this.update(activation, {
      status: 'waiting',
      waitFor: kind,
      wait: text,
      ...(until != null ? { waitUntil: iso(until) } : { waitUntil: undefined }),
      ...extra,
    });
  }

  private reconcileWait(activation: Activation) {
    const due = !activation.waitUntil || Date.parse(activation.waitUntil) <= this.now;
    switch (activation.waitFor) {
      case 'time':
        if (due) this.finish(activation, activation.input ?? {});
        return;
      case 'retry':
      case 'usage':
      case 'ready':
      case 'chat':
        if (due) this.update(activation, { status: 'queued' });
        return;
      case 'question': {
        const question = this.run.questions.find((q) => q.id === activation.questionId);
        if (!question || question.status === 'pending') return;
        if (question.confirm) {
          // Approved only by its button; a skipped or withdrawn question is not approval.
          const approved =
            question.status === 'answered' &&
            !question.skipped &&
            question.answers?.[0]?.values[0] === question.confirm.approve;
          return this.finish(
            activation,
            { text: answerText(question), json: approved },
            approved ? 'approved' : 'rejected',
          );
        }
        return this.finish(activation, {
          text: answerText(question),
          json:
            question.status === 'answered' && !question.skipped
              ? question.answers?.[0]?.values
              : null,
        });
      }
      case 'child': {
        const child = this.run.children.find((c) => c.activationId === activation.id);
        const known = child ? this.host.knownRun(child.runId) : undefined;
        if (!child || !known || known.status === 'running' || known.status === 'paused') return;
        Object.assign(child, {
          status: known.status,
          output: known.output,
          revision: child.revision + 1,
        });
        if (known.status === 'completed')
          return this.finish(activation, { text: known.output ?? '' });
        return this.fail(
          activation,
          `${known.title} ${known.status === 'failed' ? 'failed' : 'stopped'}: ${known.detail || known.output || ''}`.trim(),
        );
      }
      case 'reply':
        if (activation.replyId) this.reconcileReply(activation);
        if (activation.status === 'waiting' && due)
          this.update(activation, { status: 'queued', resume: true });
        return;
    }
  }

  /** Follows the reply an agent-like or Message step waits for. */
  private reconcileReply(activation: Activation) {
    const conversation = activation.conversationId
      ? this.host.conversation(activation.conversationId)
      : undefined;
    const reply = conversation?.messages.find((m) => m.id === activation.replyId);
    // A chat or reply another computer runs may not have arrived yet.
    if (!reply || reply.status === 'running') return;
    if (reply.status === 'complete') {
      const node = this.node(activation.nodeId);
      const text = replyText(reply);
      const json =
        node && agentLike(node.type) && nodeConfig(node, 'agent').json
          ? replyJson(text)
          : undefined;
      this.settleStep(conversation!.id, 'done');
      if (node?.type === 'screen') {
        const screen = reply.screens?.at(-1);
        return this.finish(activation, {
          text: screen?.id ?? text,
          json: screen ? { ...screen } : undefined,
        });
      }
      if (conversation && node && agentLike(node.type) && !nodeConfig(node, 'agent').listed)
        this.host.releaseChat(conversation.id);
      return this.finish(activation, {
        ref: { conversationId: conversation!.id, messageId: reply.id },
        ...(json !== undefined ? { json } : {}),
      });
    }
    if (reply.usageLimit || /usage limit|rate limit|hit your/i.test(reply.error ?? '')) {
      const settings = reply.settings;
      if (settings) this.host.refreshUsage(settings.connectionId, settings.provider);
      const until =
        (settings &&
          exhaustedUntil(
            this.host.usage(settings.connectionId, settings.provider),
            settings,
            this.now,
          )) ||
        this.now + 15 * minute;
      const wait = `Waiting for a usage reset at ${clock(until)}`;
      this.settleStep(conversation!.id, 'waiting', wait);
      return this.wait(activation, 'usage', wait, until, { resume: true });
    }
    if (interrupted(reply)) return this.update(activation, { status: 'queued', resume: true });
    if (uncertain(reply)) {
      if (activation.waitFor !== 'reply')
        this.wait(activation, 'reply', 'Waiting to hear from its computer', this.now + 5 * minute);
      return;
    }
    const error =
      reply.status === 'cancelled' && !reply.error
        ? 'Its reply was stopped.'
        : (reply.error ?? 'Its reply failed.');
    this.settleStep(conversation!.id, reply.status === 'cancelled' ? 'stopped' : 'failed', error);
    this.fail(activation, error);
  }

  /** Keeps the chat of an Agent or Screen step in the run's agents in step with its reply. */
  private settleStep(conversationId: string, status: RunAgent['status'], wait?: string) {
    const agent = this.run.agents.find(
      (a) => a.role === 'step' && a.conversationId === conversationId,
    );
    if (!agent || (agent.status === status && agent.wait === wait)) return;
    const live = status === 'running' || status === 'waiting';
    Object.assign(agent, {
      status,
      revision: agent.revision + 1,
      ...(live ? {} : { endedAt: iso(this.now) }),
    });
    if (live) delete agent.endedAt;
    if (wait) agent.wait = wait;
    else delete agent.wait;
    this.change();
  }

  /** Starts or continues the chat of an Agent or Screen step. */
  private async startAgentStep(activation: Activation, node: WorkflowNode) {
    const config = nodeConfig(node, 'agent');
    const screen = node.type === 'screen' ? nodeConfig(node, 'screen') : undefined;
    const render = (text: string) => this.render(text, activation);
    const self = this.host.self();
    const location: ChatLocation = config.location ?? {
      computerId: self.computerId,
      environmentId: self.environmentId,
      path: '',
    };
    // The chat of this step for the same loop item, which a repeated run continues.
    const previous =
      config.chat === 'continue'
        ? [...this.run.activations]
            .reverse()
            .find(
              (a) =>
                a.id !== activation.id &&
                a.nodeId === node.id &&
                a.scope === activation.scope &&
                a.conversationId,
            )
        : undefined;
    const conversationId = activation.conversationId ?? previous?.conversationId;
    const existing = conversationId ? this.host.conversation(conversationId) : undefined;
    let connectionId = existing?.settings.connectionId ?? config.connectionId;
    if (!connectionId)
      connectionId = this.host.leastUsed(config.provider, location, config.model) ?? '';
    const settings: ChatSettings = existing
      ? { ...existing.settings }
      : {
          provider: config.provider,
          model: config.model,
          reasoning: config.reasoning,
          instructions: config.instructions,
          ...(connectionId ? { connectionId } : {}),
          ...(config.json && config.schema.trim() && !screen
            ? { outputSchema: config.schema }
            : {}),
        };
    const ready = this.host.readiness(settings, existing?.location ?? location);
    if (!ready.ready) return this.wait(activation, 'ready', ready.reason, this.now + 30_000);
    const until = exhaustedUntil(
      this.host.usage(settings.connectionId, settings.provider),
      settings,
      this.now,
    );
    if (until) {
      // Without a chosen account, another with room takes the step.
      const other =
        !config.connectionId && !existing
          ? this.host.leastUsed(
              config.provider,
              location,
              config.model,
              connectionId ? [connectionId] : [],
            )
          : undefined;
      if (!other || exhaustedUntil(this.host.usage(other, settings.provider), settings, this.now))
        return this.wait(
          activation,
          'usage',
          `Waiting for a usage reset at ${clock(until)}`,
          until,
        );
      settings.connectionId = other;
    }
    const task = screen
      ? `Build an Agent Studio screen titled "${render(screen.screenTitle) || node.title}" with save_screen${render(screen.screenId) ? `, updating the screen whose id is ${render(screen.screenId)}` : ''}. It should: ${render(screen.spec)}\n\nTest any actions with your own shell first. Reply with the screen's id.`
      : render(config.prompt) +
        (config.json && !config.schema.trim() ? '\n\nReply with JSON only.' : '');
    const text = activation.resume
      ? `Your previous reply was interrupted before it finished. Continue the task below from where you stopped, checking what is already done first.\n\n${task}`
      : task;
    if (existing) {
      if (replying(existing))
        return this.wait(activation, 'chat', 'Waiting for its chat', this.now + 5_000);
      const { replyId } = await this.host.sendToChat(existing.id, text);
      this.update(activation, { conversationId: existing.id, replyId, resume: undefined });
      this.settleStep(existing.id, 'running');
      return;
    }
    const id = conversationId ?? crypto.randomUUID();
    const environmentId = location.executionEnvironmentId ?? location.environmentId;
    this.update(activation, { conversationId: id, resume: undefined });
    this.trackAgent({
      conversationId: id,
      role: 'step',
      title: node.title || node.key,
      activationId: activation.id,
      environmentId,
      connectionId: settings.connectionId,
      provider: settings.provider,
      model: settings.model,
      listed: config.listed,
    });
    // The chat's id is saved before the chat exists, so a driver that stops in between reuses it.
    await this.flush();
    const { replyId } = await this.host.startChat({
      id,
      title: `${this.run.title} · ${render(config.title) || node.title || node.key}`,
      location: location.path ? location : { ...location, path: '' },
      settings,
      text,
      listed: config.listed,
    });
    this.update(activation, { replyId });
  }

  /** Records a chat the run started, which stays out of the chat lists unless listed. */
  trackAgent(
    agent: Pick<RunAgent, 'conversationId' | 'role' | 'title' | 'environmentId' | 'provider'> &
      Partial<RunAgent>,
  ) {
    const existing = this.run.agents.find((a) => a.conversationId === agent.conversationId);
    if (existing)
      Object.assign(existing, agent, {
        revision: existing.revision + 1,
        status: agent.status ?? 'running',
      });
    else
      this.run.agents.push({
        model: '',
        reasoning: '',
        listed: false,
        after: [],
        ...agent,
        revision: 1,
        status: agent.status ?? 'running',
        startedAt: iso(this.now),
      });
    this.change();
  }

  private async startMessage(activation: Activation, node: WorkflowNode) {
    const config = nodeConfig(node, 'message');
    const conversation = this.targetChat(config, activation);
    if (!conversation) return this.fail(activation, 'Its chat is not available.');
    const text = this.render(config.text, activation);
    const ready = this.host.readiness(conversation.settings, conversation.location);
    if (!ready.ready) return this.wait(activation, 'ready', ready.reason, this.now + 30_000);
    const running = replying(conversation) ? conversation.messages.at(-1) : undefined;
    if (config.mode === 'steer' && running) {
      await this.host.steerChat(conversation.id, text);
      if (!config.wait) return this.finish(activation, { text: '' });
      this.update(activation, { conversationId: conversation.id, replyId: running.id });
      return;
    }
    if (running) return this.wait(activation, 'chat', 'Waiting for its chat', this.now + 5_000);
    const { replyId } = await this.host.sendToChat(conversation.id, text);
    if (!config.wait) return this.finish(activation, { text: '' });
    this.update(activation, { conversationId: conversation.id, replyId });
  }

  private async startChild(activation: Activation, node: WorkflowNode) {
    const config = nodeConfig(node, 'workflow');
    const existing = this.run.children.find((c) => c.activationId === activation.id);
    if (existing) return this.wait(activation, 'child', `Waiting for ${existing.title}`);
    const definition = await this.host.definition(config.workflowId);
    if (!definition) return this.fail(activation, 'That workflow no longer exists.');
    const inputs: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.inputs))
      inputs[name] = this.render(value, activation);
    const id = crypto.randomUUID();
    const child = staticRun(
      config.workflowId,
      definition.body,
      definition.revision,
      inputs,
      {
        preferred: this.host.self().environmentId,
        elsewhere: this.run.driver.elsewhere,
      },
      { kind: 'workflow', runId: this.id },
      this.now,
    );
    child.parent = { runId: this.id, activationId: activation.id };
    await this.host.createRun(id, child);
    this.run.children.push({
      runId: id,
      revision: 1,
      title: child.title,
      activationId: activation.id,
      wait: config.wait,
      status: 'running',
    });
    this.event('step', `Started ${child.title}`, { nodeId: node.id, activationId: activation.id });
    if (!config.wait) return this.finish(activation, { text: id });
    this.wait(activation, 'child', `Waiting for ${child.title}`);
  }

  /** The chat a Message or Read step names: an earlier step's, or a chosen one. */
  private targetChat(
    config: { target: 'step' | 'chat'; step: string; conversationId: string },
    activation: Activation,
  ): Conversation | undefined {
    if (config.target === 'chat')
      return config.conversationId ? this.host.conversation(config.conversationId) : undefined;
    const node = this.run.graph.nodes.find((n) => n.key === config.step);
    const source = node
      ? this.latest(node.id, activation.scope, (a) => !!a.conversationId)
      : undefined;
    return source?.conversationId ? this.host.conversation(source.conversationId) : undefined;
  }

  /**
   * The latest activation of a step that `test` accepts, preferring the same loop item, then
   * the items it belongs to, then any.
   */
  latest(
    nodeId: string,
    scope: string,
    test: (a: Activation) => boolean = (a) => a.status === 'done',
  ) {
    const candidates = this.run.activations.filter((a) => a.nodeId === nodeId && test(a));
    const parts = scope ? scope.split('/') : [];
    for (let depth = parts.length; depth >= 0; depth--) {
      const at = parts.slice(0, depth).join('/');
      const found = candidates.filter((a) => a.scope === at).at(-1);
      if (found) return found;
    }
    return candidates.at(-1);
  }

  /** What a merge hands on: its branches' texts, and their values as a list. */
  private combine(arrivals: Record<string, StepOutput>, order = Object.keys(arrivals)): StepOutput {
    const outputs = order.filter((id) => id in arrivals).map((id) => arrivals[id]);
    return {
      text: outputs.map((o) => this.outputText(o)).join('\n\n'),
      json: outputs.map((o) => (o.json !== undefined ? o.json : this.outputText(o))),
    };
  }

  // ---- Templates ------------------------------------------------------------------------------

  outputText(output: StepOutput | undefined): string {
    if (!output) return '';
    if (output.text !== undefined) return output.text;
    if (output.ref) {
      const message = this.host
        .conversation(output.ref.conversationId)
        ?.messages.find((m) => m.id === output.ref!.messageId);
      if (message) return replyText(message);
    }
    return output.json !== undefined ? valueText(output.json) : '';
  }
  private outputJson(output: StepOutput | undefined): unknown {
    if (!output) return undefined;
    if (output.json !== undefined) return output.json;
    return replyJson(this.outputText(output));
  }
  /** A template's value: the raw value a single placeholder names, otherwise its text. */
  raw(template: string, activation: Activation): unknown {
    const single = template.trim().match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    return single ? this.resolve(single[1], activation) : this.render(template, activation);
  }
  render(template: string, activation: Activation): string {
    return renderTemplate(template, (path) => this.resolve(path, activation));
  }
  resolve(path: string, activation: Activation): unknown {
    const [head, ...rest] = path.split('.');
    const part = (value: unknown) => valueAt(value, rest);
    switch (head) {
      case 'input':
        return rest.length ? valueAt(this.run.inputs, rest) : this.run.inputs;
      case 'run':
        return part({ id: this.id, title: this.run.title });
      case 'now':
        return iso(this.now);
      case 'item':
      case 'index': {
        const scope = activation.scope.split('/').at(-1) ?? '';
        const [loopId, index] = scope.split('#');
        const loop = this.run.activations.find((a) => a.id === loopId)?.loop;
        if (!loop) return undefined;
        return head === 'index' ? Number(index) : part(loop.items[Number(index)]);
      }
      case 'previous':
        return this.field(activation.input, rest);
      case 'trigger': {
        // Whichever trigger started the run: what fired it and its kind.
        const trigger = this.run.trigger;
        if (!trigger) return undefined;
        if (rest[0] === 'kind') return trigger.kind;
        const fired = this.run.activations.find((a) => a.nodeId === trigger.nodeId && !a.scope);
        return this.field(fired?.output, rest);
      }
    }
    const node = this.run.graph.nodes.find((n) => n.key === head);
    if (!node) return undefined;
    const source = this.latest(node.id, activation.scope);
    if (!source) return undefined;
    if (rest[0] === 'chat') return source.conversationId;
    return this.field(source.output, rest);
  }
  private field(output: StepOutput | undefined, rest: string[]): unknown {
    const [what, ...path] = rest;
    if (!what || what === 'output') return this.outputText(output);
    if (what === 'json') return valueAt(this.outputJson(output), path);
    if (what === 'chat') return output?.ref?.conversationId;
    return undefined;
  }

  // ---- Status ---------------------------------------------------------------------------------

  private updateDetail() {
    const run = this.run;
    if (run.status !== 'running') return;
    const waiting = run.activations.filter((a) => a.status === 'waiting' && a.waitFor !== 'merge');
    const running = run.activations.filter((a) => a.status === 'running' && !a.loop);
    const question = waiting.find((a) => a.waitFor === 'question');
    const detail = question
      ? (question.wait ?? 'Waiting for your answer')
      : waiting.length && !running.length
        ? `${this.label(waiting[0])}: ${waiting[0].wait ?? 'waiting'}`
        : running.length
          ? running.length === 1
            ? `${this.label(running[0])} running`
            : `${running.length} steps running`
          : '';
    if (detail !== run.detail) {
      run.detail = detail;
      this.change();
    }
  }
}

/** The scope of a loop's item. */
export const childScope = (loop: Activation, index: number) =>
  loop.scope ? `${loop.scope}/${loop.id}#${index}` : `${loop.id}#${index}`;

const parseJson = (text: string) => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};
export const firstLine = (text: string | undefined) =>
  (text ?? '')
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? '';
export const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** When a Wait step's HH:MM (the next such time) or date and time is. */
export function untilTime(text: string, now: number): number | null {
  const time = text.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (time) {
    const at = new Date(now);
    at.setHours(Number(time[1]), Number(time[2]), 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  const at = Date.parse(text);
  return Number.isFinite(at) ? at : null;
}
/** A chat's text as Read steps and agents read it. */
export function chatText(
  conversation: Conversation,
  what: 'reply' | 'messages' | 'chat',
  count = 5,
): string {
  if (what === 'reply') {
    const reply = [...conversation.messages]
      .reverse()
      .find((m) => m.role === 'assistant' && m.status === 'complete');
    return reply ? replyText(reply) : '';
  }
  const messages = what === 'chat' ? conversation.messages : conversation.messages.slice(-count);
  return messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}:\n${replyText(m)}`)
    .join('\n\n');
}

/** A new run of a static workflow, starting at its Start step. */
export function staticRun(
  definitionId: string,
  definition: WorkflowDefinition,
  revision: number,
  inputs: Record<string, string>,
  driver: WorkflowRun['driver'],
  actor: WorkflowRun['createdBy'],
  now: number,
  // The trigger that fired and what it hands over; a manual run starts at the first manual one.
  trigger?: { nodeId: string; kind?: string; text?: string; payload?: unknown },
): WorkflowRun {
  const starts = definition.graph.nodes.filter((n) => n.type === 'start');
  const start =
    (trigger && starts.find((n) => n.id === trigger.nodeId)) ??
    starts.find((n) => triggerOf(n) === 'manual') ??
    starts[0];
  const at = iso(now);
  // Inputs of manual triggers keep their defaults whichever trigger started the run, so
  // {{input.NAME}} reads the same in every run; the trigger that fired comes first.
  const values: Record<string, string> = {};
  for (const node of [...(start ? [start] : []), ...starts.filter((n) => n !== start)])
    for (const input of nodeConfig(node, 'start').inputs)
      values[input.name] ??= inputs[input.name] ?? input.default;
  for (const [name, value] of Object.entries(inputs)) values[name] ??= value;
  return readRun({
    mode: 'static',
    title: definition.name,
    status: 'running',
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    createdBy: actor,
    driver,
    definition: { id: definitionId, revision, name: definition.name },
    ...(start
      ? {
          trigger: {
            nodeId: start.id,
            kind: trigger?.kind ?? triggerOf(start),
            text: trigger?.text ?? '',
            ...(trigger?.payload !== undefined ? { payload: trigger.payload } : {}),
          },
        }
      : {}),
    inputs: values,
    graph: structuredClone(definition.graph),
    activations: start
      ? [
          {
            id: crypto.randomUUID(),
            revision: 1,
            nodeId: start.id,
            scope: '',
            status: 'queued',
            attempts: 0,
            createdAt: at,
          },
        ]
      : [],
  })!;
}
