<script lang="ts">
  import { untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import { manageElicitation, openLink } from '$lib/transport';
  import {
    elicitationRequestSchema,
    formContent,
    type ElicitationReceipt,
    type ElicitationRequest,
    type ElicitationInput,
  } from '$lib/elicitations';
  import ChoicePicker from './ChoicePicker.svelte';
  let {
    receipt,
    runId,
    connectionId,
    running,
  }: { receipt: ElicitationReceipt; runId?: string; connectionId?: string; running: boolean } =
    $props();
  const values = new SvelteMap<string, unknown>();
  let request = $state<ElicitationRequest>();
  let busy = $state(false),
    loading = $state(false),
    sent = $state(false),
    opened = $state(false),
    error = $state('');
  let reload = $state(0);
  const active = $derived(
    running && receipt.status === 'pending' && receipt.runId === runId && !sent,
  );
  // Relay checkpoints replace receipt objects. Only a changed request or an
  // explicit retry should reload private input and clear the form's values.
  const requestIdentity = $derived(
    JSON.stringify([
      active,
      runId,
      connectionId,
      receipt.id,
      receipt.revision,
      receipt.mode,
      receipt.serverName,
      reload,
    ]),
  );
  $effect(() => {
    void requestIdentity;
    return untrack(() => {
      const id = receipt.id,
        run = runId,
        connection = connectionId,
        refresh = reload;
      let disposed = false;
      if (!active || !run) {
        request = undefined;
        values.clear();
        return;
      }
      loading = true;
      void (async () => {
        try {
          const result = elicitationRequestSchema.parse(
            await manageElicitation(run, { requestId: id }, connection),
          );
          if (disposed) return;
          if (
            result.id !== id ||
            result.runId !== run ||
            result.mode !== receipt.mode ||
            result.serverName !== receipt.serverName
          )
            throw new Error('This MCP request has changed.');
          request = result;
          if (!refresh)
            for (const field of result.fields)
              if (field.default != null) values.set(field.key, field.default);
          error = '';
        } catch {
          if (!disposed)
            error =
              'Could not load this MCP request. It may have ended, or its computer may be offline.';
        } finally {
          if (!disposed) loading = false;
        }
      })();
      return () => {
        disposed = true;
        request = undefined;
        values.clear();
      };
    });
  });
  async function send(action: ElicitationInput['action']) {
    if (!active || !runId || busy) return;
    const run = runId,
      id = receipt.id;
    error = '';
    try {
      const content =
        action === 'accept' && request?.mode === 'form'
          ? formContent(request.fields, values)
          : undefined;
      busy = true;
      await manageElicitation(
        run,
        { requestId: id, action, ...(content ? { content } : {}) },
        connectionId,
      );
      if (runId === run && receipt.id === id) {
        sent = true;
        values.clear();
        request = undefined;
      }
    } catch (e) {
      if (active && runId === run && receipt.id === id) error = String(e).replace(/^Error: /, '');
    } finally {
      busy = false;
    }
  }
  async function open() {
    if (!active || !request?.url) return;
    try {
      await openLink(request.url);
      opened = true;
      error = '';
    } catch {
      error = 'Could not open the page. Try again.';
    }
  }
</script>

{#if active}
  <section class="elicitation" aria-label="MCP request">
    <header><strong>{receipt.serverName}</strong><span>requests your input</span></header>
    {#if loading}<p role="status">Loading request…</p>
    {:else if request}
      <p class="request-message">{request.message}</p>
      {#if request.mode === 'url' && request.url}
        <p>Open this page to continue. The server verifies when the action is complete.</p>
        <p class="destination" title={request.url}>{request.url}</p>
        <button class="secondary" onclick={open} disabled={busy}>Open page</button>
      {:else}
        <p class="hint">
          Your answers will be sent to {receipt.serverName}. Do not enter passwords or other
          secrets.
        </p>
        <form
          onsubmit={(e) => {
            e.preventDefault();
            void send('accept');
          }}
        >
          {#each request.fields as field (field.key)}
            <fieldset disabled={busy}>
              <legend>{field.title}{field.required ? ' *' : ' (optional)'}</legend>
              {#if field.description}<p class="hint">{field.description}</p>{/if}
              {#if field.kind === 'array'}
                {#each field.options as option}
                  <label class="choice"
                    ><input
                      type="checkbox"
                      checked={(values.get(field.key) as string[] | undefined)?.includes(
                        option.value,
                      ) ?? false}
                      onchange={(e) => {
                        const old = (values.get(field.key) as string[] | undefined) ?? [];
                        values.set(
                          field.key,
                          e.currentTarget.checked
                            ? [...old, option.value]
                            : old.filter((v) => v !== option.value),
                        );
                      }}
                    />{option.label}</label
                  >
                {/each}
              {:else if field.kind === 'boolean'}
                <ChoicePicker
                  field
                  label={field.title}
                  options={[
                    { id: 'true', name: 'Yes' },
                    { id: 'false', name: 'No' },
                  ]}
                  value={values.has(field.key) ? String(values.get(field.key)) : ''}
                  placeholder="Choose an answer"
                  fallbackToFirst={false}
                  disabled={busy}
                  onchange={(v) => values.set(field.key, v === 'true')}
                />
              {:else if field.options.length}
                <ChoicePicker
                  field
                  label={field.title}
                  options={field.options.map((o) => ({ id: o.value, name: o.label }))}
                  value={String(values.get(field.key) ?? '')}
                  placeholder="Choose an answer"
                  fallbackToFirst={false}
                  disabled={busy}
                  onchange={(v) => values.set(field.key, v)}
                />
              {:else if field.kind === 'number' || field.kind === 'integer'}
                <input
                  aria-label={field.title}
                  type="number"
                  min={field.minimum ?? undefined}
                  max={field.maximum ?? undefined}
                  step={field.kind === 'integer' ? 1 : 'any'}
                  required={field.required}
                  value={String(values.get(field.key) ?? '')}
                  oninput={(e) => values.set(field.key, e.currentTarget.value)}
                />
              {:else}
                <input
                  aria-label={field.title}
                  type={field.format === 'email' ? 'email' : 'text'}
                  maxlength={4000}
                  value={String(values.get(field.key) ?? '')}
                  oninput={(e) => values.set(field.key, e.currentTarget.value)}
                  autocomplete="off"
                />
              {/if}
              {#if field.pattern}<p class="hint">
                  Required format: <code>{field.pattern}</code>
                </p>{/if}
              {#if !field.required && values.has(field.key)}<button
                  type="button"
                  class="text-button"
                  onclick={() => values.delete(field.key)}>Clear {field.title}</button
                >{/if}
            </fieldset>
          {/each}
          <button class="primary" type="submit" disabled={busy}
            >{busy ? 'Sending…' : 'Send answers'}</button
          >
        </form>
      {/if}
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="actions">
      {#if request?.mode === 'url'}<button
          class="primary"
          disabled={busy || !opened}
          onclick={() => send('accept')}>Continue</button
        >{/if}
      {#if !request && !loading}<button class="secondary" onclick={() => reload++}
          >Retry loading</button
        >{/if}
      <button class="secondary" disabled={busy} onclick={() => send('decline')}>Decline</button>
      <button class="secondary" disabled={busy} onclick={() => send('cancel')}>Cancel</button>
    </div>
  </section>
{:else}
  <p class="elicitation-receipt">
    {receipt.serverName} · MCP request {receipt.status === 'pending'
      ? sent
        ? 'response sent'
        : 'closed'
      : receipt.status}
  </p>
{/if}

<style>
  .elicitation {
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px;
    margin: 12px 0;
    max-width: 640px;
  }
  header,
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  header span,
  .hint,
  .elicitation-receipt {
    color: var(--muted);
    font-size: 12px;
  }
  p {
    margin: 8px 0;
  }
  .request-message {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .destination {
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  fieldset {
    min-width: 0;
    border: 0;
    padding: 0;
    margin: 14px 0;
  }
  legend {
    font-weight: 600;
    font-size: 13px;
  }
  input:not([type='checkbox']) {
    width: 100%;
    box-sizing: border-box;
  }
  .choice {
    display: flex;
    gap: 8px;
    padding: 5px 0;
    align-items: center;
  }
  .choice input {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
    margin: 0;
    accent-color: var(--green);
  }
  .actions {
    margin-top: 10px;
  }
  [role='alert'] {
    color: #f0a295;
    font-size: 12px;
  }
</style>
