<script lang="ts">
  import {
    RotateCcw,
    CircleAlert,
    ArrowRightLeft,
    PanelsTopLeft,
    PanelRightOpen,
    GitFork,
    Rewind,
    Undo2,
    LoaderCircle,
    Hourglass,
    MessageCircleQuestionMark,
  } from '@lucide/svelte';
  import { messageText, providers, type Message, type ChatSettings } from '$lib/domain';
  import { awaitingAnswer } from '$lib/questions';
  import { replyContent, highlightCode } from '$lib/markdown';
  import { openLink } from '$lib/transport';
  import { replyModelMismatch, replyModelName, type ReplyTimeTotal } from '$lib/replies';
  import { modelMark } from '$lib/model-marks';
  import ModelMark from './ModelMark.svelte';
  import { summarizeFileChanges, type ChangeSummary } from '$lib/file-changes';
  import ToolActivity from './ToolActivity.svelte';
  import { compactionLabel } from '$lib/compaction';
  import ReplyFooter from './ReplyFooter.svelte';
  import ImageAttachments from './ImageAttachments.svelte';
  import type { BackgroundRun } from '$lib/background-work';
  import { replyTools, runningSubagents } from '$lib/subagents';
  import VisualizationView from './VisualizationView.svelte';
  import SentFilesView from './SentFilesView.svelte';
  import QuestionForm from './QuestionForm.svelte';
  import PlanApproval from './PlanApproval.svelte';
  import ProposedPlan from './ProposedPlan.svelte';
  import ElicitationForm from './ElicitationForm.svelte';
  import { messageArtifacts, type Artifact } from '$lib/artifacts';
  let {
    message,
    agent,
    retry,
    rewind,
    undoEdits,
    historyDisabled = false,
    canRetry = false,
    retryDisabled = false,
    switchNotice = '',
    timeTotal,
    chatChanges,
    folder,
    openArtifact,
    fork,
    forkDisabled = false,
    background = [],
    openSubagent,
    openedSubagent,
    idle = false,
  }: {
    message: Message;
    agent: ChatSettings;
    retry: () => void;
    rewind?: () => void;
    undoEdits?: () => void;
    historyDisabled?: boolean;
    canRetry?: boolean;
    retryDisabled?: boolean;
    switchNotice?: string;
    timeTotal?: ReplyTimeTotal;
    chatChanges?: ChangeSummary;
    folder?: string;
    openArtifact: (artifact: Artifact, mode?: 'modal' | 'panel') => void;
    fork?: () => void;
    forkDisabled?: boolean;
    /** Background work this reply started that still runs. */
    background?: BackgroundRun[];
    /** Opens one of this reply's sub-agents in the side panel. */
    openSubagent?: (agentId: string) => void;
    /** This reply's sub-agent whose conversation the side panel shows. */
    openedSubagent?: string;
    /** It runs, but its turn ended and it only waits for background work. */
    idle?: boolean;
  } = $props();
  const responseChanges = $derived(summarizeFileChanges([message]));
  let linkError = $state('');
  const author = $derived(message.settings ?? agent);
  // The model that ran, as the picker shows it: its version on its family's tint.
  const mark = $derived(modelMark(author.provider, replyModelName(message)));
  const mismatch = $derived(message.role === 'assistant' ? replyModelMismatch(message) : undefined);
  const text = $derived(
    messageText(message) ||
      (message.status !== 'running' &&
      !message.proposedPlans?.length &&
      !message.settings?.outputSchema
        ? (message.blocks.filter((b) => b.type === 'activity' && b.progress).at(-1)?.text ?? '')
        : ''),
  );
  const tools = $derived(replyTools(message));
  const subagents = $derived(runningSubagents(tools, message.status));
  const artifacts = $derived(messageArtifacts(message));
  const structured = $derived(!!message.settings?.outputSchema && !message.compact);
  // A structured reply's text is its JSON, shown whole above; its visuals and files follow it.
  const content = $derived(
    replyContent(structured ? '' : text, message.visualizations, message.sentFiles),
  );
  const jsonHighlight = $derived(structured ? highlightCode(text, 'json') : null);
  const waiting = $derived(awaitingAnswer(message));
  function linkClick(event: MouseEvent) {
    const link = (event.target as Element).closest('a');
    if (link) {
      event.preventDefault();
      void openLink(link.href).catch(() => (linkError = 'Could not open this link.'));
    }
  }
</script>

<article
  class="message"
  class:user={message.role === 'user'}
  data-testid="message"
  data-message-id={message.id}
  data-status={message.status}
