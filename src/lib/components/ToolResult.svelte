<script module lang="ts">
  import { createToolOutputCache } from '$lib/tool-output';
  import { readToolOutput } from '$lib/transport';
  // Shared by every reply in this window, so reopening a call does not ask the host again.
  const outputs = createToolOutputCache(readToolOutput);
</script>

<script lang="ts">
  import { untrack, tick } from 'svelte';
  import { Check, Copy, ImageOff, LoaderCircle, RotateCcw, X } from '@lucide/svelte';
  import type { ToolActivity } from '$lib/activity';
  import type { Message } from '$lib/domain';
  import { highlightCode } from '$lib/markdown';
  import {
    formatBytes,
    outputLines,
    toolOutputImageUrl,
    type ToolOutput,
    type ToolOutputImage,
  } from '$lib/tool-output';
  import { fileLanguage, primaryCommand } from '$lib/tool-presentation';

  let {
    tool,
    runId,
    connectionId,
    replyStatus,
  }: {
    tool: ToolActivity;
    runId?: string;
    connectionId?: string;
    replyStatus: Message['status'];
  } = $props();

  const shells = {
    bash: 'Bash',
    sh: 'Shell',
    zsh: 'Zsh',
    powershell: 'PowerShell',
    cmd: 'Command Prompt',
  };
  const prompts = { bash: '$', sh: '$', zsh: '%', powershell: 'PS>', cmd: '>' };
  // Lines a CLI hook put before the model's command are shown, but quietly.
  const commandParts = $derived.by(() => {
    if (!tool.command) return;
    const lines = tool.command.split('\n');
    const first = lines.findIndex((line) => line.trim() === primaryCommand(tool.command!).line);
    const hooks = first > 0 ? lines.slice(0, first).join('\n').trim() : '';
    const body = first > 0 ? lines.slice(first).join('\n') : tool.command;
    const language =
      tool.shell === 'powershell' ? 'powershell' : tool.shell === 'cmd' ? '' : 'bash';
    return { hooks, body, highlighted: highlightCode(body, language) };
  });
  const input = $derived.by(() => {
    if (!tool.input) return;
    let json = false;
    try {
      JSON.parse(tool.input);
      json = true;
    } catch {
      /* Plain text input stays unhighlighted. */
    }
    return { text: tool.input, highlighted: json ? highlightCode(tool.input, 'json') : null };
  });
  const summary = $derived(tool.output);
  const empty = $derived(!!summary && !summary.bytes && !summary.images);
  const meta = $derived.by(() => {
    if (!summary) return '';
    if (empty) return 'No output';
    const lines = `${summary.lines.toLocaleString()} ${summary.lines === 1 ? 'line' : 'lines'}`;
    const images = summary.images
      ? `${summary.images} ${summary.images === 1 ? 'image' : 'images'}`
      : '';
    return [summary.lines || !images ? lines : '', images].filter(Boolean).join(' · ');
  });
  const fileRead = $derived(tool.operation === 'read');
  const running = $derived(tool.status === 'running' && replyStatus === 'running');
  const failed = $derived(
    tool.status === 'error' || (summary?.exitCode != null && summary.exitCode !== 0),
  );

  let output = $state<ToolOutput>();
  let error = $state('');
  let loading = $state(false);
  let attempt = $state(0);
  // Only the call and its run select a result; revisions and relay updates do not reload it.
  const key = $derived(runId && summary && !empty ? `${runId}\n${tool.id}` : '');
  $effect(() => {
    const current = key;
    void attempt;
    if (!current) return;
    let live = true;
    loading = true;
    error = '';
    untrack(() => outputs.get(runId!, tool.id, connectionId)).then(
      (value) => {
        if (!live) return;
        output = value;
        loading = false;
      },
      (reason) => {
        if (!live) return;
        error = String(reason instanceof Error ? reason.message : reason);
        loading = false;
      },
    );
    return () => {
      live = false;
    };
  });

  const stdoutLines = $derived(outputLines(output?.stdout ?? ''));
  const stderrLines = $derived(outputLines(output?.stderr ?? ''));
  const language = $derived(fileRead ? fileLanguage(tool.path) : undefined);
  const highlighted = $derived(
    output && language && stdoutLines.length <= 3000
      ? highlightCode(output.stdout, language)
      : null,
  );
  const gutter = $derived.by(() => {
    if (!fileRead || output?.startLine == null || !stdoutLines.length) return '';
    const start = output.startLine;
    return stdoutLines.map((_, index) => start + index).join('\n');
  });
  // A long result starts in a box of about 18 lines that scrolls.
  const tall = $derived(stdoutLines.length + stderrLines.length > 18);
  let expanded = $state(false);

  let copied = $state('');
  let copyTimer: ReturnType<typeof setTimeout> | undefined;
  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = label;
    } catch {
      copied = '';
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied = ''), 1500);
  }

  let preview = $state<ToolOutputImage>();
  let dialog = $state<HTMLDialogElement>();
  async function open(image: ToolOutputImage) {
    preview = image;
    await tick();
    dialog?.showModal();
  }
  const imageLabel = (image: ToolOutputImage) =>
    [
      image.width && image.height ? `${image.width} × ${image.height}` : '',
      formatBytes(image.bytes),
    ]
      .filter(Boolean)
      .join(' · ');
