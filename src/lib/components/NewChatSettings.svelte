<script lang="ts" module>
  import type { PoolReading } from '$lib/account-balance';
  import type { ProviderId } from '$lib/domain';

  /** An agent's accounts that new chats are balanced between, computer by computer. */
  export type BalanceAgent = {
    id: ProviderId;
    name: string;
    mark: string;
    color: string;
    computers: {
      id: string;
      name: string;
      server: boolean;
      /** Each account's connection on that computer, with whether it takes part there. */
      accounts: { id: string; name: string; color: string; included: boolean; signIn: boolean }[];
      /** The usage of the accounts balancing chooses between there, for what they used together. */
      usage: PoolReading[];
    }[];
  };
</script>

<script lang="ts">
  import { Monitor, Scale, Server } from '@lucide/svelte';
  import PoolUsage from './PoolUsage.svelte';
  let {
    balanceAccounts,
    setBalanceAccounts,
    agents = [],
    setIncluded,
  }: {
    /** Whether new chats start on the least used account of their agent. */
    balanceAccounts: boolean;
    setBalanceAccounts: (enabled: boolean) => Promise<void>;
    /** Where new chats are balanced between accounts, agent by agent and computer by computer. */
    agents?: BalanceAgent[];
    setIncluded: (connectionId: string, included: boolean) => Promise<void>;
  } = $props();
  const id = $props.id();
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
  {#if balanceAccounts && agents.length}
    <div class="agents" role="group" aria-label="Accounts new chats start on">
      {#each agents as agent (agent.id)}
        <div class="agent" role="group" aria-labelledby={`${id}-${agent.id}`}>
          <h3 id={`${id}-${agent.id}`}>
            <span class="agent-mark" style:--provider-color={agent.color} aria-hidden="true"
              >{agent.mark}</span
            >{agent.name}
          </h3>
          <div class="computers">
            {#each agent.computers as computer (computer.id)}
              <div
                class="computer"
                role="group"
                aria-labelledby={`${id}-${agent.id}-${computer.id}`}
              >
                <h4 id={`${id}-${agent.id}-${computer.id}`}>
                  {#if computer.server}<Server size={14} aria-hidden="true" />{:else}<Monitor
                      size={14}
                      aria-hidden="true"
                    />{/if}<span>{computer.name}</span>
                </h4>
                <PoolUsage provider={agent.id} readings={computer.usage} />
                {#each computer.accounts as account (account.id)}
                  <label class="checkbox"
                    ><input
                      type="checkbox"
                      checked={account.included}
                      disabled={busy}
                      onchange={(event) =>
                        change(event.currentTarget, (included) =>
                          setIncluded(account.id, included),
                        )}
                    /><span class="account"
                      ><span
                        class="account-dot"
                        style:--account-color={account.color}
                        aria-hidden="true"
                      ></span><span class="account-name">{account.name}</span
                      >{#if account.signIn}<small>Sign-in needed</small>{/if}</span
                    ></label
                  >
                {/each}
              </div>
            {/each}
          </div>
        </div>
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
  .agents {
    display: grid;
    gap: 18px;
    margin: 16px 0 2px 28px;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 10px;
    font-size: var(--text-base);
    font-weight: 600;
  }
  .agent-mark {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    border-radius: var(--radius-sm);
    color: color-mix(in srgb, var(--provider-color) var(--provider-ink-mix), var(--text));
    background: color-mix(in srgb, var(--provider-color) 11%, transparent);
    border: 1px solid color-mix(in srgb, var(--provider-color) 20%, transparent);
    font-size: 13px;
    font-weight: 400;
    line-height: 1;
  }
  /* A card per computer, side by side while they fit. */
  .computers {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 10px;
  }
  .computer {
    display: grid;
    align-content: start;
    justify-items: start;
    gap: 9px;
    min-width: 0;
    padding: 11px 12px 13px;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface-2);
  }
  h4 {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    margin: 0 0 1px;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
  }
  h4 :global(svg) {
    flex-shrink: 0;
    color: var(--text-muted);
  }
  h4 span {
    overflow-wrap: anywhere;
  }
  .computer .checkbox {
    margin: 0;
  }
  .account {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    column-gap: 8px;
    min-width: 0;
  }
  .account .account-dot {
    margin-right: -2px;
  }
  .account-name {
    overflow-wrap: anywhere;
  }
  .account small {
    color: var(--warning);
    font-size: var(--text-xs);
  }
</style>
