<script lang="ts">
  import { diffRows, type FilePatch } from '$lib/file-changes';
  let { file }: { file: FilePatch } = $props();
</script>

<!-- The scrollable diff needs keyboard access on narrow screens. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="diff-scroll" role="region" aria-label={`Diff for ${file.path}`} tabindex="0">
  <table class="diff-table" aria-label={`Changes in ${file.path}`}>
    <thead class="sr-only"
      ><tr><th>Original line</th><th>Updated line</th><th>Change</th></tr></thead
    >
    <tbody
      >{#each file.hunks ?? [] as hunk}
        {#if file.kind !== 'added'}<tr class="hunk"
            ><td colspan="3"
              >@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</td
            ></tr
          >{/if}
        {#each diffRows(hunk) as row}<tr
            class:added={row.text.startsWith('+')}
            class:removed={row.text.startsWith('-')}
          >
            <td class="line-number">{row.old ?? ''}</td><td class="line-number">{row.next ?? ''}</td
            ><td class="diff-code"><code>{row.text}</code></td>
          </tr>{/each}
      {/each}</tbody
    >
  </table>
</div>

<style>
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
