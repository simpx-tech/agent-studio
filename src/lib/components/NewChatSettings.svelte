<script lang="ts">
  import { Scale } from '@lucide/svelte';
  let {
    balanceAccounts,
    setBalanceAccounts,
  }: {
    /** Whether new chats start on the least used account of their agent. */
    balanceAccounts: boolean;
    setBalanceAccounts: (enabled: boolean) => Promise<void>;
  } = $props();
  let busy = $state(false);
  let error = $state('');
  async function change(input: HTMLInputElement) {
    const enabled = input.checked;
    busy = true;
    error = '';
    try {
      await setBalanceAccounts(enabled);
    } catch (e) {
      // The switch shows the saved choice, not the one that could not be saved.
      input.checked = !enabled;
      error = String(e).replace(/^Error: /, '');
    } finally {
      busy = false;
    }
  }
</script>

<section aria-labelledby="new-chats-heading">
  <h2 id="new-chats-heading"><Scale size={18} />New chats</h2>
  <label class="checkbox"
    ><input
      type="checkbox"
      checked={balanceAccounts}
      disabled={busy}
      onchange={(event) => change(event.currentTarget)}
    /><span>Start on the least used account</span></label
  >
  {#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .checkbox {
    margin: 14px 0 2px;
  }
</style>
