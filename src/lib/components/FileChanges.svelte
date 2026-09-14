<script lang="ts">
  import { FileCode2, ChevronRight } from '@lucide/svelte';
  import { diffRows, type ChangeSummary } from '$lib/file-changes';
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
  const selected = $derived(mode === 'response' ? response : chat);
  const added = $derived(selected.files.reduce((n, f) => n + (f.added ?? 0), 0));
  const removed = $derived(selected.files.reduce((n, f) => n + (f.removed ?? 0), 0));
  function displayPath(path: string) {
    const normalized = path.replaceAll('\\', '/');
    const base = folder?.replaceAll('\\', '/').replace(/\/$/, '');
    const windows = /^[a-z]:/i.test(base ?? '') || base?.startsWith('//');
    if (
      base &&
      (windows
        ? normalized.toLowerCase().startsWith(base.toLowerCase() + '/')
        : normalized.startsWith(base + '/'))
    )
      return normalized.slice(base.length + 1);
    return path;
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

<details class="file-changes">
  <summary aria-label="Files edited"
    ><ChevronRight size={14} class="disclosure" /><FileCode2 size={14} />
    <span>Files edited</span><small
      >{response.files.length || (response.recorded ? '0' : '—')}</small
    >
  </summary>
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
        {#if added || removed}<span class="add">+{added}</span><span class="remove">−{removed}</span
          >{/if}
      </span>
    </div>
    <div
      id={`${id}-changes`}
      role="tabpanel"
      aria-labelledby={`${id}-${mode === 'response' ? 'response' : 'chat'}-tab`}
      tabindex="0"
    >
      <p class="scope-note">
        {mode === 'response'
          ? 'Recorded edits from this response.'
          : 'Combined recorded edits across this chat, including later responses. Reverted changes are omitted.'}
      </p>
      {#if !selected.files.length}<p class="empty-changes">
          {selected.recorded
            ? 'No net file changes recorded.'
            : 'File changes were not recorded for this response.'}
        </p>{/if}
      {#each selected.files as file (`${mode}:${file.previousPath ?? ''}:${file.path}`)}
        <details class="changed-file">
          <summary title={file.path}>
            <ChevronRight size={13} class="disclosure" />
            <span class="file-path"
              >{#if file.previousPath}<span class="previous-path"
                  >{displayPath(file.previousPath)} →
                </span>{/if}{displayPath(file.path)}</span
            >
            <span class="file-kind">{file.kind}</span>
            {#if file.added !== undefined}<span class="add">+{file.added}</span><span class="remove"
                >−{file.removed}</span
              >{:else}<span class="muted">Diff unavailable</span>{/if}
          </summary>
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
                    <tr class="hunk"
                      ><td colspan="3"
                        >@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</td
                      ></tr
                    >
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
        </details>
      {/each}
      {#if selected.limited}<p class="scope-note">
          The recording limit was reached. Some file changes are unavailable.
        </p>{/if}
      <p class="scope-note coverage">
        Only file edits reported by the agent are included. Shell commands and external edits may be
        absent.
      </p>
    </div>
  </div>
</details>

<style>
  .file-changes {
    margin-top: 14px;
    font-size: 12px;
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
  .file-changes > summary {
    color: var(--muted);
    padding: 6px 0;
    width: fit-content;
  }
  summary :global(.disclosure) {
    flex: 0 0 auto;
    transition: transform 120ms;
  }
  details[open] > summary :global(.disclosure) {
    transform: rotate(90deg);
  }
  summary small {
    color: var(--muted);
    font-size: 11px;
  }
  .changes-body {
    margin-top: 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow: hidden;
  }
  .changes-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
  }
  .change-tabs {
    display: flex;
    gap: 3px;
  }
  .change-tabs button {
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
    font-size: 11px;
    padding: 5px 7px;
  }
  .change-tabs button[aria-selected='true'] {
    background: var(--surface-raised, #282e28);
    color: var(--text, #d5dfce);
  }
  .change-totals {
    display: flex;
    gap: 7px;
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .scope-note,
  .empty-changes,
  .diff-unavailable {
    margin: 0;
    padding: 9px 12px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.6;
  }
  .coverage {
    border-top: 1px solid var(--border);
  }
  .changed-file {
    border-top: 1px solid var(--border);
  }
  .changed-file > summary {
    padding: 9px 10px;
    flex-wrap: wrap;
  }
  .file-path {
    flex: 1 1 160px;
    overflow-wrap: anywhere;
    min-width: 0;
    font-size: 12px;
  }
  .previous-path,
  .file-kind,
  .muted {
    color: var(--muted);
  }
  .file-kind {
    font-size: 10px;
    text-transform: capitalize;
  }
  .add {
    color: #a9ce88;
    font-variant-numeric: tabular-nums;
  }
  .remove {
    color: #e29a9a;
    font-variant-numeric: tabular-nums;
  }
  .diff-scroll {
    overflow: auto;
    max-height: 420px;
    border-top: 1px solid var(--border);
  }
  .diff-table {
    border-collapse: collapse;
    width: 100%;
    font:
      11px/1.7 ui-monospace,
      SFMono-Regular,
      Consolas,
      monospace;
  }
  .diff-table td {
    padding: 0 7px;
    border: 0;
    vertical-align: top;
  }
  .line-number {
    width: 36px;
    min-width: 30px;
    text-align: right;
    color: var(--muted);
    user-select: none;
  }
  .diff-code {
    white-space: pre;
  }
  .diff-code code {
    font: inherit;
    background: none;
    padding: 0;
  }
  .hunk {
    background: #202a30;
    color: #a9becb;
  }
  .hunk td {
    padding: 4px 10px;
  }
  tr.added {
    background: #263723;
  }
  tr.removed {
    background: #382726;
  }
  tr.added .diff-code {
    color: #c9e6b6;
  }
  tr.removed .diff-code {
    color: #edc0ba;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