>
  {#if switchNotice && message.role === 'assistant'}
    <p class="reply-switch" role="status">
      <ArrowRightLeft size={13} aria-hidden="true" />{switchNotice}
    </p>
  {/if}
  {#if message.role === 'user'}
    <div class="message-avatar" style:--provider-color={providers[author.provider].color}>Y</div>
  {:else}
    <div class="message-avatar model"><ModelMark {mark} variant="tile" /></div>
  {/if}
  <div class="message-content">
    <div class="message-heading">
      <strong>{message.role === 'user' ? 'You' : replyModelName(message)}</strong><span
        >{new Date(message.createdAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}</span
      >{#if message.status === 'running'}<span
          class="live-label"
          class:waiting
          class:idle={!waiting && idle}
          title={!waiting && idle
            ? 'Claude’s turn ended and it waits for background work to report. A message you send now goes at once.'
            : undefined}
          >{#if waiting}<MessageCircleQuestionMark size={13} aria-hidden="true" />Waiting for you{:else if idle}<Hourglass
              size={13}
              aria-hidden="true"
            />Waiting for background work{:else}<LoaderCircle
              size={13}
              class="spinning"
              aria-hidden="true"
            />{message.compact || message.compactions?.at(-1)?.status === 'running'
              ? 'Compacting context'
              : 'Responding'}{/if}</span
        >{/if}
    </div>
    {#if mismatch}<p
        class="model-mismatch"
        title={`The Model picker showed ${mismatch.picked} when this reply was sent, but Claude Code reported ${mismatch.ran}. An older Claude Code maps Opus, Sonnet, Fable and Haiku to older models, and a fallback model answers when the chosen one is unavailable.`}
      >
        <CircleAlert size={13} aria-hidden="true" />Ran {mismatch.ran} instead of {mismatch.picked}
      </p>{/if}
    {#if message.role === 'user'}
      {#if message.images?.length}<ImageAttachments images={message.images} />{/if}
      {#if text}<div class="user-text">{text}</div>{/if}
    {:else}
      <ToolActivity
        {tools}
        replyStatus={message.status}
        blocks={message.blocks}
        finalText={text}
        runId={message.runId}
        connectionId={author.connectionId}
        {folder}
        fileChanges={message.fileChanges}
        {openSubagent}
        {openedSubagent}
      />
      {#if message.compactions?.length}
        <div class="compaction-history" aria-label="Context compaction">
          {#each message.compactions as item (item.id)}
            <p role="status">
              {compactionLabel(item, message.status)}{#if item.preTokens != null}
                <span
                  >{` · ${item.preTokens.toLocaleString()} tokens before${item.postTokens != null ? ` → ${item.postTokens.toLocaleString()} after` : ''}`}</span
                >
              {/if}
            </p>
          {/each}
        </div>
      {/if}
      {#if message.steering?.length}
        <div class="steering-history" aria-label="Steering messages">
          {#each message.steering as input (input.id)}
            <div class="steering-message">
              <small>You · Steered this reply</small>
              <p>{input.text}</p>
            </div>
          {/each}
        </div>
      {/if}
      {#if structured && text}
        <div class="prose" aria-label="Structured output">
          <pre><code class="hljs language-json">{#if jsonHighlight}{@html jsonHighlight.html}{:else}{text}{/if}</code></pre>
        </div>
      {/if}
      {#each content as part (part.key)}
        {#if part.type === 'visual'}
          <VisualizationView visual={part.visual} messageId={message.id} {openArtifact} />
        {:else if part.type === 'files'}
          <SentFilesView groups={part.groups} connectionId={author.connectionId} />
        {:else}
          <!-- Links are handled at this boundary; sanitized output is restricted to presentation tags. -->
          <!-- Nested anchors provide keyboard behavior; their click events bubble here. -->
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="prose" onclick={linkClick}>{@html part.html}</div>
        {/if}
      {/each}
      {#each message.questions ?? [] as request (request.id)}
        {#if request.planApproval}
          <PlanApproval
            {request}
            runId={message.runId}
            connectionId={author.connectionId}
            running={message.status === 'running'}
          />
        {:else}
          <QuestionForm
            {request}
            runId={message.runId}
            connectionId={author.connectionId}
            running={message.status === 'running'}
          />
        {/if}
      {/each}
      {#each message.proposedPlans ?? [] as proposal (proposal.id)}
        <ProposedPlan
          text={proposal.text}
          complete={proposal.complete}
          truncated={proposal.truncated}
          running={message.status === 'running'}
        />
      {/each}
      {#each message.elicitations ?? [] as receipt (receipt.id)}
        <ElicitationForm
          {receipt}
          runId={message.runId}
          connectionId={author.connectionId}
          running={message.status === 'running'}
        />
      {/each}
      {#if !content.length && !(structured && text) && message.status === 'running' && !message.blocks.length}<div
          class="reply-waiting"
        >
          <span></span><span></span><span></span><small>Making room for a good answer…</small>
        </div>{/if}
      {#if message.error}<div class="message-error" role="status">
          <CircleAlert size={15} />{message.error}
        </div>{/if}
      {#if message.status === 'cancelled' && !message.error}<p class="muted small">
          Response stopped. Partial text has been kept.
        </p>{/if}
      {#if artifacts.length}<div class="response-extras">
          <div class="response-artifacts" aria-label="Response artifacts">
            {#each artifacts as artifact (artifact.id)}<div class="artifact-card">
                <button
                  class="secondary artifact-open"
                  onclick={() => openArtifact(artifact, 'modal')}
                  ><PanelsTopLeft size={16} /><span>{artifact.title}</span><small
                    >Open {artifact.language.toUpperCase()}</small
                  ></button
                ><button
                  class="secondary artifact-side"
                  aria-label={`Open ${artifact.title} in side panel`}
                  title="Open in side panel"
                  onclick={() => openArtifact(artifact, 'panel')}
                  ><PanelRightOpen size={16} /></button
                >
              </div>{/each}
          </div>
        </div>{/if}
      <!-- Elapsed time, then plan, workflow, sub-agent and background work toggles in the same row. -->
      <ReplyFooter
        {message}
        {timeTotal}
        {responseChanges}
        chatChanges={chatChanges ?? responseChanges}
        {folder}
        {background}
        {subagents}
        {openSubagent}
        {openedSubagent}
      />
      {#if message.status !== 'running' && (fork || (canRetry && !message.workflowDefinition) || linkError || undoEdits || message.filesUndone)}<div
          class="message-actions"
        >
          {#if linkError}<span role="alert">{linkError}</span>{/if}
          {#if message.filesUndone}<span class="muted">File edits undone</span>
          {:else if undoEdits}<button
              class="text-button"
              disabled={historyDisabled}
              onclick={undoEdits}><Undo2 size={13} />Undo edits</button
            >{/if}
          {#if fork}<button
              class="text-button"
              onclick={fork}
              disabled={forkDisabled}
              title="Start a separate chat through this reply"
              ><GitFork size={13} />Fork from here</button
            >{/if}
          {#if canRetry && !message.workflowDefinition}<button
              class="text-button"
              onclick={retry}
              disabled={retryDisabled}><RotateCcw size={13} />Retry</button
            >{/if}
        </div>{/if}
    {/if}
  </div>
  {#if message.role === 'user' && rewind}<div class="message-actions user-actions">
      <button class="text-button" disabled={historyDisabled} onclick={rewind}
        ><Rewind size={13} />Rewind here</button
      >
    </div>{/if}
</article>

<style>
  /* Quiet below your bubble until hovered or focused; always shown on touch screens. */
  .user-actions {
    margin-top: 4px;
    opacity: 0;
    transition: opacity var(--duration-fast) ease;
  }
  .message.user:hover .user-actions,
  .message.user:focus-within .user-actions {
    opacity: 1;
  }
  @media (hover: none) {
    .user-actions {
      opacity: 1;
    }
  }
  .compaction-history {
    margin: 8px 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .compaction-history p {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0;
    color: inherit;
  }
  .compaction-history p::before {
    content: '';
    flex: 0 0 14px;
    height: 1px;
    background: var(--border-strong);
  }
  .steering-history {
    margin-block: 10px;
  }
  .steering-message {
    border-left: 2px solid var(--accent-border);
    padding: 3px 12px;
    margin-block: 8px;
  }
  .steering-message p {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin: 2px 0;
    font-size: var(--text-base);
    color: var(--text);
  }
  .response-extras {
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    gap: 8px;
    margin: 16px 0 4px;
  }
  .response-artifacts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    flex: 1 1 auto;
  }
  .artifact-card {
    display: flex;
    flex: 1 1 auto;
    min-width: 0;
    max-width: 100%;
  }
  .artifact-open {
    flex: 1;
    min-width: 0;
    justify-content: flex-start;
    text-align: left;
    border-radius: var(--radius-lg) 0 0 var(--radius-lg);
  }
  .artifact-open > :global(svg) {
    color: var(--accent-strong);
  }
  .artifact-side {
    flex-shrink: 0;
    margin-left: -1px;
    border-radius: 0 var(--radius-lg) var(--radius-lg) 0;
    padding-inline: 10px;
    color: var(--text-muted);
  }
  .response-artifacts span {
    overflow-wrap: anywhere;
    min-width: 0;
  }
  small {
    margin-left: auto;
    padding-left: 8px;
    color: var(--text-muted);
    font-size: var(--text-2xs);
    font-weight: 500;
    white-space: nowrap;
  }
</style>
