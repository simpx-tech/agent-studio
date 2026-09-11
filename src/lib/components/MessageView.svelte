<script lang="ts">
  import { RotateCcw, CircleAlert, ArrowRightLeft, PanelsTopLeft } from '@lucide/svelte';
  import { messageText, providers, type Message, type ChatSettings } from '$lib/domain';
  import { renderMarkdown } from '$lib/markdown';
  import { openLink } from '$lib/transport';
  import { replyModelName, type ReplyTimeTotal } from '$lib/replies';
  import ToolActivity from './ToolActivity.svelte';
  import ReplyUsage from './ReplyUsage.svelte';
  import ImageAttachments from './ImageAttachments.svelte';
  import PlanPanel from './PlanPanel.svelte';
  import { messageArtifacts, type Artifact } from '$lib/artifacts';
  let {
    message,
    agent,
    retry,
    canRetry = false,
    retryDisabled = false,
    switchNotice = '',
    timeTotal,
    openArtifact,
  }: {
    message: Message;
    agent: ChatSettings;
    retry: () => void;
    canRetry?: boolean;
    retryDisabled?: boolean;
    switchNotice?: string;
    timeTotal?: ReplyTimeTotal;
    openArtifact: (artifact: Artifact) => void;
  } = $props();
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
          ><i class="pulse-dot"></i> Responding</span
        >{/if}
    </div>
    {#if message.role === 'user'}
      {#if message.images?.length}<ImageAttachments images={message.images} />{/if}
      {#if text}<div class="user-text">{text}</div>{/if}
    {:else}
      {#if message.status === 'running'}<ToolActivity
          {tools}
          replyStatus={message.status}
          blocks={message.blocks}
          finalText={text}
        />{/if}
      {#if text}
        <!-- Links are handled at this boundary; sanitized output is restricted to presentation tags. -->
        <!-- Nested anchors provide keyboard behavior; their click events bubble here. -->
        <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
        <div class="prose" onclick={linkClick}>{@html renderMarkdown(text)}</div>
      {:else if message.status === 'running' && !message.blocks.length}<div class="thinking">
          <span></span><span></span><span></span><small>Making room for a good answer…</small>
        </div>{/if}
      {#if message.error}<div class="message-error" role="status">
          <CircleAlert size={15} />{message.error}
        </div>{/if}
      {#if message.status === 'cancelled' && !message.error}<p class="muted small">
          Response stopped. Partial text has been kept.
        </p>{/if}
      {#if message.status !== 'running'}<ReplyUsage {message} {timeTotal} /><ToolActivity
          {tools}
          replyStatus={message.status}
          blocks={message.blocks}
          finalText={text}
        />{/if}
      {#if message.status !== 'running' && ((canRetry && !message.workflowDefinition) || linkError)}<div
          class="message-actions"
        >
          {#if canRetry && !message.workflowDefinition}<button
              class="text-button"
              onclick={retry}
              disabled={retryDisabled}><RotateCcw size={13} />Retry</button
            >{/if}
          {#if linkError}<span role="alert">{linkError}</span>{/if}
        </div>{/if}
    {/if}
    {#if artifacts.length || savedProgress}<div class="response-extras">
        {#if savedProgress}<PlanPanel {message} compact />{/if}
        {#if artifacts.length}<div class="response-artifacts" aria-label="Response artifacts">
            {#each artifacts as artifact (artifact.id)}<button
                class="secondary"
                onclick={() => openArtifact(artifact)}
                ><PanelsTopLeft size={16} /><span>{artifact.title}</span><small
                  >Open {artifact.language.toUpperCase()}</small
                ></button
              >{/each}
          </div>{/if}
      </div>{/if}
  </div>
</article>

<style>
  .response-extras {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px;
    margin: 14px 0;
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
  .response-artifacts button {
    flex: 1 1 auto;
    text-align: left;
    max-width: 100%;
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
