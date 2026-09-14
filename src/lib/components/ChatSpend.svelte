<script lang="ts">
  import type { Conversation } from '$lib/domain';
  import { chatSpend, money } from '$lib/spend';
  import AccountChanges from './AccountChanges.svelte';
  let { conversation }: { conversation: Conversation } = $props();
  const spend = $derived(chatSpend(conversation));
  const latest = $derived(conversation.messages.findLast((m) => m.role === 'assistant'));
</script>

<section class="chat-spend" aria-label="Chat usage and spend">
  <div class="heading">
    <span>This chat</span>{#if spend.partial}<small>Incomplete readings</small>{/if}
  </div>
  <dl>
    <div>
      <dt>Input tokens</dt>
      <dd>{spend.input?.toLocaleString() ?? 'Not reported'}</dd>
    </div>
    <div>
      <dt>Output tokens</dt>
      <dd>{spend.output?.toLocaleString() ?? 'Not reported'}</dd>
    </div>
    <div>
      <dt>Estimated cost (USD)</dt>
      <dd>{money(spend.cost)}</dd>
    </div>
    {#if conversation.settings.provider === 'codex'}<div>
        <dt>Estimated credits</dt>
        <dd>
          {spend.credits?.toLocaleString(undefined, { maximumFractionDigits: 6 }) ?? 'Not reported'}
        </dd>
      </div>{/if}
  </dl>
  <p>{spend.detail}</p>
  <p>
    Provider estimates are not billed charges. Subscription limits cannot be converted into exact
    per-chat costs.
  </p>
  <AccountChanges message={latest} />
</section>

<style>
  section {
    margin: 9px 0;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    min-width: 0;
  }
  .heading {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 12px;
  }
  small,
  p,
  dt {
    color: var(--muted);
  }
  dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin: 10px 0;
    font-size: 12px;
  }
  dd {
    margin: 3px 0 0;
    overflow-wrap: anywhere;
    font-variant-numeric: tabular-nums;
  }
  p {
    font-size: 11px;
    line-height: 1.5;
    margin: 6px 0;
  }
</style>
