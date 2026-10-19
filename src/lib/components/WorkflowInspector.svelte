<script lang="ts">
  import { Copy, Plus, RefreshCw, Trash2, X } from '@lucide/svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import TemplateField from './TemplateField.svelte';
  import WorkflowIcon from './WorkflowIcon.svelte';
  import {
    chatEvents,
    conditionOps,
    runEndings,
    scheduleSchema,
    isNodeType,
    nodeCatalog,
    nodeConfig,
    nodeKeySchema,
    triggerKinds,
    triggerLabels,
    triggerOf,
    webhookSecret,
    WORKFLOW_ACCOUNT,
    type NodeConfig,
    type TriggerKind,
    type NodeType,
    type Schedule,
    type WorkflowGraph,
    type WorkflowNode,
  } from '$lib/workflow-model';
  import { reasoningName } from '$lib/models';
  import { scheduleLabel } from '$lib/workflow-schedule';
  import { templateParts } from '$lib/workflow-templates';
  import { chatEventLabels, type WorkflowPickers } from '$lib/workflow-view';
  import type { ProviderId, Reasoning } from '$lib/domain';
  import { highestReasoning, rememberWorkflowAgent, workflowAgent } from '$lib/workflow-preferences';
  let {
    node,
    graph,
    pickers,
    webhookUrl,
    change,
    remove,
    close,
  }: {
    node: WorkflowNode;
    graph: WorkflowGraph;
    pickers: WorkflowPickers;
    /** A webhook trigger's address, when the relay runs webhooks. */
    webhookUrl?: (nodeId: string, secret: string) => string | undefined;
    change: (node: WorkflowNode) => void;
    remove: () => void;
    close: () => void;
  } = $props();
  const type = $derived(node.type as NodeType);
  const known = $derived(isNodeType(node.type));
  const config = $derived(known ? (nodeConfig(node, type) as Record<string, unknown>) : {});
  const set = (field: string, value: unknown) =>
    change({ ...node, config: { ...config, [field]: value } });
  const keyError = $derived(
    !nodeKeySchema.safeParse(node.key).success
      ? 'Use lowercase letters, digits and _'
      : graph.nodes.some((n) => n.id !== node.id && n.key === node.key)
        ? 'Another step has this key'
        : '',
  );
  const failing = $derived(nodeCatalog[type]?.ports.includes('error') ?? false);
  const steps = $derived(
    graph.nodes.filter((n) => n.id !== node.id && ['agent', 'screen'].includes(n.type)),
  );
  // The values this step's text can name.
  const values = $derived([
    ...new Set(
      graph.nodes
        .filter((n) => n.type === 'start')
        .flatMap((n) => nodeConfig(n, 'start').inputs.map((input) => `input.${input.name}`)),
    ),
    'trigger.output',
    'trigger.json',
    'previous.output',
    ...graph.nodes
      .filter((n) => n.id !== node.id && n.type !== 'start' && n.type !== 'end')
      .flatMap((n) => [
        `${n.key}.output`,
        ...(['agent', 'set', 'workflow'].includes(n.type) ? [`${n.key}.json`] : []),
        ...(n.type === 'workflow' ? [`${n.key}.run`] : []),
      ]),
    'item',
    'index',
    'run.title',
    'now',
  ]);
  // Whether a step has a key, for the values a text names.
  const hasKey = (key: string) => graph.nodes.some((n) => n.key === key);
  // What each value to insert names, for its colour.
  const valueKind = (path: string) => templateParts(`{{${path}}}`, hasKey)[0]?.kind ?? 'run';
  let focused: HTMLInputElement | HTMLTextAreaElement | undefined;
  let focusedField: ((text: string) => void) | undefined;
  function insert(path: string) {
    const element = focused;
    if (!element || !focusedField) return;
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    const text = `${element.value.slice(0, start)}{{${path}}}${element.value.slice(end)}`;
    focusedField(text);
    queueMicrotask(() => {
      element.focus();
      const at = start + path.length + 4;
      element.setSelectionRange(at, at);
    });
  }
  const track = (apply: (text: string) => void) => (event: FocusEvent) => {
    focused = event.currentTarget as HTMLInputElement | HTMLTextAreaElement;
    focusedField = apply;
  };
  // Choices.
  const providerChoices = [
    { id: 'claude', name: 'Claude' },
    { id: 'codex', name: 'Codex' },
    { id: 'gemini', name: 'Gemini' },
  ];
  const location = $derived(
    config.location as
      | { computerId: string; environmentId: string; executionEnvironmentId?: string; path: string }
      | undefined,
  );
  const environment = $derived(
    location ? (location.executionEnvironmentId ?? location.environmentId) : pickers.here,
  );
  const provider = $derived((config.provider as ProviderId) ?? 'claude');
  const accounts = $derived(pickers.accounts(provider, environment));
  // Following the workflow chat's account, the agent's own catalog lists the models.
  const models = $derived(
    pickers.models(
      provider,
      config.connectionId === WORKFLOW_ACCOUNT ? '' : ((config.connectionId as string) ?? ''),
    ),
  );
  const levels = $derived(
    models.find((m) => m.id === config.model)?.levels ?? ['low', 'medium', 'high'],
  );
  function chooseComputer(id: string) {
    if (id === '') {
      const { location: _, ...rest } = config;
      change({ ...node, config: { ...rest, connectionId: '' } });
      return;
    }
    const target = pickers.location(id);
    if (target)
      change({
        ...node,
        config: {
          ...config,
          location: { ...target, path: location?.path ?? '' },
          connectionId: '',
        },
      });
  }
  function setPath(path: string) {
    const target = location ?? pickers.location(pickers.here);
    if (target) set('location', { ...target, path });
  }
  const schedules = $derived((config.schedules as Schedule[] | undefined) ?? []);
  const trigger = $derived(type === 'start' ? triggerOf(node) : 'manual');
  const startConfig = $derived(type === 'start' ? nodeConfig(node, 'start') : undefined);
  const generic = new Set<string>(['', 'Start', 'Trigger', ...Object.values(triggerLabels)]);
  function chooseTrigger(kind: TriggerKind) {
    const next: Record<string, unknown> = { ...config, trigger: kind };
    if (kind === 'webhook' && !startConfig?.webhook.secret)
      next.webhook = { secret: webhookSecret() };
    if (kind === 'schedule' && !schedules.length)
      next.schedules = [
        scheduleSchema.parse({
          id: crypto.randomUUID().slice(0, 8),
          timezone,
          since: new Date().toISOString(),
        }),
      ];
    // A title still naming the kind follows the new one.
    change({
      ...node,
      title: generic.has(node.title) ? triggerLabels[kind] : node.title,
      config: next,
    });
  }
  /** Changes one setting of the kind this trigger is. */
  const setPart = (
    part: 'chat' | 'workflow' | 'computer' | 'usage' | 'webhook',
    patch: Record<string, unknown>,
  ) => set(part, { ...(startConfig?.[part] as Record<string, unknown>), ...patch });
  const toggleIn = <T extends string>(list: T[], item: T, on: boolean) =>
    on ? [...new Set([...list, item])] : list.filter((x) => x !== item);
  let copied = $state(false);
  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }
  // The agent chosen here is the one new steps start with.
  function chooseAgent(patch: Record<string, unknown>) {
    const next = { ...config, ...patch };
    change({ ...node, config: next });
    rememberWorkflowAgent({
      provider: next.provider as ProviderId,
      connectionId: (next.connectionId as string) ?? '',
      model: (next.model as string) ?? '',
      reasoning: (next.reasoning as Reasoning) ?? '',
    });
  }
  const inputs = $derived((config.inputs as NodeConfig<'start'>['inputs'] | undefined) ?? []);
  const entries = $derived((config.values as NodeConfig<'set'>['values'] | undefined) ?? []);
  const pairs = (field: string) => Object.entries((config[field] as Record<string, string>) ?? {});
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const opLabels: Record<string, string> = {
    contains: 'Contains',
    notContains: 'Does not contain',
    equals: 'Equals',
    notEquals: 'Does not equal',
    matches: 'Matches pattern',
    greater: 'Is greater than',
    less: 'Is less than',
    empty: 'Is empty',
    notEmpty: 'Is not empty',
    true: 'Is true',
  };
