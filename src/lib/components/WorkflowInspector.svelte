<script lang="ts">
  import { Plus, Trash2, X } from '@lucide/svelte';
  import ChoicePicker from './ChoicePicker.svelte';
  import WorkflowIcon from './WorkflowIcon.svelte';
  import {
    conditionOps,
    scheduleSchema,
    isNodeType,
    nodeCatalog,
    nodeConfig,
    nodeKeySchema,
    type NodeConfig,
    type NodeType,
    type Schedule,
    type WorkflowGraph,
    type WorkflowNode,
  } from '$lib/workflow-model';
  import { reasoningName } from '$lib/models';
  import { scheduleLabel } from '$lib/workflow-schedule';
  import type { WorkflowPickers } from '$lib/workflow-view';
  import type { Reasoning } from '$lib/domain';
  let {
    node,
    graph,
    pickers,
    change,
    remove,
    close,
  }: {
    node: WorkflowNode;
    graph: WorkflowGraph;
    pickers: WorkflowPickers;
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
    ...nodeConfig(
      graph.nodes.find((n) => n.type === 'start') ?? { type: 'start' },
      'start',
    ).inputs.map((input) => `input.${input.name}`),
    'previous.output',
    ...graph.nodes
      .filter((n) => n.id !== node.id && n.type !== 'start' && n.type !== 'end')
      .flatMap((n) => [
        `${n.key}.output`,
        ...(n.type === 'agent' || n.type === 'set' ? [`${n.key}.json`] : []),
      ]),
    'item',
    'index',
    'run.title',
    'now',
  ]);
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
  const provider = $derived((config.provider as 'claude' | 'codex' | 'gemini') ?? 'claude');
  const accounts = $derived(pickers.accounts(provider, environment));
  const models = $derived(pickers.models(provider, (config.connectionId as string) ?? ''));
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

{#snippet text(label: string, field: string, rows = 0, placeholder = '')}
  <label class="field"
    ><span>{label}</span>{#if rows}<textarea
        {rows}
        {placeholder}
        value={(config[field] as string) ?? ''}
        onfocus={track((value) => set(field, value))}
        oninput={(event) => set(field, event.currentTarget.value)}></textarea>{:else}<input
        {placeholder}
        value={(config[field] as string) ?? ''}
        onfocus={track((value) => set(field, value))}
        oninput={(event) => set(field, event.currentTarget.value)}
      />{/if}</label
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
        onchange={(value) =>
          change({
            ...node,
            config: { ...config, provider: value, connectionId: '', model: '', reasoning: '' },
          })}
      />
    </div>
    <div class="field">
      <span>Account</span>
      <ChoicePicker
        field
        label="Account"
        options={[{ id: '', name: 'Least used' }, ...accounts]}
        value={(config.connectionId as string) ?? ''}
        onchange={(value) => set('connectionId', value)}
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
        onchange={(value) =>
          change({ ...node, config: { ...config, model: value, reasoning: '' } })}
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
        onchange={(value) => set('reasoning', value)}
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
      <div class="pair">
        <input
          aria-label={keyLabel}
          placeholder={keyLabel}
          value={key}
          onchange={(event) => {
            const next = pairs(field).map(([k, v], i) =>
              i === index ? [event.currentTarget.value, v] : [k, v],
            );
            set(field, Object.fromEntries(next.filter(([k]) => k)));
          }}
        /><input
          aria-label="Value"
          placeholder="Value"
          {value}
          onfocus={track((text) =>
            set(field, { ...Object.fromEntries(pairs(field)), [key]: text }),
          )}
          oninput={(event) =>
            set(field, { ...Object.fromEntries(pairs(field)), [key]: event.currentTarget.value })}
        /><button
          type="button"
          class="icon-button"
          aria-label={`Remove ${key}`}
          onclick={() => set(field, Object.fromEntries(pairs(field).filter((_, i) => i !== index)))}
          ><X size={14} /></button
        >
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

<aside class="workflow-inspector" aria-label="Step settings">
  <header>
    <span class="inspector-icon"><WorkflowIcon type={node.type} size={15} /></span>
    <h2>{known ? nodeCatalog[type].label : node.type}</h2>
    {#if node.type !== 'start'}<button
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
      {#if config.json}{@render text('JSON Schema', 'schema', 4, '{"type": "object", …}')}{/if}
      {@render toggle('List the chat in Active', 'listed')}
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
    {:else if type === 'notify'}
      {@render text('Title', 'title')}
      {@render text('Text', 'text', 3)}
    {:else if type === 'set'}
      <fieldset class="list">
        <legend>Values</legend>
        {#each entries as entry, index (index)}
          <div class="pair">
            <input
              class="mono"
              aria-label="Name"
              value={entry.name}
              oninput={(event) =>
                set(
                  'values',
                  entries.map((e, i) =>
                    i === index ? { ...e, name: event.currentTarget.value.trim() } : e,
                  ),
                )}
            /><input
              aria-label="Value"
              value={entry.value}
              onfocus={track((value) =>
                set(
                  'values',
                  entries.map((e, i) => (i === index ? { ...e, value } : e)),
                ),
              )}
              oninput={(event) =>
                set(
                  'values',
                  entries.map((e, i) =>
                    i === index ? { ...e, value: event.currentTarget.value } : e,
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
      {@render pick('Workflow', 'workflowId', pickers.workflows())}
      {@render pairsEditor('Inputs', 'inputs', 'Input')}
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
        <div class="field-row">
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
            ><span>Seconds between</span><input
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
            class="value-chip"
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
    width: 360px;
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
  .field.compact {
    flex: 0 0 96px;
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
  @media (max-width: 900px) {
    .workflow-inspector {
      width: 100%;
    }
    .inspector-body {
      overflow: visible;
    }
  }
</style>
