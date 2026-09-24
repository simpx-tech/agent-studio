<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
  import {
    diffRows,
    fileChangeBase,
    relativeFilePath,
    type ChangeSummary,
  } from '$lib/file-changes';
  import { revealedDisclosures } from '$lib/disclosures';
  let {
    response,
    chat,
    id,
    folder,
  }: {
    response: ChangeSummary;
    chat: ChangeSummary;
    id: string;
    folder?: string;
  } = $props();
  let mode = $state<'response' | 'chat'>('response');
  const initialFileLimit = 5;
  let expandedFiles = $state({ response: false, chat: false });
  const selected = $derived(mode === 'response' ? response : chat);
  const showAll = $derived(expandedFiles[mode]);
  const visibleFiles = $derived(
    showAll ? selected.files : selected.files.slice(0, initialFileLimit),
  );
  const existingFiles = $derived(selected.files.filter((file) => file.kind !== 'added'));
  const added = $derived(existingFiles.reduce((n, f) => n + (f.added ?? 0), 0));
  const removed = $derived(existingFiles.reduce((n, f) => n + (f.removed ?? 0), 0));
  const base = $derived(
    fileChangeBase(
      chat.files.flatMap((file) =>
        file.previousPath ? [file.previousPath, file.path] : [file.path],
      ),
      folder,
    ),
  );
  const kindLabels = { added: 'Added', modified: 'Edited', deleted: 'Deleted', renamed: 'Renamed' };
  // Diffs render when their file is first expanded.
  const diffs = revealedDisclosures();
  const fileKey = (file: ChangeSummary['files'][number]) =>
    `${mode}:${file.previousPath ?? ''}:${file.path}`;
  function displayPath(path: string) {
    return relativeFilePath(path, base);
  }
  function tabKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    mode =
      event.key === 'Home'
        ? 'response'
        : event.key === 'End'
          ? 'chat'
          : mode === 'response'
            ? 'chat'
            : 'response';
    const group = (event.target as HTMLElement).closest('[role="tablist"]');
    (group?.querySelector(`[data-mode="${mode}"]`) as HTMLElement)?.focus();
  }
</script>

