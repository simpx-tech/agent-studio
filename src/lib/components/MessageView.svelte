<script lang="ts">
  import {
    RotateCcw,
    CircleAlert,
    ArrowRightLeft,
    PanelsTopLeft,
    PanelRightOpen,
  } from '@lucide/svelte';
  import { messageText, providers, type Message, type ChatSettings } from '$lib/domain';
  import { replyContent } from '$lib/markdown';
  import { openLink } from '$lib/transport';
  import { replyModelName, type ReplyTimeTotal } from '$lib/replies';
  import { summarizeFileChanges, type ChangeSummary } from '$lib/file-changes';
  import ToolActivity from './ToolActivity.svelte';
  import ReplyFooter from './ReplyFooter.svelte';
  import RunningReplyTime from './RunningReplyTime.svelte';
  import ImageAttachments from './ImageAttachments.svelte';
  import PlanPanel from './PlanPanel.svelte';
  import VisualizationView from './VisualizationView.svelte';
  import QuestionForm from './QuestionForm.svelte';
  import { messageArtifacts, type Artifact } from '$lib/artifacts';
  let {
    message,
    agent,
    retry,
    canRetry = false,
    retryDisabled = false,
    switchNotice = '',
    timeTotal,
    chatChanges,
    folder,
    openArtifact,
  }: {
    message: Message;
    agent: ChatSettings;
    retry: () => void;
    canRetry?: boolean;
    retryDisabled?: boolean;
    switchNotice?: string;
    timeTotal?: ReplyTimeTotal;
    chatChanges?: ChangeSummary;
    folder?: string;
    openArtifact: (artifact: Artifact, mode?: 'modal' | 'panel') => void;
  } = $props();
  const responseChanges = $derived(summarizeFileChanges([message]));
  let linkError = $state('');
  const author = $derived(message.settings ?? agent);
  const text = $derived(
    messageText(message) ||
      (message.status !== 'running'
        ? (message.blocks.filter((b) => b.type === 'activity' && b.progress).at(-1)?.text ?? '')
        : ''),
  );
  const tools = $derived(
    message.blocks.flatMap((b) => (b.type === 'activity' && b.tool ? [b.tool] : [])),
  );
  const artifacts = $derived(messageArtifacts(message));
  const content = $derived(replyContent(text, message.visualizations));
  const savedProgress = $derived(
    message.role === 'assistant' &&
      message.status !== 'running' &&
      (message.plan ||
        message.workflow ||
        message.nativeWorkflows?.runs.length ||
        message.nativeWorkflows?.limited),
  );
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
  data-status={message.status}
>
  {#if switchNotice && message.role === 'assistant'}
    <p class="reply-switch" role="status">
      <ArrowRightLeft size={13} aria-hidden="true" />{switchNotice}
    </p>
  {/if}
  <div class="message-avatar" style:--provider-color={providers[author.provider].color}>
    {message.role === 'user' ? 'Y' : providers[author.provider].mark}
  </div>
  <div class="message-content">
    <div class="message-heading">
      <strong>{message.role === 'user' ? 'You' : replyModelName(message)}</strong><span
        >{new Date(message.createdAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        })}</span
      >{#if message.status === 'running'}<span class="live-label"
          ><i class="pulse-dot"></i>
          {message.questions?.some((q) => q.status === 'pending')
            ? 'Waiting for you'
            : 'Responding'}</span
        >{/if}
    </div>
    {#if message.role === 'user'}
      {#if message.images?.length}<ImageAttachments images={message.images} />{/if}
      {#if text}<div class="user-text">{text}</div>{/if}
    {:else}
      <ToolActivity {tools} replyStatus={message.status} blocks={message.blocks} finalText={text} />
      {#each content as part (part.key)}
        {#if part.type === 'visual'}
          <VisualizationView visual={part.visual} messageId={message.id} {openArtifact} />
        {:else}
          <!-- Links are handled at this boundary; sanitized output is restricted to presentation tags. -->
          <!-- Nested anchors provide keyboard behavior; their click events bubble here. -->
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="prose" onclick={linkClick}>{@html part.html}</div>
        {/if}
      {/each}
      {#each message.questions ?? [] as request (request.id)}
        <QuestionForm
          {request}
          runId={message.runId}
          connectionId={author.connectionId}
          running={message.status === 'running'}
        />
      {/each}
      {#if !content.length && message.status === 'running' && !message.blocks.length}<div
          class="thinking"
        >
          <span></span><span></span><span></span><small>Making room for a good answer…</small>
        </div>{/if}
      {#if message.error}<div class="message-error" role="status">
          <CircleAlert size={15} />{message.error}
        </div>{/if}
      {#if message.status === 'cancelled' && !message.error}<p class="muted small">
          Response stopped. Partial text has been kept.
        </p>{/if}
      {#if artifacts.length || savedProgress}<div class="response-extras">
          {#if savedProgress}<PlanPanel {message} compact />{/if}
          {#if artifacts.length}<div class="response-artifacts" aria-label="Response artifacts">
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
            </div>{/if}
        </div>{/if}
      {#if message.status === 'running'}
        <RunningReplyTime createdAt={message.createdAt} />
      {:else}
        <ReplyFooter
          {message}
          {timeTotal}
          {responseChanges}
          chatChanges={chatChanges ?? responseChanges}
          {folder}
        />
      {/if}
      {#if message.status !== 'running' && ((canRetry && !message.workflowDefinition) || linkError)}<div
          class="message-actions"
        >
          {#if linkError}<span role="alert">{linkError}</span>{/if}
          {#if canRetry && !message.workflowDefinition}<button
              class="text-button"
              onclick={retry}
              disabled={retryDisabled}><RotateCcw size={13} />Retry</button
            >{/if}
        </div>{/if}
    {/if}
  </div>
</article>

<style>
  .response-extras {
    display: flex;
    flex-wrap: wrap;
    align-items: stretch;
    gap: 8px;
    margin: 14px 0;
  }
  .response-extras:has(> :global(details[open])) {
    align-items: flex-start;
  }
  .response-extras > :global(.plan-panel),
  .response-extras > :global(.native-workflow-panel) {
    flex: 1 1 240px;
    min-width: 0;
    margin: 0;
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
    text-align: left;
    border-radius: 6px 0 0 6px;
  }
  .artifact-side {
    flex-shrink: 0;
    border-left: 0;
    border-radius: 0 6px 6px 0;
    padding-inline: 10px;
  }
  .response-artifacts span {
    overflow-wrap: anywhere;
    min-width: 0;
  }
  small {
    color: var(--muted);
    font-size: 10px;
    white-space: nowrap;
  }
</style>
