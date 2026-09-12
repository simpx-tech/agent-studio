<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { ArrowLeft, FileText, Pencil, Plus, Trash2, X } from '@lucide/svelte';
  import {
    appendTemplateInput,
    inputTemplateSchema,
    maxInputLength,
    maxInputTemplates,
    renderInputTemplate,
    templateFields,
    type InputTemplate,
  } from '$lib/input-templates';

  let {
    templates,
    draft,
    close,
    save,
    remove,
    insert,
  }: {
    templates: InputTemplate[];
    draft: string;
    close: () => void;
    save: (template: InputTemplate, previous?: InputTemplate) => Promise<void>;
    remove: (template: InputTemplate) => Promise<void>;
    insert: (text: string) => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let bodyInput = $state<HTMLTextAreaElement>();
  let mode = $state<'library' | 'edit' | 'fill'>('library');
  let selected = $state<InputTemplate>();
  let name = $state('');
  let body = $state('');
  let values = $state<Record<string, string>>({});
  let query = $state('');
  let error = $state('');
  let busy = $state(false);
  let deleting = $state<InputTemplate>();
  const visible = $derived(
    templates.filter((t) => t.name.toLowerCase().includes(query.toLowerCase())),
  );
  const fieldInfo = $derived.by(() => {
    try {
      return { names: templateFields(body), error: '' };
    } catch (error) {
      return { names: [], error: (error as Error).message };
    }
  });
  const rendered = $derived.by(() => {
    try {
      return { text: fieldInfo.error ? '' : renderInputTemplate(body, values), error: '' };
    } catch (error) {
      return { text: '', error: (error as Error).message };
    }
  });
  const preview = $derived.by(() => {
    if (rendered.error) return rendered;
    try {
      return { text: appendTemplateInput(draft, rendered.text), error: '' };
    } catch (error) {
      return { text: '', error: (error as Error).message };
    }
  });
  const missing = $derived(
    fieldInfo.names.some((field) => !Object.hasOwn(values, field) || !values[field].trim()),
  );

  onMount(() => {
    dialog.showModal();
  });

  async function focusFirst() {
    await tick();
    dialog
      .querySelector<HTMLElement>(
        '.template-body input, .template-body textarea, .template-body button',
      )
      ?.focus();
  }
  function library() {
    mode = 'library';
    selected = undefined;
    values = {};
    error = '';
    deleting = undefined;
    void focusFirst();
  }
  function edit(template?: InputTemplate) {
    selected = template ? { ...template } : undefined;
    name = template?.name ?? '';
    body = template?.body ?? '';
    values = {};
    error = '';
    deleting = undefined;
    mode = 'edit';
    void focusFirst();
  }
  function fill(template: InputTemplate) {
    selected = { ...template };
    body = template.body;
    values = {};
    error = '';
    deleting = undefined;
    mode = 'fill';
    void focusFirst();
  }
  async function saveTemplate() {
    if (busy) return;
    const parsed = inputTemplateSchema.safeParse({
      id: selected?.id ?? crypto.randomUUID(),
      name,
      body,
    });
    if (!parsed.success) {
      error = parsed.error.issues[0].message;
      return;
    }
    busy = true;
    error = '';
    try {
      await save(parsed.data, selected);
      query = '';
      library();
    } catch (failure) {
      error = (failure as Error).message;
    } finally {
      busy = false;
    }
  }
  async function deleteTemplate() {
    if (!deleting || busy) return;
    busy = true;
    error = '';
    try {
      await remove(deleting);
      library();
    } catch (failure) {
      error = (failure as Error).message;
    } finally {
      busy = false;
    }
  }
  async function addField() {
    if (!bodyInput) return;
    const start = bodyInput.selectionStart,
      end = bodyInput.selectionEnd;
    let index = 1;
    while (fieldInfo.names.includes(`input ${index}`)) index++;
    const field = `input ${index}`;
    const next = body.slice(0, start) + `{{${field}}}` + body.slice(end);
    if (next.length > maxInputLength) {
      error = 'Template text exceeds 30,000 characters.';
      return;
    }
    body = next;
    await tick();
    bodyInput.focus();
    bodyInput.setSelectionRange(start + 2, start + 2 + field.length);
  }
  function confirm() {
    if (missing || preview.error || fieldInfo.error) return;
    try {
      insert(rendered.text);
    } catch (failure) {
      error = (failure as Error).message;
    }
  }
</script>

<dialog
  class="modal template-modal"
  bind:this={dialog}
  aria-labelledby="templates-title"
  oncancel={(event) => {
    event.preventDefault();
    if (!busy) close();
  }}
>
  <header>
    <div class="template-heading">
      {#if mode !== 'library'}<button
          type="button"
          class="icon-button"
          disabled={busy}
          onclick={library}
          aria-label="Back to templates"><ArrowLeft size={18} /></button
        >{/if}
      <h2 id="templates-title">
        {mode === 'library'
          ? 'Input templates'
          : mode === 'edit'
            ? selected
              ? 'Edit template'
              : 'New template'
            : selected?.name}
      </h2>
    </div>
    <button
      type="button"
      class="icon-button"
      disabled={busy}
      onclick={close}
      aria-label="Close input templates"><X size={20} /></button
    >
  </header>

  {#if mode === 'library'}
    <div class="template-body">
      <p class="intro">Reusable prompts with inputs you fill in each time.</p>
      {#if templates.length}
        <label
          >Find a template<input
            type="search"
            bind:value={query}
            placeholder="Search templates"
          /></label
        >
        <div class="template-list">
          {#each visible as template (template.id)}
            <div class="template-row">
              <button
                type="button"
                class="template-use"
                disabled={busy}
                onclick={() => fill(template)}
                aria-label={`Use ${template.name}`}
              >
                <FileText size={18} aria-hidden="true" />
                <span
                  ><strong>{template.name}</strong><small
                    >{templateFields(template.body).length} inputs</small
                  ></span
                >
              </button>
              <button
                type="button"
                class="icon-button"
                disabled={busy}
                onclick={() => edit(template)}
                aria-label={`Edit ${template.name}`}><Pencil size={16} /></button
              >
              <button
                type="button"
                class="icon-button"
                disabled={busy}
                onclick={() => {
                  deleting = { ...template };
                  error = '';
                }}
                aria-label={`Delete ${template.name}`}><Trash2 size={16} /></button
              >
            </div>
          {/each}
          {#if !visible.length}<p class="intro">No templates match your search.</p>{/if}
        </div>
      {:else}
        <div class="template-empty">
          <FileText size={28} />
          <p>No templates yet</p>
          <span>Create a prompt and add named inputs wherever you need them.</span>
        </div>
      {/if}
      {#if deleting}
        <div class="template-delete" role="group" aria-label="Confirm template deletion">
          <p>Delete “{deleting.name}”?</p>
          <div class="template-actions">
            <button
              type="button"
              class="secondary"
              disabled={busy}
              onclick={() => (deleting = undefined)}>Cancel deletion</button
            ><button type="button" class="danger" disabled={busy} onclick={deleteTemplate}
              >{busy ? 'Deleting…' : 'Delete template'}</button
            >
          </div>
        </div>
      {/if}
      {#if error}<p role="alert" class="template-error">{error}</p>{/if}
    </div>
    <footer>
      <button type="button" class="secondary" disabled={busy} onclick={close}>Close</button>
      <button
        type="button"
        class="primary"
        disabled={busy || templates.length >= maxInputTemplates}
        onclick={() => edit()}><Plus size={16} />New template</button
      >
    </footer>
  {:else if mode === 'edit'}
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void saveTemplate();
      }}
    >
      <div class="template-body">
        <label
          >Template name<input
            bind:value={name}
            maxlength="80"
            required
            placeholder="e.g. Review a change"
            disabled={busy}
          /></label
        >
        <label
          >Template text<textarea
            bind:this={bodyInput}
            bind:value={body}
            rows="8"
            maxlength={maxInputLength}
            required
            disabled={busy}
            placeholder={'Review {{change}}. Focus on {{areas to check}}.'}></textarea></label
        >
        <div class="template-actions">
          <button
            type="button"
            class="secondary"
            disabled={busy || fieldInfo.names.length >= 20}
            onclick={addField}><Plus size={14} />Add input field</button
          >
        </div>
        <p class="intro">
          Use {'{{field name}}'} for each custom input. Repeating a name uses the same value. Up to 20
          inputs; plain prompts work too.
        </p>
        {#if fieldInfo.error}<p class="template-error" role="alert">{fieldInfo.error}</p>
        {:else if fieldInfo.names.length}<div class="template-fields" aria-label="Template inputs">
            {#each fieldInfo.names as field}<span>{field}</span>{/each}
          </div>{/if}
        {#if error}<p role="alert" class="template-error">{error}</p>{/if}
      </div>
      <footer>
        <button type="button" class="secondary" disabled={busy} onclick={library}>Cancel</button
        ><button type="submit" class="primary" disabled={busy || !!fieldInfo.error}
          >{busy ? 'Saving…' : 'Save template'}</button
        >
      </footer>
    </form>
  {:else}
    <form
      onsubmit={(event) => {
        event.preventDefault();
        confirm();
      }}
    >
      <div class="template-body">
        <p class="intro">
          Fill in the inputs, then review your message. You can edit it again before sending.
        </p>
        {#each fieldInfo.names as field}
          <label
            >{field}<textarea
              value={Object.hasOwn(values, field) ? values[field] : ''}
              oninput={(event) => {
                values = { ...values, [field]: event.currentTarget.value };
              }}
              rows="2"
              required
              maxlength={maxInputLength}
              placeholder={`Enter ${field}`}></textarea></label
          >
        {/each}
        <div class="template-preview">
          <h3>Message preview</h3>
          <pre>{preview.text}</pre>
        </div>
        {#if preview.error}<p role="alert" class="template-error">{preview.error}</p>{/if}
        {#if error}<p role="alert" class="template-error">{error}</p>{/if}
      </div>
      <footer>
        <button type="button" class="secondary" onclick={library}>Cancel</button><button
          type="submit"
          class="primary"
          disabled={missing || !!preview.error}>Insert into message</button
        >
      </footer>
    </form>
  {/if}
</dialog>

<style>
  .template-modal {
    width: min(640px, calc(100vw - 32px));
    max-width: none;
    height: min(740px, calc(100dvh - 40px));
    max-height: calc(100dvh - 40px);
    margin: auto;
    padding: 24px;
    overflow: hidden;
    color: #e3ebda;
  }
  .template-modal[open] {
    display: flex;
    flex-direction: column;
  }
  .template-modal::backdrop {
    background: #070e04bf;
    backdrop-filter: blur(6px);
  }
  .template-modal header {
    flex: none;
    align-items: center;
    margin-bottom: 20px;
  }
  .template-heading {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .template-modal h2 {
    margin: 0;
    font-size: 21px;
    overflow-wrap: anywhere;
  }
  .template-modal form {
    min-height: 0;
    flex: 1;
    gap: 0;
  }
  .template-body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    flex: 1;
    /* The shared focus ring extends 6px beyond controls; keep it inside the scrollport. */
    padding: 8px 8px 12px;
    scroll-padding: 8px;
    scrollbar-gutter: stable;
  }
  .template-modal footer {
    flex: none;
    margin-top: 8px;
    padding-top: 16px;
    flex-wrap: wrap;
  }
  .intro,
  .template-empty span {
    color: #a4b995;
    font-size: 12px;
    line-height: 1.6;
    margin: 0;
  }
  .template-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .template-row {
    display: flex;
    align-items: center;
    gap: 4px;
    border-bottom: 1px solid #354c24;
    padding: 8px 0;
  }
  .template-use {
    display: flex;
    align-items: center;
    text-align: left;
    gap: 12px;
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: inherit;
    padding: 8px;
    border-radius: 6px;
  }
  .template-use:hover {
    background: #293820;
  }
  .template-use > :global(svg) {
    flex: none;
    color: #a6bc8f;
  }
  .template-use span {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .template-use strong {
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .template-use small {
    font-size: 11px;
    color: #a4b995;
  }
  .template-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    text-align: center;
    gap: 12px;
    padding: 24px;
    color: #a4b995;
  }
  .template-empty p {
    color: #e3ebda;
    margin: 0;
  }
  .template-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .template-delete {
    border: 1px solid #766243;
    border-radius: 8px;
    padding: 14px;
  }
  .template-delete p {
    font-size: 13px;
    margin: 0 0 12px;
    overflow-wrap: anywhere;
  }
  .template-error {
    color: #f0b397;
    font-size: 12px;
    line-height: 1.5;
    margin: 0;
  }
  .template-fields {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .template-fields span {
    padding: 4px 8px;
    background: #293820;
    border-radius: 4px;
    color: #c6d9b3;
    font-size: 11px;
  }
  .template-preview {
    border-top: 1px solid #354c24;
    padding-top: 16px;
  }
  .template-preview h3 {
    font-size: 12px;
    color: #bacda5;
    margin: 0 0 10px;
  }
  .template-preview pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
    font-size: 12px;
    line-height: 1.7;
    margin: 0;
    max-height: 220px;
    overflow: auto;
  }
  .template-modal textarea {
    resize: vertical;
    min-height: 64px;
    max-height: 320px;
  }
  @media (max-width: 650px) {
    .template-modal {
      padding: 16px;
      height: calc(100dvh - 24px);
      max-height: calc(100dvh - 24px);
      width: calc(100vw - 24px);
    }
    .template-modal h2 {
      font-size: 18px;
    }
  }
</style>
