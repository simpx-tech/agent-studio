<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import {
    CircleAlert,
    LayoutDashboard,
    LoaderCircle,
    MessageSquare,
    RotateCcw,
    SquareTerminal,
    Trash2,
  } from '@lucide/svelte';
  import {
    artifactPreviewUrl,
    askScreenModel,
    callScreenTool,
    deleteScreen,
    forgetScreenJob,
    loadScreenData,
    openLink,
    readScreen,
    saveScreenData,
    screenJobOutput,
    screenJobs,
    screenMcpServers,
    startScreenJob,
    stopScreenJob,
  } from '$lib/transport';
  import {
    screenCall,
    screenFolderName,
    screenReply,
    screenTheme,
    type ScreenCall,
    type ScreenDetail,
    type ScreenJob,
    type ScreenSummary,
  } from '$lib/screens';
  import { screenPreview } from '$lib/screen-preview';
  import { appearance } from '$lib/appearance.svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  import ScreenJobs from './ScreenJobs.svelte';
  let {
    environmentId,
    id,
    summary,
    computerName,
    online,
    shown = true,
    shell = 'powershell',
    openConversation,
    chat,
    changed,
    runningChanged,
    deleted,
  }: {
    /** The environment whose computer keeps the screen, which routes its requests. */
    environmentId: string;
    id: string;
    /** What the Screens list knows of it, shown while it opens. */
    summary?: ScreenSummary;
    computerName: string;
    online: boolean;
    /**
     * Whether it is on screen. A screen this window opened stays open while another chat,
     * screen or page shows, so its page keeps what it showed.
     */
    shown?: boolean;
    /** The shell a command its page passes runs in unless it names one. */
    shell?: 'powershell' | 'bash';
    /** Opens the chat that created the screen, when it is in this workspace. */
    openConversation?: () => void;
    /** `studio.chat`: a new conversation in the screen's folder with this text, sent or not. */
    chat: (text: string, screen: ScreenDetail, send: boolean) => void;
    /** The screen as its computer last reported it. */
    changed?: (screen: ScreenDetail) => void;
    /** How many of its jobs run, as this window last learned. */
    runningChanged?: (count: number) => void;
    deleted: () => void;
  } = $props();
  let detail = $state<ScreenDetail>();
  // What the page finds in studio.values when it starts.
  let values: Record<string, unknown> = {};
  let loading = $state(false);
  let error = $state('');
  let url = $state('');
  let restart = $state(0);
  let frame = $state<HTMLIFrameElement>();
  // The frame shown now; calls of an earlier one are never answered.
  let token = '';
  let serial = 0;
  // Calls of the page that wait now, by what they name.
  let calling = $state<Record<number, string>>({});
  // The jobs the page and the list know of, and whether each runs.
  let jobStates = $state<Record<string, ScreenJob['state']>>({});
  const runningJobs = $derived(
    Object.values(jobStates).filter((state) => state === 'running').length,
  );
  const callingNames = $derived([...new Set(Object.values(calling))]);
  let showingJobs = $state(false);
  let confirmingDelete = $state(false);
  let deleting = $state(false);
  let deleteError = $state('');
  const title = $derived(detail?.title ?? summary?.title ?? 'Screen');
  const folder = $derived(screenFolderName(detail ?? summary ?? { project: '', folder: '' }));
  const message = (e: unknown) =>
    (e instanceof Error ? e.message : String(e)).replace(/^Error: /, '');

  function noteJobs(jobs: ScreenJob[], whole = false) {
    if (whole) jobStates = {};
    for (const job of jobs) jobStates[job.id] = job.state;
  }
  async function load() {
    if (loading) return;
    loading = true;
    error = '';
    try {
      const [next, saved] = await Promise.all([
        readScreen(environmentId, id),
        loadScreenData(environmentId, id),
      ]);
      values = saved;
      detail = next;
      changed?.(next);
      // Jobs that went on while no page showed them.
      void screenJobs(environmentId, id).then(
        (jobs) => noteJobs(jobs, true),
        () => {},
      );
    } catch (e) {
      error = message(e);
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    void artifactPreviewUrl()
      .then((value) => (url = value))
      .catch(() => (error = 'This window cannot show screens.'));
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      token = '';
    };
  });
  // Opens once its computer is reachable, and again when a chat saved a newer revision.
  $effect(() => {
    if (!online) return;
    const known = summary?.revision ?? 0;
    untrack(() => {
      if (!detail || known > detail.revision) void load();
    });
  });
  () => {
    const count = runningJobs;
    untrack(() => runningChanged?.(count));
  };
  // A new theme reaches the page as it is, without starting it again.
  $effect(() => {
    const theme = appearance.resolved;
    untrack(() => {
      if (token && frame?.contentWindow)
        frame.contentWindow.postMessage(screenTheme(token, theme), '*');
    });
  });

  function initialize(event: Event) {
    const target = event.currentTarget as HTMLIFrameElement;
    if (target.dataset.initialized || !detail) return;
    target.dataset.initialized = 'true';
    token = crypto.randomUUID();
    calling = {};
    target.contentWindow?.postMessage(
      screenPreview(
        detail.html,
        token,
        { id: detail.id, title: detail.title },
        appearance.resolved,
        values,
        shell,
      ),
      '*',
    );
  }
  function receive(event: MessageEvent) {
    if (!frame || !token || event.source !== frame.contentWindow) return;
    const call = screenCall(event.data, token);
    if (!call) return;
    const callToken = token;
    const target = frame.contentWindow;
    const reply = (result: { value: unknown } | { error: string }) => {
      // A reloaded or closed frame no longer waits for this answer.
      if (token !== callToken || frame?.contentWindow !== target) return;
      target?.postMessage(screenReply(callToken, call.id, result), '*');
    };
    void answer(call).then(
      (value) => reply({ value }),
      (e) => reply({ error: message(e) }),
    );
  }
  /** Shows what the page waits for in the toolbar while it waits. */
  async function waiting<T>(name: string, work: () => Promise<T>): Promise<T> {
    const key = ++serial;
    calling[key] = name;
    try {
      return await work();
    } finally {
      delete calling[key];
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      if (!copied) throw new Error('The clipboard did not take the text.');
    }
  }
  async function answer(call: ScreenCall): Promise<unknown> {
    switch (call.method) {
      case 'start': {
        const job = await startScreenJob(environmentId, id, {
          action: call.action,
          command: call.command,
          params: call.params,
          keep: call.keep,
        });
        noteJobs([job]);
        return job;
      }
      case 'jobs': {
        const jobs = await screenJobs(environmentId, id);
        noteJobs(jobs, true);
        return jobs;
      }
      case 'output': {
        const output = await screenJobOutput(environmentId, id, call.job, call.after, {
          wait: call.wait,
        });
        noteJobs([output.job]);
        return output;
      }
      case 'stop': {
        const job = await stopScreenJob(environmentId, id, call.job);
        noteJobs([job]);
        return job;
      }
      case 'forget':
        await forgetScreenJob(environmentId, id, call.job);
        delete jobStates[call.job];
        return null;
      case 'mcp':
        return waiting(call.tool, () =>
          callScreenTool(environmentId, id, call.server, call.tool, call.arguments, {
            where: call.where,
            account: call.account,
          }),
        );
      case 'servers':
        return waiting('MCP servers', () =>
          screenMcpServers(environmentId, id, { where: call.where, account: call.account }),
        );
      case 'ask':
        return waiting('a model', () =>
          askScreenModel(environmentId, id, {
            prompt: call.prompt,
            model: call.model,
            system: call.system,
          }),
        );
      case 'load':
        return (await loadScreenData(environmentId, id))[call.key] ?? null;
      case 'save':
        await saveScreenData(environmentId, id, call.key, call.value);
        if (call.value === null) delete values[call.key];
        else values[call.key] = call.value;
        return null;
      case 'copy':
        await copy(call.text);
        return null;
      case 'open':
        await openLink(call.url);
        return null;
      case 'chat':
        // A page another chat or page covers opens none.
        if (!shown || !detail) throw new Error('studio.chat works while the screen is shown.');
        chat(call.text, detail, call.send);
        return null;
    }
  }

  function reload() {
    void load().then(() => restart++);
  }
  async function remove() {
    if (deleting) return;
    deleting = true;
    deleteError = '';
    try {
      await deleteScreen(environmentId, id);
      confirmingDelete = false;
      deleted();
    } catch (e) {
      deleteError = message(e);
    } finally {
      deleting = false;
    }
  }