</script>

{#snippet copyButton(label: string, text: string)}
  <button
    type="button"
    class="result-action"
    aria-label={`Copy ${label.toLowerCase()}`}
    title={`Copy ${label.toLowerCase()}`}
    onclick={() => copy(label, text)}
    >{#if copied === label}<Check size={12} aria-hidden="true" />Copied{:else}<Copy
        size={12}
        aria-hidden="true"
      />Copy{/if}</button
  >
{/snippet}

<div class="tool-result" data-testid="tool-result">
  <!-- Command, input and output read as one transcript of the call. -->
  {#if commandParts || input || summary}<div class="result-panel">
      {#if commandParts}
        <section class="result-section" aria-label="Command">
          <div class="result-bar">
            <span class="result-title">{tool.shell ? shells[tool.shell] : 'Command'}</span>
            {#if tool.commandTruncated}<span class="result-meta">Shortened</span>{/if}
            <span class="bar-space"></span>
            {@render copyButton('Command', tool.command!)}
          </div>
          <!-- Commands scroll inside their box; keyboard users can focus it. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div
            class="result-scroll command-scroll"
            tabindex="0"
            role="region"
            aria-label="Command text"
          >
            {#if commandParts.hooks}<pre
                class="hook-lines"
                title="Added by a configured CLI hook">{commandParts.hooks}</pre>{/if}
            <pre class="command-text hljs"><span class="prompt" aria-hidden="true"
                >{tool.shell ? prompts[tool.shell] : '$'}</span
              ><code
                >{#if commandParts.highlighted}{@html commandParts.highlighted
                    .html}{:else}{commandParts.body}{/if}</code
              ></pre>
          </div>
        </section>
      {/if}
      {#if input}
        <section class="result-section" aria-label="Input">
          <div class="result-bar">
            <span class="result-title">Input</span>
            {#if tool.inputTruncated}<span class="result-meta">Shortened</span>{/if}
            <span class="bar-space"></span>
            {@render copyButton('Input', input.text)}
          </div>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div class="result-scroll" tabindex="0" role="region" aria-label="Input text">
            <pre class="result-text hljs"><code
                >{#if input.highlighted}{@html input.highlighted.html}{:else}{input.text}{/if}</code
              ></pre>
          </div>
        </section>
      {/if}
      {#if summary}
        <section class="result-section" aria-label={fileRead ? 'File content' : 'Output'}>
          <div class="result-bar">
            <span class="result-title">{fileRead ? 'File content' : 'Output'}</span>
            <span class="result-meta">{meta}</span>
            {#if summary.exitCode != null}<span
                class="exit-code"
                class:failed={summary.exitCode !== 0}
                title="Exit code reported by the provider">Exit code {summary.exitCode}</span
              >{/if}
            <span class="bar-space"></span>
            {#if output && (output.stdout || output.stderr)}
              {#if tall}<button
                  type="button"
                  class="result-action"
                  aria-expanded={expanded}
                  onclick={() => (expanded = !expanded)}
                  >{expanded ? 'Show less' : 'Show all'}</button
                >{/if}
              {@render copyButton(
                'Output',
                [output.stdout, output.stderr]
                  .filter(Boolean)
                  .join(output.stdout.endsWith('\n') ? '' : '\n'),
              )}
            {/if}
          </div>
          {#if !runId && !empty}
            <p class="result-note">
              This reply has no run identity, so its output cannot be found.
            </p>
          {:else if loading}
            <p class="result-note" role="status">
              <LoaderCircle size={13} class="spinning" aria-hidden="true" />Loading output…
            </p>
          {:else if error}
            <p class="result-note failed" role="alert">
              {error}
              <button type="button" class="result-action" onclick={() => attempt++}
                ><RotateCcw size={12} aria-hidden="true" />Retry</button
              >
            </p>
          {:else if output}
            {#if output.omitted}<p class="result-note">
                Not kept: this reply reached its 256 MB output limit on the computer that ran it.
              </p>{/if}
            {#if output.stdout}
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <div
                class="result-scroll"
                class:expanded
                tabindex="0"
                role="region"
                aria-label={fileRead ? 'File content text' : 'Output text'}
              >
                <div class="code-view">
                  {#if gutter}<pre class="gutter" aria-hidden="true">{gutter}</pre>{/if}
                  <pre class="result-text hljs"><code
                      >{#if highlighted}{@html highlighted.html}{:else}{output.stdout}{/if}</code
                    ></pre>
                </div>
              </div>
            {/if}
            {#if output.stderr}
              <!-- Tools also write warnings and notes to standard error; only a failure is red. -->
              <div class="stream-label" class:failed>Standard error</div>
              <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
              <div
                class="result-scroll"
                class:expanded
                tabindex="0"
                role="region"
                aria-label="Error output text"
              >
                <pre class="result-text stderr" class:failed>{output.stderr}</pre>
              </div>
            {/if}
            {#if output.images.length}
              <div class="result-images">
                {#each output.images as image, index (index)}
                  <button
                    type="button"
                    class="result-image"
                    class:small={(image.width ?? 64) < 64 && (image.height ?? 64) < 64}
                    title="Open image"
                    aria-label={`Open image ${index + 1}${imageLabel(image) ? `, ${imageLabel(image)}` : ''}`}
                    onclick={() => open(image)}
                  >
                    <img
                      src={toolOutputImageUrl(image)}
                      alt={`Image ${index + 1} returned by ${tool.name}`}
                      width={image.width}
                      height={image.height}
                    />
                    <span>{imageLabel(image)}</span>
                  </button>
                {/each}
              </div>
            {/if}
            {#if output.imagesOmitted}<p class="result-note">
                <ImageOff size={13} aria-hidden="true" />{output.imagesOmitted}
                {output.imagesOmitted === 1 ? 'image was' : 'images were'} not kept: unreadable, unsupported,
                or over the size limit.
              </p>{/if}
            {#if output.truncated || summary.truncated}<p class="result-note">
                Shortened: the beginning and end are kept, {formatBytes(
                  new TextEncoder().encode(output.stdout + output.stderr).length,
                )} of {formatBytes(summary.bytes)}.
              </p>{/if}
            {#if !output.stdout && !output.stderr && !output.images.length && !output.omitted}<p
                class="result-note"
              >
                No output.
              </p>{/if}
          {/if}
        </section>
      {:else if tool.command && running && !tool.background}
        <p class="result-note">The output appears when the command finishes.</p>
      {:else if tool.command && tool.status !== 'running' && !tool.background}
        <p class="result-note">Output was not recorded for this call.</p>
      {/if}
    </div>{/if}
</div>

<dialog
  bind:this={dialog}
  class="image-preview"
  aria-label="Image preview"
  onclose={() => (preview = undefined)}
>
  {#if preview}
    <div class="image-preview-heading">
      <span>{tool.path ?? tool.name}{imageLabel(preview) ? ` · ${imageLabel(preview)}` : ''}</span
      ><button
        type="button"
        class="icon-button"
        aria-label="Close image preview"
        onclick={() => dialog?.close()}><X size={18} /></button
      >
    </div>
    <img src={toolOutputImageUrl(preview)} alt={`Full size image returned by ${tool.name}`} />
  {/if}
</dialog>

<style>
  .tool-result {
    margin: 8px 0 4px;
    min-width: 0;
  }
  .result-panel {
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--code-bg);
    overflow: hidden;
  }
  .result-section {
    min-width: 0;
  }
  .result-panel > * + * {
    border-top: 1px solid var(--border);
  }
  .result-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    min-height: 28px;
    padding: 3px 6px 3px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .result-title {
    font-weight: 600;
    color: var(--text-secondary);
  }
  .result-meta {
    font-variant-numeric: tabular-nums;
  }
  .bar-space {
    flex: 1;
  }
  .exit-code {
    padding: 0 6px;
    border-radius: var(--radius-full);
    background: var(--success-soft);
    color: var(--success);
    font-size: var(--text-2xs);
    font-weight: 600;
    line-height: 17px;
    font-variant-numeric: tabular-nums;
  }
  .exit-code.failed {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .result-action {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 7px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    transition:
      background-color var(--duration-fast) ease,
      color var(--duration-fast) ease;
  }
  .result-action:hover {
    background: var(--hover);
    color: var(--text);
  }
  .result-scroll {
    max-height: 342px;
    overflow: auto;
  }
  .result-scroll.expanded {
    max-height: none;
  }
  .command-scroll {
    max-height: 200px;
  }
  pre {
    margin: 0;
    font: 12px/1.6 var(--font-mono);
    tab-size: 4;
    color: var(--code-text);
  }
  pre code {
    font: inherit;
    background: none;
    border: 0;
    padding: 0;
  }
  .command-text {
    padding: 8px 12px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text);
  }
  .prompt {
    margin-right: 8px;
    color: var(--accent-text);
    user-select: none;
  }
  .hook-lines {
    padding: 8px 12px 0;
    color: var(--text-faint);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .code-view {
    display: flex;
    min-width: min-content;
  }
  .gutter {
    position: sticky;
    left: 0;
    flex: 0 0 auto;
    padding: 8px 10px 8px 12px;
    text-align: right;
    color: var(--text-faint);
    background: var(--code-bg);
    user-select: none;
  }
  .result-text {
    flex: 1 0 auto;
    padding: 8px 12px;
    white-space: pre;
  }
  .gutter + .result-text {
    padding-left: 4px;
  }
  .result-text.stderr {
    color: var(--text-secondary);
  }
  .result-text.stderr.failed {
    color: var(--diff-remove-text);
  }
  .stream-label {
    padding: 4px 12px;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    font-size: var(--text-2xs);
    font-weight: 600;
    color: var(--text-muted);
    background: var(--surface-1);
  }
  .stream-label.failed {
    color: var(--danger);
    background: var(--danger-soft);
  }
  .result-note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 0;
    padding: 8px 12px;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .result-section .result-note + .result-note {
    padding-top: 0;
  }
  .result-note.failed {
    color: var(--danger);
  }
  .result-images {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px;
  }
  .result-image {
    display: grid;
    gap: 4px;
    max-width: 100%;
    padding: 4px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    cursor: zoom-in;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    text-align: left;
  }
  .result-image:hover {
    border-color: var(--border-hover);
  }
  .result-image img {
    display: block;
    max-width: 100%;
    max-height: 320px;
    width: auto;
    height: auto;
    border-radius: var(--radius-xs);
    background: repeating-conic-gradient(var(--hover) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
  }
  /* Icons and other tiny images are enlarged with crisp pixels. */
  .result-image.small img {
    min-width: 64px;
    image-rendering: pixelated;
  }
  .image-preview {
    max-width: min(96vw, 1600px);
    max-height: 94vh;
    padding: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    background: var(--surface-overlay);
    color: var(--text);
    box-shadow: var(--shadow-xl);
  }
  .image-preview::backdrop {
    background: var(--backdrop);
  }
  .image-preview-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 6px 6px 14px;
    border-bottom: 1px solid var(--border);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
  .image-preview img {
    display: block;
    max-width: min(96vw, 1600px);
    max-height: calc(94vh - 48px);
    margin: 0 auto;
    object-fit: contain;
  }
</style>
