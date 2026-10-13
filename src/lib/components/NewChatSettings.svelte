<script lang="ts">
  import { Scale } from '@lucide/svelte';
  let {
    balanceAccounts,
    setBalanceAccounts,
    accounts = [],
    setIncluded,
  }: {
    /** Whether new chats start on the least used account of their agent. */
    balanceAccounts: boolean;
    setBalanceAccounts: (enabled: boolean) => Promise<void>;
    /** The accounts that can be chosen between, each with whether it takes part. */
    accounts?: { id: string; name: string; color: string; where: string; included: boolean }[];
    setIncluded: (accountId: string, included: boolean) => Promise<void>;
  } = $props();
  let busy = $state(false);
  let error = $state('');
  async function change(input: HTMLInputElement, save: (checked: boolean) => Promise<void>) {
    const checked = input.checked;
    busy = true;
    error = '';
    try {
      await save(checked);
    } catch (e) {
      // The switch shows the saved choice, not the one that could not be saved.
      input.checked = !checked;
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
      onchange={(event) => change(event.currentTarget, setBalanceAccounts)}
    /><span>Start on the least used account</span></label
  >
  {#if balanceAccounts && accounts.length}
    <div class="accounts" role="group" aria-label="Accounts new chats start on">
      {#each accounts as account (account.id)}
        <label class="checkbox"
          ><input
            type="checkbox"
            checked={account.included}
            disabled={busy}
            onchange={(event) =>
              change(event.currentTarget, (included) => setIncluded(account.id, included))}
          /><span
            ><span class="account-dot" style:--account-color={account.color} aria-hidden="true"
            ></span>{account.name}{#if account.where}{' '}<small>{account.where}</small>{/if}</span
          ></label
        >
      {/each}
    </div>
  {/if}
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
  .accounts {
    display: grid;
    justify-items: start;
    gap: 8px;
    margin: 10px 0 2px 28px;
  }
  .accounts .checkbox {
    margin: 0;
  }
  .accounts small {
    margin-left: 4px;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
</style>
