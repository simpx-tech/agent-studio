<script lang="ts">
  import {
    Sparkles,
    Globe,
    GitBranch,
    Wrench,
    LoaderCircle,
    Check,
    CircleAlert,
    ChevronDown,
    ExternalLink,
  } from '@lucide/svelte';
  import {
    activityCounts,
    safeSourceUrl,
    visibleActivityStatus,
    type ToolActivity,
  } from '$lib/activity';
  import type { Message, ContentBlock } from '$lib/domain';
  import { renderMarkdown } from '$lib/markdown';
  import { openLink } from '$lib/transport';
  let {
    tools,
    replyStatus,
    blocks = [],
    finalText = '',
  }: {
    tools: ToolActivity[];
    replyStatus: Message['status'];
    blocks?: ContentBlock[];
    finalText?: string;
  } = $props();
  let linkError = $state('');
  let filter = $state('all');
  const counts = $derived(activityCounts(tools));
  const filters = $derived([
    { id: 'all', label: 'All activity' },
    { id: 'calls', label: `Tool calls (${counts.calls})` },
    { id: 'searches', label: `Web searches (${counts.searches})` },
    { id: 'agents', label: `Sub-agents (${counts.agents})` },
    { id: 'runs', label: `Command runs (${counts.runs})` },
  ]);
  const labels = {
    running: 'Running',
    complete: 'Completed',
    error: 'Failed',
    cancelled: 'Stopped',
    unknown: 'Outcome unconfirmed',
  };
  const icons = { skill: Sparkles, search: Globe, agent: GitBranch, tool: Wrench };
  const entries = $derived(
    (blocks.length
      ? blocks
      : tools.map((tool) => ({
          type: 'activity' as const,
          text: tool.name,
          tool,
          progress: undefined,
        }))
    )
      .filter((b) => b.type === 'activity')
      .filter((b) => !b.progress || b.text.trim() !== finalText.trim())
      .filter(
        (b) =>
          b.tool ||
          b.progress ||
          !tools.length ||
          !/^(Using |Running command|Editing files|Searching the web|Using connected tool)/.test(
            b.text,
          ),
      ),
  );
  const progressCount = $derived(entries.filter((entry) => entry.progress).length);
  function shown(tool: ToolActivity) {
    if (replyStatus === 'running' || filter === 'all')
      return !tool.parentId || !tools.some((p) => p.agents.some((a) => a.id === tool.parentId));
    if (filter === 'calls') return tool.category !== 'agent' && tool.id !== 'activity-limit';
    if (filter === 'searches') return tool.category === 'search' && tool.name !== 'Open web page';
    if (filter === 'agents') return tool.category === 'agent';
    return !!tool.commandRun || ['Run command', 'Bash'].includes(tool.name);
  }
  function progressLink(event: MouseEvent) {
    const link = (event.target as Element).closest('a');
    if (link) void visit(event, link.href);
  }
  async function visit(event: MouseEvent, url: string) {
    event.preventDefault();
    const safe = safeSourceUrl(url);
    if (safe)
      try {
        await openLink(safe);
      } catch {
        linkError = 'Could not open this source.';
      }
  }
</script>

