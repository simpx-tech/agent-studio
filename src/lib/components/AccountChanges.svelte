<script lang="ts">
  import type { Message } from '$lib/domain';
  import { accountChanges } from '$lib/spend';
  let { message }: { message?: Message } = $props();
  const rows = $derived(accountChanges(message));
  const observation = $derived(message?.accountUsage);
</script>

<details class="account-changes">
  <summary>Account changes during this reply</summary>
  {#if observation?.before && observation.after}
    <p>
      {new Date(observation.before.checkedAt * 1000).toLocaleString()} – {new Date(
        observation.after.checkedAt * 1000,
      ).toLocaleString()}
    </p>
  {/if}
  {#if rows.length}
    <dl>
      {#each rows as row}<div>
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>{/each}
    </dl>
  {:else}<p>No comparable before-and-after readings were recorded.</p>{/if}
  <p>
    Shared account observations. Other chats, devices, delayed reporting, resets and credit
    purchases may contribute. These changes are not this chat’s billed spend or exact share of its
    limits.
  </p>
</details>

<style>
  details {
    margin-top: 10px;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  summary {
    width: fit-content;
    cursor: pointer;
    font-weight: 500;
  }
  summary:hover {
    color: var(--text);
  }
  p {
    margin: 6px 0;
    line-height: var(--leading-normal);
    color: inherit;
    font-size: inherit;
  }
  dl {
    margin: 6px 0;
  }
  dl > div {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 4px 16px;
    margin: 5px 0;
  }
  dd {
    margin: 0;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
</style>