</script>

<section class="screen-page" aria-label={title}>
  <header class="screen-toolbar">
    <div class="screen-heading">
      <LayoutDashboard size={17} aria-hidden="true" />
      <div>
        <h1>{title}</h1>
        <p title={detail?.folder ?? summary?.folder}>
          {computerName} · {folder}{#if (detail ?? summary)?.description}<span
              class="screen-description">{` · ${(detail ?? summary)?.description}`}</span
            >{/if}
        </p>
      </div>
    </div>
    <div class="screen-tools">
      {#if callingNames.length}<span class="screen-running" role="status"
          ><LoaderCircle size={13} class="spinning" aria-hidden="true" />Calling {callingNames.join(
            ', ',
          )}</span
        >{/if}
      <button
        class="icon-button screen-jobs-button"
        class:screen-jobs-running={runningJobs > 0}
        title={runningJobs ? `Jobs · ${runningJobs} running` : 'Jobs'}
        aria-label={runningJobs ? `Jobs, ${runningJobs} running` : 'Jobs'}
        disabled={!online || !detail}
        onclick={() => (showingJobs = true)}
        >{#if runningJobs}<LoaderCircle
            size={16}
            class="spinning"
            aria-hidden="true"
          />{:else}<SquareTerminal size={16} aria-hidden="true" />{/if}</button
      >
      {#if openConversation}<button
          class="icon-button"
          title="Open the chat that made it"
          aria-label="Open the chat that made this screen"
          onclick={openConversation}><MessageSquare size={16} /></button
        >{/if}
      <button
        class="icon-button"
        title="Reload"
        aria-label="Reload this screen"
        disabled={!online || loading}
        onclick={reload}><RotateCcw size={16} /></button
      >
      <button
        class="icon-button"
        title="Delete screen"
        aria-label="Delete this screen"
        disabled={!online || !detail}
        onclick={() => {
          deleteError = '';
          confirmingDelete = true;
        }}><Trash2 size={16} /></button
      >
    </div>
  </header>
  {#if !online}<div class="setup-hint neutral" role="status">
      <CircleAlert size={15} aria-hidden="true" /><span>{computerName} is offline.</span>
    </div>{/if}
  {#if error}<div class="error-banner screen-error" role="alert">
      <CircleAlert size={15} aria-hidden="true" />{error}
    </div>{/if}
  <div class="screen-frame">
    {#if detail && url}{#key `${detail.revision}:${restart}`}<iframe
          bind:this={frame}
          title={`${title} screen`}
          src={url}
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
          onload={initialize}
        ></iframe>{/key}{:else if loading || (online && !error)}<p
        class="screen-status"
        role="status"
      >
        Opening screen…
      </p>{/if}
  </div>
</section>
{#if showingJobs && detail}<ScreenJobs
    {environmentId}
    screen={detail}
    {online}
    noted={(jobs) => noteJobs(jobs, true)}
    close={() => (showingJobs = false)}
  />{/if}
{#if confirmingDelete && detail}<ConnectionDialog
    title="Delete screen"
    busy={deleting}
    close={() => (confirmingDelete = false)}
  >
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void remove();
      }}
    >
      <p>
        Delete <strong>{detail.title}</strong> from {computerName}?
      </p>
      {#if deleteError}<div class="error-banner" role="alert">{deleteError}</div>{/if}
      <div class="dialog-actions">
        <button
          type="button"
          class="secondary"
          disabled={deleting}
          onclick={() => (confirmingDelete = false)}>Cancel</button
        ><button type="submit" class="danger" disabled={deleting}
          >{deleting ? 'Deleting…' : 'Delete screen'}</button
        >
      </div>
    </form>
  </ConnectionDialog>{/if}

<style>
  .screen-page {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    padding: 12px 20px 16px;
    gap: 10px;
    animation: fade-in var(--duration) ease;
  }
  .screen-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }
  .screen-heading {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .screen-heading > :global(svg) {
    flex-shrink: 0;
    color: var(--accent-strong);
  }
  .screen-heading div {
    min-width: 0;
  }
  .screen-heading h1 {
    margin: 0;
    font-size: var(--text-lg);
    letter-spacing: var(--tracking-tight);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .screen-heading p {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .screen-tools {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
  }
  .screen-running {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-right: 8px;
    color: var(--text-muted);
    font-size: var(--text-sm);
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .screen-tools :global(.screen-jobs-running) {
    color: var(--accent-strong);
  }
  .setup-hint {
    margin-bottom: 0;
  }
  .screen-error {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
  }
  .screen-frame {
    position: relative;
    flex: 1;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    overflow: hidden;
  }
  .screen-frame iframe {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: transparent;
  }
  .screen-status {
    margin: 0;
    padding: 20px 24px;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  @media (max-width: 700px) {
    .screen-page {
      padding: 8px 10px 10px;
    }
    .screen-description {
      display: none;
    }
    .screen-running {
      display: none;
    }
    .screen-tools .icon-button {
      width: 40px;
      height: 40px;
    }
  }
</style>