{#snippet statusMark(status: ToolActivity['status'])}
  {@const current = visibleActivityStatus(status, replyStatus)}
  <span class="tool-status" class:failed={current === 'error'} class:live={current === 'running'}>
    {#if current === 'running'}<LoaderCircle size={13} class="spinning" />
    {:else if current === 'complete'}<Check size={13} />
    {:else}<CircleAlert size={13} />{/if}{labels[current]}
  </span>
{/snippet}

{#snippet toolCard(tool: ToolActivity, nested = false)}
  {@const Icon = icons[tool.category]}
  <details
    class="tool-card"
    class:nested
    open={replyStatus === 'running' || tool.category === 'agent'}
    data-category={tool.category}
  >
    <summary>
      <Icon size={15} aria-hidden="true" />
      <span class="tool-title"
        >{tool.name}{#if tool.query || tool.path || tool.detail}<span
            class="query-preview"
            title={tool.query || tool.path || tool.detail}
            >{tool.query || tool.path || tool.detail}</span
          >{/if}</span
      >
      {@render statusMark(tool.status)}
      <ChevronDown size={13} class="disclosure" />
    </summary>
    <div class="tool-body">
      {#if tool.parentId && !nested}<p class="tool-note">
          By {tools.flatMap((t) => t.agents).find((a) => a.id === tool.parentId)?.name ??
            'sub-agent'}
        </p>{/if}
      {#if tool.query}<div class="metadata-label">
          {tool.operation === 'glob' || tool.operation === 'grep' ? 'Pattern' : 'Query'}
        </div>
        <p class="tool-query">{tool.query}</p>{/if}
      {#if tool.path}<div class="metadata-label">
          {tool.operation === 'glob' || tool.operation === 'grep' ? 'Folder' : 'Path'}
        </div>
        <code class="tool-path">{tool.path}</code>{/if}
      {#if tool.detail}<p>{tool.detail}</p>{/if}
      {#if tool.facts?.length}<dl class="tool-facts">
          {#each tool.facts as fact}<div>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>{/each}
        </dl>{/if}
      {#if !tool.query && !tool.path && !tool.detail && !tool.facts?.length && !tool.sources.length && !tool.agents.length}
        <p class="tool-note">
          {tool.status === 'running' && replyStatus === 'running'
            ? 'Waiting for tool details…'
            : 'No details were recorded for this tool call.'}
        </p>
      {/if}
      {#if tool.category === 'search' && !tool.sources.length && tool.status === 'complete'}
        <p class="tool-note">The provider did not include source links in this activity.</p>
      {/if}
      {#if tool.sources.length}<ul class="tool-sources">
          {#each tool.sources.filter((s) => safeSourceUrl(s.url)) as source}
            <li>
              <a
                href={safeSourceUrl(source.url)}
                onclick={(event) => visit(event, source.url)}
                title={source.url}
              >
                <span>{source.title || source.url}</span><ExternalLink
                  size={12}
                  aria-hidden="true"
                />
              </a>
            </li>
          {/each}
        </ul>{/if}
      {#each tool.agents as agent (agent.id)}
        <section class="subagent" aria-label={`Sub-agent: ${agent.name}`}>
          <div class="agent-heading">
            <GitBranch size={14} /><strong>{agent.name}</strong>{@render statusMark(agent.status)}
          </div>
          {#if agent.parentId && tool.agents.some((a) => a.id === agent.parentId)}
            <p class="tool-note">
              Delegated by {tool.agents.find((a) => a.id === agent.parentId)?.name}
            </p>
          {/if}
          {#if agent.task}<p class="agent-task">{agent.task}</p>{/if}
          {#each tools.filter((t) => t.parentId === agent.id) as child (child.id)}{@render toolCard(
              child,
              true,
            )}{/each}
          {#if agent.result}<details class="agent-result">
              <summary><ChevronDown size={12} />Result</summary>
              <p>{agent.result}</p>
            </details>{/if}
        </section>
      {/each}
    </div>
  </details>
{/snippet}

{#snippet timeline()}
  <div class="activity-timeline">
    {#each entries as entry}
      {#if entry.tool}
        {#if shown(entry.tool)}{@render toolCard(entry.tool)}{/if}
      {:else if replyStatus === 'running' || filter === 'all'}
        {#if entry.progress}
          <!-- Sanitized markdown; nested links provide keyboard interaction. -->
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="prose progress-message" onclick={progressLink}>
            {@html renderMarkdown(entry.text)}
          </div>
        {:else}<p class="timeline-note">{entry.text}</p>{/if}
      {/if}
    {/each}
    {#if replyStatus !== 'running' && filter !== 'all' && !tools.some(shown)}<p class="tool-note">
        No {filter === 'runs'
          ? 'command runs'
          : filter === 'agents'
            ? 'sub-agents'
            : filter === 'searches'
              ? 'web searches'
              : 'tool calls'} were recorded.
      </p>{/if}
  </div>
{/snippet}

{#if entries.length}
  <div
    class="tool-activity"
    class:live-activity={replyStatus === 'running'}
    aria-label="Tools and sub-agents"
  >
    {#if replyStatus === 'running'}{@render timeline()}
    {:else}
      <details class="activity-summary">
        <summary aria-label="Work history">
          <ChevronDown size={14} class="disclosure" />
          <span class="history-summary">
            <span class="history-title">Work history</span>
            <span
              class="summary-counts"
              title="Tool calls include web searches and command runs, including calls made by sub-agents. Sub-agents are counted separately."
            >
              {#if progressCount}<span
                  >{progressCount} progress {progressCount === 1 ? 'update' : 'updates'}</span
                >{/if}
              {#if tools.length}
                <span
                  >{counts.calls}{counts.limited ? '+' : ''} tool {counts.calls === 1
                    ? 'call'
                    : 'calls'}</span
                >
                <span>{counts.searches} web {counts.searches === 1 ? 'search' : 'searches'}</span>
                <span>{counts.agents} {counts.agents === 1 ? 'sub-agent' : 'sub-agents'}</span>
                <span>{counts.runs} command {counts.runs === 1 ? 'run' : 'runs'}</span>
              {/if}
            </span>
          </span>
          {#if replyStatus === 'cancelled'}<span class="tool-status">Stopped</span
            >{:else if replyStatus === 'error'}<span class="tool-status failed">Failed</span>{/if}
        </summary>
        {#if tools.length}<div class="activity-filters" aria-label="Filter activity">
            {#each filters as choice}<button
                class:chosen={filter === choice.id}
                aria-pressed={filter === choice.id}
                onclick={() => (filter = choice.id)}>{choice.label}</button
              >{/each}
          </div>{/if}
        {@render timeline()}
      </details>
    {/if}
    {#if linkError}<p role="alert">{linkError}</p>{/if}
  </div>
{/if}

<style>
  .tool-activity {
    margin: 14px 0;
    display: grid;
    gap: 7px;
    min-width: 0;
  }
  .tool-activity:not(.live-activity) {
    margin-top: 0;
  }
  .activity-timeline {
    display: grid;
    gap: 7px;
    min-width: 0;
  }
  .activity-summary > summary {
    display: flex;
    gap: 8px;
    align-items: center;
    cursor: pointer;
    list-style: none;
    padding: 8px 0;
    color: #a8b69f;
    font-size: 12px;
  }
  .summary-counts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    font-size: 11px;
  }
  .history-summary {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 12px;
    min-width: 0;
  }
  .history-title {
    color: #d3dfca;
    white-space: nowrap;
  }
  .activity-summary > summary > :global(svg) {
    flex-shrink: 0;
  }
  .summary-counts span {
    white-space: nowrap;
  }
  .activity-filters {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin: 8px 0 12px;
  }
  .activity-filters button {
    border: 1px solid #ffffff18;
    border-radius: 6px;
    background: transparent;
    color: #a8b69f;
    font-size: 11px;
    padding: 6px 9px;
    cursor: pointer;
  }
  .activity-filters button.chosen {
    color: #d3dfca;
    background: #ffffff0c;
  }
  .activity-filters button:focus-visible {
    outline: 2px solid #b9ddcc;
  }
  .timeline-note {
    font-size: 11px;
    color: #87947d;
    margin: 4px 0;
  }
  .progress-message {
    font-size: 13px;
  }
  .metadata-label,
  .tool-facts dt {
    font-size: 10px;
    color: #87947d;
    margin-top: 8px;
  }
  .tool-facts {
    margin: 6px 0;
  }
  .tool-facts dd {
    margin: 3px 0 8px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.6;
  }
  .live-activity .tool-card {
    background: transparent;
    border-color: #ffffff0d;
  }
  .tool-card {
    border: 1px solid #ffffff13;
    border-radius: 9px;
    background: #ffffff02;
    overflow: hidden;
  }
  .tool-card > summary {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 10px 12px;
    cursor: pointer;
    list-style: none;
    color: #bed2b2;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:focus-visible {
    outline: 2px solid #b9ddcc;
    outline-offset: -2px;
  }
  .tool-title {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .tool-status {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    color: #9bac91;
    font-size: 10px;
    flex-shrink: 0;
  }
  .tool-status.live {
    color: #b9ddcc;
  }
  .tool-status.failed {
    color: #efa19b;
  }
  .tool-body {
    padding: 0 12px 11px 35px;
    font-size: 12px;
    color: #a8b69f;
  }
  .tool-body p {
    margin: 6px 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.6;
  }
  .tool-query {
    color: #d3dfca;
  }
  .tool-path {
    display: block;
    font-size: 11px;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .tool-note {
    font-size: 11px;
    color: #87947d;
  }
  .tool-sources {
    padding: 0;
    margin: 8px 0 0;
    list-style: none;
    display: grid;
    gap: 5px;
  }
  .tool-sources a {
    display: inline-flex;
    gap: 6px;
    align-items: baseline;
    color: #b9ddcc;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .tool-sources a span {
    overflow-wrap: anywhere;
  }
  .tool-sources :global(svg) {
    flex-shrink: 0;
  }
  .query-preview {
    display: block;
    color: #8e9e85;
    margin-top: 2px;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .subagent {
    padding: 10px 0;
    border-top: 1px solid #ffffff0d;
  }
  .subagent:first-child {
    border-top: 0;
  }
  .agent-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 7px;
  }
  .agent-heading strong {
    flex: 1;
    min-width: 80px;
    font-weight: 500;
    overflow-wrap: anywhere;
    color: #d3dfca;
  }
  .agent-task {
    font-size: 11px;
  }
  .agent-result > summary {
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: 5px;
    cursor: pointer;
    padding: 5px 0;
  }
  .agent-result p {
    max-height: 280px;
    overflow: auto;
  }
  .nested {
    margin-top: 6px;
  }
  details[open] > summary :global(.disclosure) {
    transform: rotate(180deg);
  }
  @media (max-width: 1000px) {
    .tool-card > summary {
      flex-wrap: wrap;
      gap: 6px;
    }
    .tool-body {
      padding-left: 12px;
    }
    .tool-title {
      min-width: 100px;
    }
  }
</style>
