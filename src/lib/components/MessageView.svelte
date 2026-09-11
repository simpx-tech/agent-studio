<script lang="ts">
  import { RotateCcw, CircleAlert, ArrowRightLeft } from '@lucide/svelte';
  import { messageText, providers, type Message, type ChatSettings } from '$lib/domain';
  import { renderMarkdown } from '$lib/markdown';
  import { openLink } from '$lib/transport';
  import { replyModelName, type ReplyTimeTotal } from '$lib/replies';
  import ToolActivity from './ToolActivity.svelte';
  import ReplyUsage from './ReplyUsage.svelte';
  import ImageAttachments from './ImageAttachments.svelte';
  let {
    message,
    agent,
    retry,
    canRetry = false,
    retryDisabled = false,
    switchNotice = '',
    timeTotal,
  }: {
    message: Message;
    agent: ChatSettings;
    retry: () => void;
    canRetry?: boolean;
    retryDisabled?: boolean;
    switchNotice?: string;
    timeTotal?: ReplyTimeTotal;
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
      {#if message.status !== 'running' && (canRetry || linkError)}<div class="message-actions">
          {#if canRetry}<button class="text-button" onclick={retry} disabled={retryDisabled}
              ><RotateCcw size={13} />Retry</button
            >{/if}
          {#if linkError}<span role="alert">{linkError}</span>{/if}
        </div>{/if}
    {/if}
  </div>
</article>
