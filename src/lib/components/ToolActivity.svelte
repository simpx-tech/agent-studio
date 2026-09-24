<script lang="ts">
  import {
    Brain,
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
    Webhook,
    Layers,
  } from '@lucide/svelte';
  import {
    safeSourceUrl,
    activityDisplayStatus,
    toolDisplayStatus,
    toolElapsed,
    toolProgressLabel,
    type ActivityDisplayStatus,
    type ToolActivity,
  } from '$lib/activity';
  import {
    activityEntries,
    activityGroupSummary,
    groupActivityEntries,
  } from '$lib/activity-groups';
  import type { Message, ContentBlock } from '$lib/domain';
  import { renderMarkdown } from '$lib/markdown';
  import { openLink } from '$lib/transport';
  import { revealedDisclosures } from '$lib/disclosures';
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
    blocked: 'Blocked',
    cancelled: 'Stopped',
    unknown: 'Outcome unconfirmed',
    background: 'In background',
    left: 'Left running',
  };
  const icons = { skill: Sparkles, search: Globe, agent: GitBranch, tool: Wrench, hook: Webhook };
  const groupIcons = {
    hook: Webhook,
    hookContext: Webhook,
    read: FileText,
    edit: Pencil,
    files: Search,
    command: Terminal,
    search: Globe,
    browse: Globe,
    agent: GitBranch,
    background: Layers,
    backgroundAgent: GitBranch,
    message: GitBranch,
    directory: GitBranch,
    skill: Sparkles,
    image: Images,
    tool: Wrench,
    limit: Wrench,
  };
  const entries = $derived(activityEntries(blocks, tools, finalText));
  const groups = $derived(groupActivityEntries(entries));
  const disclosures = revealedDisclosures();
  function topLevel(tool: ToolActivity) {
    return !tool.parentId || !tools.some((p) => p.agents.some((a) => a.id === tool.parentId));
  }
  function backgroundNote(tool: ToolActivity) {
    if (tool.status !== 'running') return 'Ran in the background.';
    return replyStatus === 'running'
      ? 'Running in the background while the reply continues. Background work at the end of this reply tracks it.'
      : 'Still running in the background when this reply ended. Its later outcome was not recorded.';
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

{#snippet statusMark(current: ActivityDisplayStatus)}
  <span
    class="tool-status"
    class:failed={current === 'error' || current === 'blocked'}
    class:live={current === 'running'}
  >
    {#if current === 'running'}<LoaderCircle size={13} class="spinning" />
    {:else if current === 'complete'}<Check size={13} />
    {:else if current === 'background' || current === 'left'}<Layers size={13} />
    {:else}<CircleAlert size={13} />{/if}{labels[current]}
  </span>
{/snippet}

{#snippet toolCard(tool: ToolActivity, nested = false)}
  {@const Icon = icons[tool.category]}
  {@const status = toolDisplayStatus(tool, replyStatus)}
  {@const preview =
    tool.category === 'hook'
      ? tool.path || tool.facts?.find((fact) => fact.label === 'Hook')?.value
      : tool.query || tool.path || tool.detail}
  <details
    class="tool-card"
    class:nested
    data-category={tool.category}
    ontoggle={disclosures.opened(`tool:${tool.id}`)}
  >
    <summary onclick={disclosures.reveal(`tool:${tool.id}`)}>
      <Icon size={15} aria-hidden="true" />
      <span class="tool-title"
        >{tool.name}{#if preview}<span class="query-preview" title={preview}>{preview}</span
          >{/if}</span
      >
      <span class="tool-state">
        <!-- Background work at the end of the reply shows its running time, not here. -->
        {#if tool.elapsedMs != null && status !== 'background' && status !== 'left'}<span
            class="tool-elapsed"
            title="Elapsed time recorded on the execution computer"
            aria-label={`Tool elapsed time: ${toolElapsed(tool.elapsedMs)}`}
            >{toolElapsed(tool.elapsedMs)}</span
          >{/if}
        {@render statusMark(status)}
      </span>
      <ChevronDown size={13} class="disclosure" />
    </summary>
    {#if disclosures.has(`tool:${tool.id}`)}<div class="tool-body">
        {#if tool.progress}<p
            class="tool-progress"
            title="Only progress metadata is recorded. Tool output and terminal input remain private."
          >
            {toolProgressLabel(tool)} at {toolElapsed(tool.progress.atElapsedMs)}
          </p>{/if}
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
        {#if tool.background}<p class="tool-note">{backgroundNote(tool)}</p>{/if}
        {#if tool.facts?.length}<dl class="tool-facts">
            {#each tool.facts as fact}<div>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>{/each}
          </dl>{/if}
        {#if !tool.query && !tool.path && !tool.detail && !tool.background && !tool.facts?.length && !tool.sources.length && !tool.agents.length}
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
              <GitBranch size={14} /><strong>{agent.name}</strong>{@render statusMark(
                activityDisplayStatus(agent, replyStatus),
              )}
            </div>
            {#if agent.parentId && tool.agents.some((a) => a.id === agent.parentId)}
              <p class="tool-note">
                Delegated by {tool.agents.find((a) => a.id === agent.parentId)?.name}
              </p>
            {/if}
            {#if agent.task}<p class="agent-task">{agent.task}</p>{/if}
            {#if agent.messages?.length}<details
                class="agent-result"
                ontoggle={disclosures.opened(`messages:${agent.id}`)}
              >
                <summary onclick={disclosures.reveal(`messages:${agent.id}`)}
                  ><ChevronDown size={12} />Messages</summary
                >
                {#if disclosures.has(`messages:${agent.id}`)}
                  {#each agent.messages as message (message.id)}
                    <p>{message.text}</p>
                    {#if !message.complete && replyStatus !== 'running'}<p class="tool-note">
                        Message incomplete
                      </p>{/if}
                  {/each}
                  {#if agent.messagesTruncated}<p class="tool-note">
                      Additional child text was omitted at the activity limit.
                    </p>{/if}
                {/if}
              </details>{/if}
            {#each tools.filter((t) => t.parentId === agent.id) as child (child.id)}{@render toolCard(
                child,
                true,
              )}{/each}
            {#if agent.result}<details
                class="agent-result"
                ontoggle={disclosures.opened(`result:${agent.id}`)}
              >
                <summary onclick={disclosures.reveal(`result:${agent.id}`)}
                  ><ChevronDown size={12} />Result</summary
                >
                {#if disclosures.has(`result:${agent.id}`)}<p>{agent.result}</p>{/if}
              </details>{/if}
          </section>
        {/each}
      </div>{/if}
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
          {@const active = group.tools.filter(
            (tool) => tool.status === 'running' && !tool.background,
          )}
          {@const elapsed = Math.max(-1, ...active.map((tool) => tool.elapsedMs ?? -1))}
          {@const progressTool = active.findLast((tool) => tool.progress)}
          <details class="activity-group" ontoggle={disclosures.opened(group.key)}>
            <summary title="Expand for tool details" onclick={disclosures.reveal(group.key)}>
              {#if summary.running}<LoaderCircle size={16} class="spinning" aria-label="Running" />
              {:else}<Icon size={16} aria-hidden="true" />{/if}
              <span class="group-label">{summary.label}</span>
              {#if summary.running && elapsed >= 0}<span class="group-progress">
                  {#if progressTool}<span>{toolProgressLabel(progressTool)}</span>{/if}
                  <span
                    class="tool-elapsed"
                    title="Longest currently running tool; parallel times are not added"
                    aria-label={`Longest running tool: ${toolElapsed(elapsed)}`}
                    >{toolElapsed(elapsed)}</span
                  >
                </span>{/if}
              {#if summary.issue}{@render statusMark(summary.issue)}{/if}
              <ChevronDown size={13} class="disclosure" aria-hidden="true" />
            </summary>
            {#if disclosures.has(group.key)}<div class="group-tools">
                {#each visible as tool (tool.id)}{@render toolCard(tool)}{/each}
              </div>{/if}
          </details>
        {/if}
      {:else if group.kind === 'reasoning'}
        <div class="reasoning-entry" role="group" aria-label="Reasoning">
          <span class="reasoning-mark" title="Reasoning reported by the provider"
            ><Brain size={16} aria-hidden="true" /></span
          >
          <div class="reasoning-body">
            <!-- Sanitized markdown; nested links provide keyboard interaction. -->
            <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
            <div class="prose reasoning-text" onclick={progressLink}>
              {@html renderMarkdown(group.block.text)}
            </div>
            {#if group.block.truncated}<p class="tool-note">
                Reasoning display limit reached. This section is incomplete.
              </p>{/if}
          </div>
        </div>
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
    aria-label="Tools, hooks and sub-agents"
  >
    {#if replyStatus === 'running'}{@render timeline()}
    {:else}
      <details class="activity-summary" ontoggle={disclosures.opened('history')}>
        <summary aria-label="Work history" onclick={disclosures.reveal('history')}>
          <ChevronDown size={14} class="disclosure" />
          <span class="history-title">Work history</span>
          {#if replyStatus === 'cancelled'}<span class="tool-status">Stopped</span
            >{:else if replyStatus === 'error'}<span class="tool-status failed">Failed</span>{/if}
        </summary>
        {#if disclosures.has('history')}{@render timeline()}{/if}
      </details>
    {/if}
    {#if linkError}<p role="alert">{linkError}</p>{/if}
  </div>
{/if}

<style>
  .tool-activity {
    margin: 10px 0 14px;
    display: grid;
    gap: 6px;
    min-width: 0;
  }
  .tool-activity:not(.live-activity) {
    margin-top: 0;
  }
  .activity-timeline {
    display: grid;
    gap: 8px;
    min-width: 0;
  }
  .activity-group {
    min-width: 0;
  }
  .activity-group > summary {
    display: flex;
    align-items: center;
    /* A long label wraps its text beside the icon and chevron instead of taking a line alone. */
    flex-wrap: nowrap;
    gap: 8px;
    width: fit-content;
    max-width: 100%;
    padding: 4px 8px 4px 6px;
    margin-left: -6px;
    border-radius: var(--radius-md);
    list-style: none;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: var(--text-base);
    transition:
      background-color var(--duration-fast) ease,
      color var(--duration-fast) ease;
  }
  .activity-group > summary:hover {
    background: var(--hover);
    color: var(--text);
  }
  .activity-group > summary > :global(svg) {
    flex-shrink: 0;
    color: var(--text-muted);
  }
  .activity-group > summary > :global(.disclosure) {
    color: var(--text-faint);
  }
  .activity-group[open] > summary {
    width: 100%;
  }
  .group-label {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .group-progress,
  .tool-state {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .group-progress {
    /* Progress takes the space left beside the label and wraps first on narrow screens. */
    flex: 1 0 0;
    margin-left: auto;
    justify-content: flex-end;
    text-align: right;
  }
  .activity-group:not([open]) .group-progress {
    margin-left: 4px;
  }
  .tool-elapsed {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .group-tools {
    display: grid;
    gap: 2px;
    margin: 4px 0 6px 8px;
    padding-left: 14px;
    border-left: 1px solid var(--border-strong);
    min-width: 0;
  }
  .activity-summary[open] {
    border-bottom: 1px solid var(--border);
    padding-bottom: 14px;
    margin-bottom: 4px;
  }
  .activity-summary > summary {
    display: flex;
    gap: 7px;
    align-items: center;
    width: fit-content;
    cursor: pointer;
    list-style: none;
    padding: 4px 8px 4px 6px;
    margin-left: -6px;
    border-radius: var(--radius-md);
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: 500;
    transition:
      background-color var(--duration-fast) ease,
      color var(--duration-fast) ease;
  }
  .activity-summary > summary:hover {
    background: var(--hover);
    color: var(--text);
  }
  .activity-summary[open] > summary {
    margin-bottom: 8px;
  }
  .history-title {
    white-space: nowrap;
  }
  .activity-summary > summary > :global(svg) {
    flex-shrink: 0;
  }
  .timeline-note {
    font-size: var(--text-xs);
    color: var(--text-faint);
    margin: 2px 0;
  }
  .progress-message {
    color: var(--text-secondary);
  }
  .progress-message > :global(:last-child) {
    margin-bottom: 0;
  }
  /* Reasoning reads as quieter prose beside a brain mark, aligned with tool group labels. */
  .reasoning-entry {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr);
    gap: 8px;
    min-width: 0;
    font-size: var(--text-base);
    line-height: var(--leading-prose);
  }
  .reasoning-mark {
    display: flex;
    align-items: center;
    height: calc(1em * var(--leading-prose));
    color: var(--text-faint);
  }
  .reasoning-body {
    min-width: 0;
  }
  .reasoning-text {
    font-size: inherit;
    color: var(--text-muted);
  }
  .reasoning-text > :global(:first-child) {
    margin-top: 0;
  }
  .reasoning-text > :global(:last-child) {
    margin-bottom: 0;
  }
  .metadata-label,
  .tool-facts dt {
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-muted);
    margin-top: 8px;
  }
  .tool-facts {
    margin: 6px 0;
  }
  .tool-facts dd {
    margin: 2px 0 8px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: var(--leading-normal);
    color: var(--text-secondary);
  }
  .tool-card {
    min-width: 0;
    overflow: hidden;
  }
  .tool-card > summary {
    display: flex;
    gap: 9px;
    align-items: center;
    padding: 5px 8px;
    border-radius: var(--radius-md);
    cursor: pointer;
    list-style: none;
    color: var(--text-secondary);
    transition: background-color var(--duration-fast) ease;
  }
  .tool-card > summary:hover {
    background: var(--hover);
  }
  .tool-card > summary > :global(svg) {
    color: var(--text-muted);
  }
  .tool-card > summary > :global(.disclosure) {
    color: var(--text-faint);
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 0;
  }
  .tool-title {
    flex: 1;
    min-width: 0;
    font-size: var(--text-sm);
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .tool-status {
    display: inline-flex;
    gap: 4px;
    align-items: center;
    color: var(--text-muted);
    font-size: var(--text-xs);
    flex-shrink: 0;
  }
  .tool-status.live {
    color: var(--accent-text);
  }
  .tool-status.failed {
    color: var(--danger);
  }
  .tool-body {
    padding: 2px 8px 10px 32px;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .tool-body p {
    margin: 6px 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: var(--leading-normal);
    color: inherit;
  }
  .tool-query {
    color: var(--text);
  }
  .tool-path {
    display: block;
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
    white-space: pre-wrap;
    color: var(--text);
  }
  .tool-note,
  .tool-body .tool-note {
    font-size: var(--text-xs);
    color: var(--text-muted);
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
    color: var(--accent-text);
    text-decoration: underline;
    text-decoration-color: var(--accent-border);
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
    color: var(--text-muted);
    margin-top: 1px;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-weight: 400;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .subagent {
    padding: 10px 0;
    border-top: 1px solid var(--border);
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
    color: var(--text);
  }
  .agent-task {
    font-size: var(--text-xs);
  }
  .agent-result > summary {
    font-size: var(--text-xs);
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 5px;
    width: fit-content;
    cursor: pointer;
    padding: 5px 0;
    color: var(--text-muted);
  }
  .agent-result > summary:hover {
    color: var(--text);
  }
  .agent-result p {
    max-height: 280px;
    overflow: auto;
  }
  .nested {
    margin-top: 6px;
  }
  :global(.disclosure) {
    transition: transform var(--duration) var(--ease-out);
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
