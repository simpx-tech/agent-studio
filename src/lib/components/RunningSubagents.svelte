<script lang="ts">
  import { LoaderCircle, PanelRightOpen } from '@lucide/svelte';
  import { toolDisplayStatus } from '$lib/activity';
  import { liveAction } from '$lib/activity-groups';
  import type { RunningSubagent } from '$lib/subagents';
  // A running reply's sub-agents, opened from the Sub-agents toggle in its footer. Each one
  // opens its conversation in the side panel.
  let {
    agents,
    folder,
    opened,
    open,
  }: {
    agents: RunningSubagent[];
    folder?: string;
    /** The sub-agent whose conversation the side panel shows. */
    opened?: string;
    open: (agentId: string) => void;
  } = $props();
</script>

<ul class="running-subagents" aria-label="Running sub-agents">
  {#each agents as agent (agent.id)}
    <!-- What it is doing now: its latest call, from reported metadata only. -->
    {@const doing = agent.latest
      ? liveAction(agent.latest, toolDisplayStatus(agent.latest, 'running'), { folder })
      : undefined}
    <li>
      <button
        type="button"
        aria-current={opened === agent.id ? 'true' : undefined}
        title="Open this sub-agent’s conversation beside the chat"
        onclick={() => open(agent.id)}
      >
        <LoaderCircle size={14} class="spinning" aria-hidden="true" />
        <span class="agent-line">
          <span class="agent-name">{agent.name}</span>
          {#if doing}<span class="agent-doing" title={doing.hint}
              >{doing.verb}{#if doing.target}<span class:code={doing.code}>{doing.target}</span
                >{/if}</span
            >{/if}
        </span>
        <small
          >{#if agent.background}<span>In background</span>{/if}<span
            >{agent.calls === 1 ? '1 call' : `${agent.calls} calls`}</span
          ></small
        >
        <PanelRightOpen size={13} class="open-mark" aria-hidden="true" />
      </button>
    </li>
  {/each}
</ul>

<style>
  ul {
    display: grid;
    /* Long names and targets shorten with an ellipsis instead of widening the list. */
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
    margin: 0 -8px;
    padding: 0;
    list-style: none;
  }
  button {
    display: flex;
    justify-content: flex-start;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-width: 0;
    padding: 6px 8px;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--text-secondary);
    text-align: left;
  }
  button:hover {
    background: var(--hover);
  }
  button[aria-current='true'] {
    background: var(--selected);
  }
  button > :global(svg) {
    flex-shrink: 0;
    color: var(--accent-strong);
  }
  button > :global(.open-mark) {
    color: var(--text-faint);
  }
  .agent-line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex: 1;
    min-width: 0;
    white-space: nowrap;
  }
  .agent-name {
    flex: none;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
    color: var(--text);
  }
  .agent-doing {
    display: flex;
    align-items: baseline;
    gap: 5px;
    min-width: 0;
    overflow: hidden;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
  .agent-doing > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-secondary);
  }
  .agent-doing > .code {
    font-family: var(--font-mono);
  }
  small {
    display: inline-flex;
    gap: 6px;
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  small > span + span::before {
    content: '·';
    margin-right: 6px;
  }
  /* Phones name each sub-agent in full width and leave what it does to its conversation. */
  @media (max-width: 600px) {
    .agent-name {
      max-width: none;
    }
    .agent-doing {
      display: none;
    }
  }
</style>
