<script module lang="ts">
  type InstallPrompt = Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: string }>;
  };
  // Login and the authenticated shell mount separate status controls. Retain
  // the browser's one-shot install event across that transition, in memory only.
  let pendingInstallPrompt: InstallPrompt | undefined;
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { Download, WifiOff, Link } from '@lucide/svelte';
  import { dev } from '$app/environment';
  import InstallOptions from './InstallOptions.svelte';
  let {
    paired = false,
    error = '',
    connect = () => {},
    showConnection = true,
  }: {
    paired?: boolean;
    error?: string;
    connect?: () => void;
    showConnection?: boolean;
  } = $props();
  let installPrompt = $state<InstallPrompt>();
  let offline = $state(false);
  let installed = $state(false);
  let showInstall = $state(false);
  onMount(() => {
    const connectivity = () => (offline = !navigator.onLine);
    const capture = (event: Event) => {
      event.preventDefault();
      installPrompt = pendingInstallPrompt = event as InstallPrompt;
    };
    const complete = () => {
      installed = true;
      showInstall = false;
      installPrompt = pendingInstallPrompt = undefined;
    };
    installed = window.matchMedia('(display-mode: standalone)').matches;
    installPrompt = pendingInstallPrompt;
    connectivity();
    window.addEventListener('online', connectivity);
    window.addEventListener('offline', connectivity);
    window.addEventListener('beforeinstallprompt', capture);
    window.addEventListener('appinstalled', complete);
    if (!dev && 'serviceWorker' in navigator && window.isSecureContext)
      void navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    return () => {
      window.removeEventListener('online', connectivity);
      window.removeEventListener('offline', connectivity);
      window.removeEventListener('beforeinstallprompt', capture);
      window.removeEventListener('appinstalled', complete);
    };
  });
  async function install() {
    if (!installPrompt) return false;
    const prompt = installPrompt;
    installPrompt = pendingInstallPrompt = undefined;
    await prompt.prompt();
    await prompt.userChoice;
    return true;
  }
</script>

{#if (showConnection && (offline || error || !paired)) || !installed}<div class="browser-status">
    <div class="browser-status-row">
      {#if showConnection && (offline || error || !paired)}<span role="status"
          >{#if offline}<WifiOff size={15} />Offline · Reconnect to control agents.
          {:else if error}<WifiOff size={15} />Server unavailable · Reconnect to control agents.
          {:else}<Link size={15} />Connect your computers{/if}</span
        >{/if}
      {#if showConnection && (!paired || error)}<button class="text-button" onclick={connect}
          >{paired ? 'Reconnect' : 'Set up'}</button
        >{/if}
      {#if !installed}<button
          class="text-button install-button"
          onclick={() => (showInstall = true)}
          aria-haspopup="dialog"><Download size={14} />Install app</button
        >{/if}
    </div>
  </div>{/if}
{#if showInstall}<InstallOptions installViewer={install} close={() => (showInstall = false)} />{/if}
