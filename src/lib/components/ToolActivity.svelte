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
    FileText,
    Pencil,
    Search,
    Terminal,
    Images,
  } from '@lucide/svelte';
  import { safeSourceUrl, visibleActivityStatus, type ToolActivity } from '$lib/activity';
  import { activityGroupSummary, groupActivityEntries } from '$lib/activity-groups';
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
  const labels = {
    running: 'Running',
    complete: 'Completed',
    error: 'Failed',
    cancelled: 'Stopped',
    unknown: 'Outcome unconfirmed',
  };
  const icons = { skill: Sparkles, search: Globe, agent: GitBranch, tool: Wrench };
  const groupIcons = {
    read: FileText,
    edit: Pencil,
    files: Search,
    command: Terminal,
    search: Globe,
    browse: Globe,
    agent: GitBranch,
    skill: Sparkles,
    image: Images,
    tool: Wrench,
  };
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
      .filter(
        (b) =>
          b.tool ||
          b.progress ||
          !['Starting the provider CLI', 'Connected to Claude'].includes(b.text.trim()),
      )
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
  const groups = $derived(groupActivityEntries(entries));
  function topLevel(tool: ToolActivity) {
    return !tool.parentId || !tools.some((p) => p.agents.some((a) => a.id === tool.parentId));
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
  <details class="tool-card" class:nested data-category={tool.category}>
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
    {#each groups as group (group.key)}
      {#if group.kind === 'tools'}
        {@const visible = group.tools.filter(topLevel)}
        {#if visible.length}
          {@const summary = activityGroupSummary(visible, replyStatus, tools)}
          {@const Icon = groupIcons[summary.icon]}
          <details class="activity-group">
            <summary title="Expand for tool details">
              {#if summary.running}<LoaderCircle size={16} class="spinning" aria-label="Running" />
              {:else}<Icon size={16} aria-hidden="true" />{/if}
              <span class="group-label">{summary.label}</span>
              {#if summary.issue}{@render statusMark(summary.issue)}{/if}
              <ChevronDown size={13} class="disclosure" aria-hidden="true" />
            </summary>
            <div class="group-tools">
              {#each visible as tool (tool.id)}{@render toolCard(tool)}{/each}
            </div>
          </details>
        {/if}
      {:else}
        {@const entry = group.entry}
        {#if entry.progress}
          <!-- Sanitized markdown; nested links provide keyboard interaction. -->
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="prose progress-message" onclick={progressLink}>
            {@html renderMarkdown(entry.text)}
          </div>
        {:else}<p class="timeline-note">{entry.text}</p>{/if}
      {/if}
    {/each}
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
          <span class="history-title">Work history</span>
          {#if replyStatus === 'cancelled'}<span class="tool-status">Stopped</span
            >{:else if replyStatus === 'error'}<span class="tool-status failed">Failed</span>{/if}
        </summary>
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
    gap: 12px;
    min-width: 0;
  }
  .activity-group {
    min-width: 0;
  }
  .activity-group > summary {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 7px;
    padding: 7px 0;
    list-style: none;
    cursor: pointer;
    color: var(--muted);
    font-size: 13px;
  }
  .activity-group > summary:hover {
    color: var(--text);
  }
  .activity-group > summary > :global(svg) {
    flex-shrink: 0;
  }
  .group-label {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .group-tools {
    display: grid;
    gap: 3px;
    margin: 5px 0 7px 7px;
    padding-left: 12px;
    border-left: 1px solid var(--line);
    min-width: 0;
  }
  .activity-summary[open] {
    border-bottom: 1px solid var(--line);
    padding-bottom: 14px;
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
  .history-title {
    color: #d3dfca;
    white-space: nowrap;
  }
  .activity-summary > summary > :global(svg) {
    flex-shrink: 0;
  }
  .timeline-note {
    font-size: 11px;
    color: #87947d;
    margin: 4px 0;
  }
  .progress-message {
    font-size: 13px;
  }
  .progress-message > :global(:last-child) {
    margin-bottom: 0;
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
  .tool-card {
    min-width: 0;
    overflow: hidden;
  }
  .tool-card > summary {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 7px 0;
    cursor: pointer;
    list-style: none;
    color: #a8b69f;
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
    padding: 0 8px 11px 23px;
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