<div class="file-changes">
  <div class="changes-body">
    <div class="changes-toolbar">
      <div class="change-tabs" role="tablist" aria-label="File change scope">
        <button
          role="tab"
          onkeydown={tabKey}
          id={`${id}-response-tab`}
          aria-controls={`${id}-changes`}
          aria-selected={mode === 'response'}
          tabindex={mode === 'response' ? 0 : -1}
          data-mode="response"
          onclick={() => (mode = 'response')}>This response</button
        >
        <button
          role="tab"
          onkeydown={tabKey}
          id={`${id}-chat-tab`}
          aria-controls={`${id}-changes`}
          aria-selected={mode === 'chat'}
          tabindex={mode === 'chat' ? 0 : -1}
          data-mode="chat"
          onclick={() => (mode = 'chat')}>All chat changes</button
        >
      </div>
      <span class="change-totals"
        >{selected.files.length}
        {selected.files.length === 1 ? 'file' : 'files'}
        {#if added || removed}<span class="add" title="Lines added to existing files">+{added}</span
          ><span class="remove" title="Lines removed from existing files">−{removed}</span>{/if}
      </span>
    </div>
    <div
      id={`${id}-changes`}
      role="tabpanel"
      aria-labelledby={`${id}-${mode === 'response' ? 'response' : 'chat'}-tab`}
      tabindex="0"
    >
      <div class="file-list" id={`${id}-file-list`}>
        {#if !selected.files.length}<p class="empty-changes">
            {selected.recorded
              ? 'No net file changes recorded.'
              : 'File changes were not recorded for this response.'}
          </p>{/if}
        {#each visibleFiles as file (fileKey(file))}
          {@const key = fileKey(file)}
          <details class="changed-file" ontoggle={diffs.opened(key)}>
            <summary title={file.path} onclick={diffs.reveal(key)}>
              <ChevronRight size={13} class="disclosure" />
              <span class="file-path"
                >{#if file.previousPath}<span class="previous-path"
                    >{displayPath(file.previousPath)} →
                  </span>{/if}{displayPath(file.path)}</span
              >
              <span
                class="file-kind"
                class:new-file={file.kind === 'added'}
                title={file.kind === 'added' ? 'New file created in this scope' : undefined}
                >{kindLabels[file.kind]}</span
              >
              {#if file.kind !== 'added' && file.added !== undefined}<span class="add"
                  >+{file.added}</span
                ><span class="remove">−{file.removed}</span>{:else if file.added === undefined}<span
                  class="muted">Diff unavailable</span
                >{/if}
            </summary>
            {#if diffs.has(key)}
              {#if file.unavailable}<p class="diff-unavailable">{file.unavailable}</p>
              {:else if !file.hunks?.length}<p class="diff-unavailable">
                  {file.kind === 'renamed'
                    ? 'File renamed without recorded text changes.'
                    : 'Empty file; no text diff.'}
                </p>
              {:else}
                <!-- The scrollable diff needs keyboard access on narrow screens. -->
                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <div
                  class="diff-scroll"
                  role="region"
                  aria-label={`Diff for ${file.path}`}
                  tabindex="0"
                >
                  <table class="diff-table" aria-label={`Changes in ${file.path}`}>
                    <thead class="sr-only"
                      ><tr><th>Original line</th><th>Updated line</th><th>Change</th></tr></thead
                    >
                    <tbody
                      >{#each file.hunks as hunk}
                        {#if file.kind !== 'added'}<tr class="hunk"
                            ><td colspan="3"
                              >@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</td
                            ></tr
                          >{/if}
                        {#each diffRows(hunk) as row}<tr
                            class:added={row.text.startsWith('+')}
                            class:removed={row.text.startsWith('-')}
                          >
                            <td class="line-number">{row.old ?? ''}</td><td class="line-number"
                              >{row.next ?? ''}</td
                            ><td class="diff-code"><code>{row.text}</code></td>
                          </tr>{/each}
                      {/each}</tbody
                    >
                  </table>
                </div>
              {/if}
            {/if}
          </details>
        {/each}
      </div>
      {#if selected.files.length > initialFileLimit}
        <button
          class="show-files"
          aria-expanded={showAll}
          aria-controls={`${id}-file-list`}
          onclick={() => (expandedFiles[mode] = !showAll)}
          >{showAll ? 'Show fewer files' : `Show all ${selected.files.length} files`}</button
        >
      {/if}
      {#if selected.limited}<p class="scope-note">
          The recording limit was reached. Some file changes are unavailable.
        </p>{/if}
    </div>
  </div>
</div>

<style>
  .file-changes {
    font-size: var(--text-sm);
    min-width: 0;
  }
  summary {
    display: flex;
    align-items: center;
    gap: 7px;
    cursor: pointer;
    list-style: none;
    min-width: 0;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary :global(.disclosure) {
    flex: 0 0 auto;
    color: var(--text-faint);
    transition: transform var(--duration-fast) var(--ease-out);
  }
  details[open] > summary :global(.disclosure) {
    transform: rotate(90deg);
  }
  .changes-body {
    margin-top: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-1);
    overflow: hidden;
  }
  .changes-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px 6px 6px;
    border-bottom: 1px solid var(--border);
  }
  .change-tabs {
    display: flex;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-md);
    background: var(--hover);
  }
  .change-tabs button {
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 500;
    padding: 4px 9px;
  }
  .change-tabs button[aria-selected='true'] {
    background: var(--surface-3);
    color: var(--text);
    box-shadow: var(--shadow-sm);
  }
  .change-totals {
    display: flex;
    gap: 8px;
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .scope-note,
  .empty-changes,
  .diff-unavailable {
    margin: 0;
    padding: 9px 12px;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: var(--leading-normal);
  }
  .file-list {
    padding: 8px 8px 2px;
  }
  .show-files {
    margin: 0 8px 8px;
    padding: 5px 10px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 500;
  }
  .show-files:not(:disabled):hover {
    border-color: var(--border-hover);
  }
  .changed-file {
    margin: 0 0 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    overflow: hidden;
  }
  .changed-file > summary {
    padding: 7px 10px;
    flex-wrap: wrap;
    transition: background-color var(--duration-fast) ease;
  }
  .changed-file > summary:hover {
    background: var(--hover);
  }
  .file-path {
    flex: 1 1 160px;
    overflow-wrap: anywhere;
    min-width: 0;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  .previous-path,
  .file-kind,
  .muted {
    color: var(--text-muted);
  }
  .file-kind {
    padding: 0 6px;
    border-radius: var(--radius-full);
    background: var(--hover);
    font-size: var(--text-2xs);
    font-weight: 600;
    line-height: 17px;
  }
  .file-kind.new-file {
    background: var(--success-soft);
    color: var(--success);
  }
  .add {
    color: var(--success);
    font-variant-numeric: tabular-nums;
  }
  .remove {
    color: var(--danger);
    font-variant-numeric: tabular-nums;
  }
  .diff-scroll {
    overflow: auto;
    max-height: 420px;
    border-top: 1px solid var(--border);
    background: var(--code-bg);
  }
  .diff-table {
    border-collapse: collapse;
    width: 100%;
    font: 11.5px/1.7 var(--font-mono);
  }
  .diff-table td {
    padding: 0 8px;
    border: 0;
    vertical-align: top;
  }
  .line-number {
    width: 36px;
    min-width: 30px;
    text-align: right;
    color: var(--text-faint);
    user-select: none;
  }
  .diff-code {
    white-space: pre;
    color: var(--code-text);
  }
  .diff-code code {
    font: inherit;
    background: none;
    padding: 0;
  }
  .hunk {
    background: var(--diff-hunk-bg);
    color: var(--diff-hunk-text);
  }
  .hunk td {
    padding: 3px 10px;
  }
  tr.added {
    background: var(--diff-add-bg);
  }
  tr.removed {
    background: var(--diff-remove-bg);
  }
  tr.added .diff-code {
    color: var(--diff-add-text);
  }
  tr.removed .diff-code {
    color: var(--diff-remove-text);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