</script>

{#snippet text(label: string, field: string, rows = 0, placeholder = '', mono = false)}
  <label class="field"
    ><span>{label}</span><TemplateField
      {label}
      rows={Math.max(1, rows)}
      {placeholder}
      {mono}
      known={hasKey}
      value={(config[field] as string) ?? ''}
      onfocus={track((value) => set(field, value))}
      oninput={(value) => set(field, value)}
    /></label
  >
{/snippet}
{#snippet toggle(label: string, field: string)}
  <label class="checkbox"
    ><input
      type="checkbox"
      checked={!!config[field]}
      onchange={(event) => set(field, event.currentTarget.checked)}
    />{label}</label
  >
{/snippet}
{#snippet pick(label: string, field: string, options: { id: string; name: string }[])}
  <div class="field">
    <span>{label}</span>
    <ChoicePicker
      field
      {label}
      {options}
      value={String(config[field] ?? '')}
      onchange={(value) => set(field, value)}
    />
  </div>
{/snippet}
{#snippet agentFields()}
  <div class="field">
    <span>Computer</span>
    <ChoicePicker
      field
      label="Computer"
      options={[{ id: '', name: 'The computer that runs it' }, ...pickers.computers]}
      value={location ? environment : ''}
      onchange={chooseComputer}
    />
  </div>
  <label class="field"
    ><span>Folder</span><input
      list={`folders-${node.id}`}
      placeholder="Standalone"
      value={location?.path ?? ''}
      oninput={(event) => setPath(event.currentTarget.value)}
    /><datalist id={`folders-${node.id}`}
      >{#each pickers.folders(environment) as folder}<option value={folder}
        ></option>{/each}</datalist
    ></label
  >
  <div class="field-row">
    <div class="field">
      <span>Agent</span>
      <ChoicePicker
        field
        label="Agent"
        options={providerChoices}
        value={provider}
        onchange={(value) => {
          const remembered = workflowAgent(value as ProviderId);
          chooseAgent({
            provider: value,
            connectionId: '',
            model: remembered.model,
            reasoning: remembered.reasoning,
          });
        }}
      />
    </div>
    <div class="field">
      <span>Account</span>
      <ChoicePicker
        field
        label="Account"
        options={[
          { id: '', name: 'Least used' },
          { id: WORKFLOW_ACCOUNT, name: 'Same as workflow chat' },
          ...accounts,
        ]}
        value={(config.connectionId as string) ?? ''}
        onchange={(value) => chooseAgent({ connectionId: value })}
      />
    </div>
  </div>
  <div class="field-row">
    <div class="field">
      <span>Model</span>
      <ChoicePicker
        field
        label="Model"
        options={models.length ? models : [{ id: '', name: 'CLI default' }]}
        value={(config.model as string) ?? ''}
        onchange={(value) => {
          const listed = models.find((m) => m.id === value)?.levels ?? [];
          const reasoning = listed.includes(String(config.reasoning))
            ? config.reasoning
            : highestReasoning(listed);
          chooseAgent({ model: value, reasoning });
        }}
      />
    </div>
    <div class="field">
      <span>Reasoning</span>
      <ChoicePicker
        field
        label="Reasoning"
        options={['', ...levels].map((level) => ({
          id: level,
          name: reasoningName(level as Reasoning) ?? level,
        }))}
        value={(config.reasoning as string) ?? ''}
        onchange={(value) => chooseAgent({ reasoning: value })}
      />
    </div>
  </div>
{/snippet}
{#snippet target()}
  <div class="field-row">
    <div class="field">
      <span>Chat</span>
      <ChoicePicker
        field
        label="Chat"
        options={[
          { id: 'step', name: 'An earlier step’s chat' },
          { id: 'chat', name: 'A chat' },
        ]}
        value={(config.target as string) ?? 'step'}
        onchange={(value) => set('target', value)}
      />
    </div>
    {#if config.target === 'chat'}
      <div class="field">
        <span>Which</span>
        <ChoicePicker
          field
          label="Which chat"
          options={pickers.chats()}
          placeholder="Choose a chat"
          fallbackToFirst={false}
          value={(config.conversationId as string) ?? ''}
          onchange={(value) => set('conversationId', value)}
        />
      </div>
    {:else}
      <div class="field">
        <span>Step</span>
        <ChoicePicker
          field
          label="Step"
          options={steps.map((s) => ({ id: s.key, name: s.title || s.key }))}
          placeholder="Choose a step"
          fallbackToFirst={false}
          value={(config.step as string) ?? ''}
          onchange={(value) => set('step', value)}
        />
      </div>
    {/if}
  </div>
{/snippet}
{#snippet screenFields(withAction: boolean)}
  <div class="field">
    <span>Computer</span>
    <ChoicePicker
      field
      label="Computer"
      options={pickers.computers}
      placeholder="Choose a computer"
      fallbackToFirst={false}
      value={(config.environmentId as string) ?? ''}
      onchange={(value) =>
        change({ ...node, config: { ...config, environmentId: value, screenId: '' } })}
    />
  </div>
  <div class="field">
    <span>Screen</span>
    <ChoicePicker
      field
      label="Screen"
      options={pickers.screens((config.environmentId as string) ?? '')}
      placeholder="Choose a screen"
      fallbackToFirst={false}
      emptyMessage="No screens on this computer"
      value={(config.screenId as string) ?? ''}
      onchange={(value) => set('screenId', value)}
    />
  </div>
  {#if withAction}{@render text('Action', 'action', 0, 'action_name')}{/if}
{/snippet}
{#snippet pairsEditor(label: string, field: string, keyLabel: string)}
  <fieldset class="list">
    <legend>{label}</legend>
    {#each pairs(field) as [key, value], index (index)}
      <div class="entry">
        <div class="entry-head">
          <input
            class="mono"
            aria-label={keyLabel}
            placeholder={keyLabel}
            value={key}
            onchange={(event) => {
              const next = pairs(field).map(([k, v], i) =>
                i === index ? [event.currentTarget.value, v] : [k, v],
              );
              set(field, Object.fromEntries(next.filter(([k]) => k)));
            }}
          /><button
            type="button"
            class="icon-button"
            aria-label={`Remove ${key}`}
            onclick={() =>
              set(field, Object.fromEntries(pairs(field).filter((_, i) => i !== index)))}
            ><X size={14} /></button
          >
        </div>
        <TemplateField
          label={`Value of ${key}`}
          placeholder="Value"
          known={hasKey}
          {value}
          onfocus={track((text) =>
            set(field, { ...Object.fromEntries(pairs(field)), [key]: text }),
          )}
          oninput={(text) => set(field, { ...Object.fromEntries(pairs(field)), [key]: text })}
        />
      </div>
    {/each}
    <button
      type="button"
      class="text-button"
      onclick={() => {
        let name = 'name';
        for (let n = 2; pairs(field).some(([k]) => k === name); n++) name = `name${n}`;
        set(field, { ...Object.fromEntries(pairs(field)), [name]: '' });
      }}><Plus size={14} />Add</button
    >
  </fieldset>
{/snippet}

<aside id="workflow-side" class="workflow-inspector" aria-label="Step settings">
  <header>
    <span class="inspector-icon"
      ><WorkflowIcon type={node.type === 'start' ? `trigger:${trigger}` : node.type} size={15} /></span
    >
    <h2>
      {known
        ? type === 'start'
          ? `${triggerLabels[trigger]} trigger`
          : nodeCatalog[type].label
        : node.type}
    </h2>
    {#if node.type !== 'start' || graph.nodes.filter((n) => n.type === 'start').length > 1}<button
        class="icon-button"
        title="Delete step"
        aria-label="Delete this step"
        onclick={remove}><Trash2 size={15} /></button
      >{/if}
    <button class="icon-button" aria-label="Close step settings" onclick={close}
      ><X size={16} /></button
    >
  </header>
  <div class="inspector-body">
    <div class="field-row">
      <label class="field"
        ><span>Title</span><input
          value={node.title}
          oninput={(event) => change({ ...node, title: event.currentTarget.value })}
        /></label
      >
      <label class="field"
        ><span>Key</span><input
          class="mono"
          value={node.key}
          aria-invalid={keyError ? 'true' : undefined}
          title={keyError || undefined}
          oninput={(event) => change({ ...node, key: event.currentTarget.value.trim() })}
        /></label
      >
    </div>
    {#if !known}
      <p class="inspector-note">This release cannot edit {node.type} steps.</p>
    {:else if type === 'start'}
      <div class="field">
        <span>Starts when</span>
        <ChoicePicker
          field
          label="Trigger"
          options={triggerKinds.map((kind) => ({ id: kind, name: triggerLabels[kind] }))}
          value={trigger}
          onchange={(value) => chooseTrigger(value as TriggerKind)}
        >
          {#snippet icon()}<WorkflowIcon type={`trigger:${trigger}`} size={15} />{/snippet}
          {#snippet optionIcon(option)}<WorkflowIcon
              type={`trigger:${option.id}`}
              size={15}
            />{/snippet}
        </ChoicePicker>
      </div>
      {#if trigger === 'chat' && startConfig}
        {@const chat = startConfig.chat}
        <fieldset class="list">
          <legend>In a chat</legend>
          {#each chatEvents as event (event)}<label class="checkbox"
              ><input
                type="checkbox"
                checked={chat.events.includes(event)}
                onchange={(e) =>
                  setPart('chat', { events: toggleIn(chat.events, event, e.currentTarget.checked) })}
              />{chatEventLabels[event]}</label
            >{/each}
        </fieldset>
        <div class="field-row">
          <div class="field">
            <span>Computer</span>
            <ChoicePicker
              field
              label="Computer"
              options={[{ id: '', name: 'Any computer' }, ...pickers.computers]}
              value={chat.environmentId}
              onchange={(value) => setPart('chat', { environmentId: value })}
            />
          </div>
          <div class="field">
            <span>Agent</span>
            <ChoicePicker
              field
              label="Agent"
              options={[{ id: '', name: 'Any agent' }, ...providerChoices]}
              value={chat.provider}
              onchange={(value) => setPart('chat', { provider: value })}
            />
          </div>
        </div>
        <label class="field"
          ><span>Folder</span><input
            list={`trigger-folders-${node.id}`}
            placeholder="Any folder"
            value={chat.path}
            oninput={(event) => setPart('chat', { path: event.currentTarget.value })}
          /><datalist id={`trigger-folders-${node.id}`}
            >{#each pickers.folders(chat.environmentId || pickers.here) as folder}<option
                value={folder}
              ></option>{/each}</datalist
          ></label
        >
        <label class="field"
          ><span>Title contains</span><input
            placeholder="Any title"
            value={chat.title}
            oninput={(event) => setPart('chat', { title: event.currentTarget.value })}
          /></label
        >
        <label class="checkbox"
          ><input
            type="checkbox"
            checked={chat.workflowChats}
            onchange={(event) => setPart('chat', { workflowChats: event.currentTarget.checked })}
          />Include chats workflows start</label
        >
      {:else if trigger === 'workflow' && startConfig}
        {@const watched = startConfig.workflow}
        <div class="field">
          <span>Workflow</span>
          <ChoicePicker
            field
            label="Workflow"
            options={[{ id: '', name: 'Any other workflow' }, ...pickers.workflows()]}
            value={watched.workflowId}
            onchange={(value) => setPart('workflow', { workflowId: value })}
          />
        </div>
        <fieldset class="list">
          <legend>When its run</legend>
          {#each runEndings as ending (ending)}<label class="checkbox"
              ><input
                type="checkbox"
                checked={watched.statuses.includes(ending)}
                onchange={(e) =>
                  setPart('workflow', {
                    statuses: toggleIn(watched.statuses, ending, e.currentTarget.checked),
                  })}
              />{ending === 'completed'
                ? 'Completes'
                : ending === 'failed'
                  ? 'Fails'
                  : 'Is stopped'}</label
            >{/each}
        </fieldset>
      {:else if trigger === 'webhook' && startConfig}
        {@const url = webhookUrl?.(node.id, startConfig.webhook.secret)}
        <div class="field">
          <span>URL</span>
          {#if url}
            <div class="webhook">
              <code title={url}>{url}</code>
              <button
                type="button"
                class="icon-button"
                aria-label="Copy the webhook URL"
                title={copied ? 'Copied' : 'Copy'}
                onclick={() => void copyUrl(url)}><Copy size={14} /></button
              >
              <button
                type="button"
                class="icon-button"
                aria-label="Make a new URL"
                title="New URL"
                onclick={() => setPart('webhook', { secret: webhookSecret() })}
                ><RefreshCw size={14} /></button
              >
            </div>
            <p class="inspector-note">A POST starts a run with its body as {'{{trigger.json}}'}.</p>
          {:else}<p class="inspector-note">Webhooks need the relay to be updated.</p>{/if}
        </div>
      {:else if trigger === 'computer' && startConfig}
        {@const watched = startConfig.computer}
        <div class="field-row">
          <div class="field">
            <span>Computer</span>
            <ChoicePicker
              field
              label="Computer"
              options={[{ id: '', name: 'Any computer' }, ...pickers.computers]}
              value={watched.environmentId}
              onchange={(value) => setPart('computer', { environmentId: value })}
            />
          </div>
          <div class="field">
            <span>Goes</span>
            <ChoicePicker
              field
              label="Goes"
              options={[
                { id: 'online', name: 'Online' },
                { id: 'offline', name: 'Offline' },
              ]}
              value={watched.event}
              onchange={(value) => setPart('computer', { event: value })}
            />
          </div>
        </div>
      {:else if trigger === 'usage' && startConfig}
        {@const watched = startConfig.usage}
        <div class="field">
          <span>Account</span>
          <ChoicePicker
            field
            label="Account"
            options={[
              { id: '', name: 'Any account' },
              ...pickers.computers.flatMap((computer) =>
                providerChoices.flatMap((p) =>
                  pickers.accounts(p.id as ProviderId, computer.id).map((a) => ({
                    id: a.id,
                    name: a.name,
                    detail: `${p.name} · ${computer.name}`,
                  })),
                ),
              ),
            ]}
            value={watched.connectionId}
            onchange={(value) => setPart('usage', { connectionId: value })}
          />
        </div>
      {/if}
      {#if trigger === 'manual'}
      <fieldset class="list">
        <legend>Inputs</legend>
        {#each inputs as input, index (index)}
          <div class="pair">
            <input
              class="mono"
              aria-label="Name"
              placeholder="name"
              value={input.name}
              oninput={(event) =>
                set(
                  'inputs',
                  inputs.map((x, i) =>
                    i === index ? { ...x, name: event.currentTarget.value.trim() } : x,
                  ),
                )}
            /><input
              aria-label="Default"
              placeholder="Default"
              value={input.default}
              oninput={(event) =>
                set(
                  'inputs',
                  inputs.map((x, i) =>
                    i === index ? { ...x, default: event.currentTarget.value } : x,
                  ),
                )}
            /><button
              type="button"
              class="icon-button"
              aria-label={`Remove ${input.name}`}
              onclick={() =>
                set(
                  'inputs',
                  inputs.filter((_, i) => i !== index),
                )}><X size={14} /></button
            >
          </div>
        {/each}
        <button
          type="button"
          class="text-button"
          onclick={() =>
            set('inputs', [
              ...inputs,
              { name: `input${inputs.length + 1}`, label: '', default: '', multiline: false },
            ])}><Plus size={14} />Add input</button
        >
      </fieldset>
      {/if}
      {#if trigger === 'schedule'}
      <fieldset class="list">
        <legend>Schedules</legend>
        {#each schedules as schedule, index (schedule.id)}
          {@const update = (patch: Partial<Schedule>) =>
            set(
              'schedules',
              schedules.map((s, i) => (i === index ? { ...s, ...patch } : s)),
            )}
          <div class="schedule">
            <div class="field-row">
              <input
                type="number"
                min="1"
                aria-label="Every"
                value={schedule.interval}
                oninput={(event) =>
                  update({ interval: Math.max(1, Number(event.currentTarget.value) || 1) })}
              />
              <ChoicePicker
                field
                label="Unit"
                options={[
                  { id: 'minutes', name: 'Minutes' },
                  { id: 'hours', name: 'Hours' },
                  { id: 'days', name: 'Days' },
                  { id: 'weeks', name: 'Weeks' },
                ]}
                value={schedule.every}
                onchange={(value) => update({ every: value as Schedule['every'] })}
              />
              {#if schedule.every === 'days' || schedule.every === 'weeks'}<input
                  type="time"
                  aria-label="At"
                  value={schedule.at}
                  oninput={(event) => update({ at: event.currentTarget.value || '09:00' })}
                />{/if}
              <button
                type="button"
                class="icon-button"
                aria-label="Remove schedule"
                onclick={() =>
                  set(
                    'schedules',
                    schedules.filter((_, i) => i !== index),
                  )}><X size={14} /></button
              >
            </div>
            {#if schedule.every === 'weeks'}
              <div class="days" role="group" aria-label="Days">
                {#each days as day, number}
                  <label class="day"
                    ><input
                      type="checkbox"
                      checked={schedule.days.includes(number)}
                      onchange={(event) =>
                        update({
                          days: event.currentTarget.checked
                            ? [...schedule.days, number].sort()
                            : schedule.days.filter((d) => d !== number),
                        })}
                    />{day}</label
                  >
                {/each}
              </div>
            {/if}
            <p class="inspector-note">{scheduleLabel(schedule)} · {schedule.timezone}</p>
          </div>
        {/each}
        <button
          type="button"
          class="text-button"
          onclick={() =>
            set('schedules', [
              ...schedules,
              scheduleSchema.parse({
                id: crypto.randomUUID().slice(0, 8),
                timezone,
                since: new Date().toISOString(),
              }),
            ])}><Plus size={14} />Add schedule</button
        >
      </fieldset>
      {/if}
    {:else if type === 'agent'}
      {@render agentFields()}
      {@render text('Prompt', 'prompt', 6, 'What the agent should do')}
      {@render text('Chat title', 'title')}
      <div class="field">
        <span>When it runs again</span>
        <ChoicePicker
          field
          label="When it runs again"
          options={[
            { id: 'continue', name: 'Continue its chat' },
            { id: 'new', name: 'Start a new chat' },
          ]}
          value={(config.chat as string) ?? 'continue'}
          onchange={(value) => set('chat', value)}
        />
      </div>
      {@render toggle('Reply with JSON', 'json')}
      {#if config.json}{@render text('JSON Schema', 'schema', 4, '{"type": "object", …}', true)}{/if}
      {@render text('Chat instructions', 'instructions', 3)}
    {:else if type === 'screen'}
      {@render agentFields()}
      {@render text('Screen title', 'screenTitle')}
      {@render text('What it shows and does', 'spec', 6)}
      {@render text('Screen to update', 'screenId', 0, 'A screen id, or empty for a new one')}
    {:else if type === 'message'}
      {@render target()}
      {@render text('Message', 'text', 5)}
      {@render pick('Send as', 'mode', [
        { id: 'next', name: 'Its next message' },
        { id: 'steer', name: 'A steer of its reply' },
      ])}
      {@render toggle('Wait for its reply', 'wait')}
    {:else if type === 'read'}
      {@render target()}
      {@render pick('Read', 'what', [
        { id: 'reply', name: 'Latest reply' },
        { id: 'messages', name: 'Last messages' },
        { id: 'chat', name: 'Whole chat' },
      ])}
      {#if config.what === 'messages'}<label class="field"
          ><span>Messages</span><input
            type="number"
            min="1"
            value={config.count as number}
            oninput={(event) => set('count', Math.max(1, Number(event.currentTarget.value) || 1))}
          /></label
        >{/if}
    {:else if type === 'condition'}
      {@render text('Value', 'left', 2, '{{review.output}}')}
      {@render pick(
        'Test',
        'op',
        conditionOps.map((op) => ({ id: op, name: opLabels[op] })),
      )}
      {#if !['empty', 'notEmpty', 'true'].includes(String(config.op))}{@render text(
          'Compared with',
          'right',
          2,
        )}{/if}
      {@render toggle('Ignore case', 'ignoreCase')}
    {:else if type === 'loop'}
      {@render text('Items', 'items', 3, '{{list.json.items}}, or one item per line')}
      {@render toggle('Run all items at once', 'parallel')}
    {:else if type === 'wait'}
      {@render pick('Wait', 'mode', [
        { id: 'for', name: 'For a time' },
        { id: 'until', name: 'Until a time' },
      ])}
      {#if config.mode === 'until'}{@render text('Until', 'until', 0, '14:30, or a date and time')}
      {:else}
        <div class="field-row">
          <input
            type="number"
            min="0"
            aria-label="Amount"
            value={config.amount as number}
            oninput={(event) => set('amount', Math.max(0, Number(event.currentTarget.value) || 0))}
          />
          <ChoicePicker
            field
            label="Unit"
            options={[
              { id: 'seconds', name: 'Seconds' },
              { id: 'minutes', name: 'Minutes' },
              { id: 'hours', name: 'Hours' },
              { id: 'days', name: 'Days' },
            ]}
            value={(config.unit as string) ?? 'minutes'}
            onchange={(value) => set('unit', value)}
          />
        </div>
      {/if}
    {:else if type === 'ask'}
      {@render text('Heading', 'header')}
      {@render text('Question', 'question', 3)}
      <label class="field"
        ><span>Choices</span><textarea
          rows="3"
          placeholder="One per line"
          value={((config.choices as string[]) ?? []).join('\n')}
          oninput={(event) => set('choices', event.currentTarget.value.split('\n'))}
        ></textarea></label
      >
      {@render toggle('Allow several', 'multiple')}
    {:else if type === 'confirm'}
      {@render text('Heading', 'header')}
      {@render text('What to confirm', 'question', 3)}
      <div class="field-row">
        {@render text('Approve button', 'approve')}
        {@render text('Reject button', 'reject')}
      </div>
    {:else if type === 'notify'}
      {@render text('Title', 'title')}
      {@render text('Text', 'text', 3)}
    {:else if type === 'set'}
      <fieldset class="list">
        <legend>Values</legend>
        {#each entries as entry, index (index)}
          <div class="entry">
            <div class="entry-head">
              <input
                class="mono"
                aria-label="Name"
                placeholder="name"
                value={entry.name}
                oninput={(event) =>
                  set(
                    'values',
                    entries.map((e, i) =>
                      i === index ? { ...e, name: event.currentTarget.value.trim() } : e,
                    ),
                  )}
              /><label class="checkbox" title="Parse as JSON"
                ><input
                  type="checkbox"
                  checked={entry.json}
                  onchange={(event) =>
                    set(
                      'values',
                      entries.map((e, i) =>
                        i === index ? { ...e, json: event.currentTarget.checked } : e,
                      ),
                    )}
                />JSON</label
              ><button
                type="button"
                class="icon-button"
                aria-label={`Remove ${entry.name}`}
                onclick={() =>
                  set(
                    'values',
                    entries.filter((_, i) => i !== index),
                  )}><X size={14} /></button
              >
            </div>
            <TemplateField
              label={`Value of ${entry.name}`}
              rows={2}
              placeholder={entry.json ? '{"key": "{{previous.output}}"}' : '{{previous.output}}'}
              mono={entry.json}
              known={hasKey}
              value={entry.value}
              onfocus={track((value) =>
                set(
                  'values',
                  entries.map((e, i) => (i === index ? { ...e, value } : e)),
                ),
              )}
              oninput={(value) =>
                set(
                  'values',
                  entries.map((e, i) => (i === index ? { ...e, value } : e)),
                )}
            />
          </div>
        {/each}
        <button
          type="button"
          class="text-button"
          onclick={() =>
            set('values', [
              ...entries,
              { name: `value${entries.length + 1}`, value: '', json: false },
            ])}><Plus size={14} />Add value</button
        >
      </fieldset>
    {:else if type === 'screenAction'}
      {@render screenFields(true)}
      {@render pairsEditor('Parameters', 'params', 'Name')}
    {:else if type === 'screenData'}
      {@render screenFields(false)}
      {@render pick('Do', 'op', [
        { id: 'load', name: 'Load a value' },
        { id: 'save', name: 'Save a value' },
      ])}
      {@render text('Key', 'key')}
      {#if config.op === 'save'}{@render text('Value', 'value', 3)}{@render toggle(
          'Parse as JSON',
          'json',
        )}{/if}
    {:else if type === 'workflow'}
      {@render pick('Runs', 'kind', [
        { id: 'static', name: 'A saved workflow' },
        { id: 'dynamic', name: 'A dynamic workflow' },
      ])}
      {#if config.kind === 'dynamic'}
        {@render text('Goal', 'goal', 5, 'What it should achieve')}
        {@render text('Title', 'title', 0, 'From its goal')}
        <fieldset class="list">
          <legend>Orchestrator</legend>
          {@render agentFields()}
        </fieldset>
      {:else}
        {@render pick('Workflow', 'workflowId', pickers.workflows())}
        {@render pairsEditor('Inputs', 'inputs', 'Input')}
      {/if}
      {@render toggle('Wait for it to end', 'wait')}
    {:else if type === 'end'}
      {@render text('Output', 'output', 4, '{{report.output}}')}
      {@render pick('Ends as', 'status', [
        { id: 'completed', name: 'Completed' },
        { id: 'failed', name: 'Failed' },
      ])}
    {/if}
    {#if failing}
      <fieldset class="list">
        <legend>If it fails</legend>
        <div class="failure-row">
          <ChoicePicker
            field
            label="If it fails"
            options={[
              { id: 'stop', name: 'Stop the workflow' },
              { id: 'continue', name: 'Continue' },
            ]}
            value={node.onError}
            onchange={(value) => change({ ...node, onError: value as 'stop' | 'continue' })}
          />
          <label class="field compact"
            ><span>Retries</span><input
              type="number"
              min="0"
              value={node.retries}
              oninput={(event) =>
                change({
                  ...node,
                  retries: Math.max(0, Math.floor(Number(event.currentTarget.value) || 0)),
                })}
            /></label
          >
          <label class="field compact"
            ><span>Wait (s)</span><input
              type="number"
              min="0"
              value={node.retryDelay}
              oninput={(event) =>
                change({
                  ...node,
                  retryDelay: Math.max(0, Number(event.currentTarget.value) || 0),
                })}
            /></label
          >
        </div>
      </fieldset>
    {/if}
    {#if known && type !== 'start'}
      <div class="values" aria-label="Values to insert">
        {#each values as value (value)}<button
            type="button"
            class="value-chip chip-{valueKind(value)}"
            onmousedown={(event) => event.preventDefault()}
            onclick={() => insert(value)}>{`{{${value}}}`}</button
          >{/each}
      </div>
    {/if}
  </div>
</aside>

<style>
  .workflow-inspector {
    display: flex;
    flex-direction: column;
    /* Wider when the graph has the room, for the values steps write; the gap beside it resizes it. */
    width: var(--workflow-side-width, clamp(360px, 36%, 480px));
    flex-shrink: 0;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--surface-1);
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 10px 10px 14px;
    border-bottom: 1px solid var(--border);
  }
  header h2 {
    flex: 1;
    margin: 0;
    font-size: var(--text-md);
  }
  .inspector-icon {
    display: inline-flex;
    color: var(--accent-text);
  }
  .inspector-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 14px;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    min-height: 0;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
    flex: 1;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .field > span {
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .failure-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 76px 76px;
    align-items: end;
    gap: 8px;
  }
  .failure-row input {
    width: 100%;
  }
  .field-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    min-width: 0;
  }
  .field-row > :global(*) {
    min-width: 0;
  }
  .mono {
    font-family: var(--font-mono);
  }
  fieldset.list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    /* A fieldset is as wide as its content by default, which scrolled the panel sideways. */
    min-width: 0;
    margin: 0;
    padding: 10px 12px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
  }
  legend {
    padding: 0 4px;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .pair {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* A named value: its name on one line, its value below it with the whole width. */
  .entry {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
  }
  .entry-head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .entry-head input:not([type]) {
    flex: 1;
    min-width: 0;
  }
  .entry-head .checkbox {
    flex-shrink: 0;
    font-size: var(--text-xs);
  }
  .pair :global(.checkbox) {
    flex-shrink: 0;
    font-size: var(--text-xs);
    gap: 6px;
  }
  .schedule {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .days {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .day {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    cursor: pointer;
  }
  .day input {
    margin: 0;
  }
  .text-button {
    align-self: flex-start;
    font-size: var(--text-sm);
  }
  .webhook {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .webhook code {
    flex: 1;
    min-width: 0;
    padding: 6px 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2);
    font-size: var(--text-xs);
  }
  .checkbox {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .inspector-note {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .values {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .value-chip {
    padding: 2px 7px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
  }
  .value-chip:hover {
    background: var(--hover);
  }
  .chip-input {
    color: var(--syntax-string);
  }
  .chip-trigger {
    color: var(--syntax-number);
  }
  .chip-previous {
    color: var(--syntax-type);
  }
  .chip-step {
    color: var(--syntax-title);
  }
  .chip-loop {
    color: var(--syntax-keyword);
  }
  @media (max-width: 900px) {
    .workflow-inspector {
      width: 100%;
    }
    .inspector-body {
      overflow: visible;
    }
  }
</style>
