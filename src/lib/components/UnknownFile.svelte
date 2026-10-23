<script lang="ts">
  import { File } from '@lucide/svelte';
  import { formatBytes } from '$lib/tool-output';
  import type { SentFile } from '$lib/sent-files';

  let { file }: { file: SentFile } = $props();
</script>

<!-- A kind of file a later release shows, which this one cannot open. -->
<figure class="unknown-file">
  <span class="unknown-name" title={file.name}
    ><File size={13} aria-hidden="true" /><span>{file.name}</span></span
  >
  <span class="unknown-note">Needs a newer Agent Studio</span>
  <span class="unknown-spacer"></span>
  <span class="unknown-detail">{formatBytes(file.bytes)}</span>
</figure>

<style>
  .unknown-file {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;
    min-width: 0;
    margin: 0;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-1);
    color: var(--text-muted);
    font-size: var(--text-2xs);
  }
  .unknown-name {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: min(320px, 60%);
  }
  .unknown-name > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .unknown-note {
    color: var(--text-faint);
  }
  .unknown-spacer {
    flex: 1;
  }
  .unknown-detail {
    font-variant-numeric: tabular-nums;
  }
</style>
