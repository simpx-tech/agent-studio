<script lang="ts">
  import { templateParts } from '$lib/workflow-templates';
  // A text setting of a workflow step whose {{…}} values are coloured by what they name, and
  // marked when they name no step (requested 2026-10-19): a textarea whose own text is clear, over
  // a copy of it that draws the colours, both in one grid cell so the field grows with its text.
  let {
    value,
    oninput,
    onfocus,
    rows = 1,
    placeholder = '',
    label,
    known,
    mono = false,
  }: {
    value: string;
    oninput: (value: string) => void;
    onfocus?: (event: FocusEvent) => void;
    /** The lines it shows at least; one line takes no line breaks. */
    rows?: number;
    placeholder?: string;
    label?: string;
    /** Whether a step has this key, so a value that names none is marked. */
    known?: (key: string) => boolean;
    mono?: boolean;
  } = $props();
  const parts = $derived(templateParts(value, known));
</script>

<div class="template-field" class:mono>
  <div class="mirror" aria-hidden="true">
    {#each parts as part, index (index)}{#if part.kind}<span class="value value-{part.kind}"
          >{part.text}</span
        >{:else}{part.text}{/if}{/each}{' '}
  </div>
  <textarea
    {rows}
    {placeholder}
    aria-label={label}
    spellcheck="false"
    {value}
    {onfocus}
    oninput={(event) => oninput(event.currentTarget.value)}
    onkeydown={(event) => {
      if (rows === 1 && event.key === 'Enter') event.preventDefault();
    }}></textarea>
</div>

<style>
  .template-field {
    display: grid;
    min-width: 0;
    border-radius: var(--radius-md);
    background: var(--input-bg);
  }
  .template-field > * {
    grid-area: 1 / 1;
    min-width: 0;
  }
  .mirror,
  textarea {
    margin: 0;
    padding: 8px 11px;
    font-family: inherit;
    font-size: var(--text-base);
    line-height: 1.45;
    letter-spacing: inherit;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 4;
  }
  .mono .mirror,
  .mono textarea {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
  .mirror {
    border: 1px solid transparent;
    color: var(--text);
    overflow: hidden;
    pointer-events: none;
  }
  textarea {
    position: relative;
    align-self: stretch;
    min-height: 0;
    resize: none;
    overflow: hidden;
    background: transparent;
    color: transparent;
    caret-color: var(--text);
  }
  textarea::placeholder {
    color: var(--text-faint);
  }
  .value {
    border-radius: 3px;
  }
  .value-input {
    color: var(--syntax-string);
    background: color-mix(in srgb, var(--syntax-string) 12%, transparent);
  }
  .value-trigger {
    color: var(--syntax-number);
    background: color-mix(in srgb, var(--syntax-number) 12%, transparent);
  }
  .value-previous {
    color: var(--syntax-type);
    background: color-mix(in srgb, var(--syntax-type) 12%, transparent);
  }
  .value-step {
    color: var(--syntax-title);
    background: color-mix(in srgb, var(--syntax-title) 12%, transparent);
  }
  .value-loop {
    color: var(--syntax-keyword);
    background: color-mix(in srgb, var(--syntax-keyword) 12%, transparent);
  }
  .value-run {
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--text-secondary) 10%, transparent);
  }
  .value-unknown {
    color: var(--danger);
    text-decoration: wavy underline;
    text-decoration-color: color-mix(in srgb, var(--danger) 70%, transparent);
  }
</style>
