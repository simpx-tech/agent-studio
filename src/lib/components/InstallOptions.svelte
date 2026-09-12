<script lang="ts">
  import { onMount } from 'svelte';
  import { Download, Monitor, Smartphone } from '@lucide/svelte';
  import { browserDevice, windowsInstallerUrl } from '$lib/installation';
  import { desktopInstallerAvailable } from '$lib/transport';
  import ConnectionDialog from './ConnectionDialog.svelte';

  let { installViewer, close }: { installViewer: () => Promise<boolean>; close: () => void } =
    $props();
  let device = $state<ReturnType<typeof browserDevice>>('mobile');
  let checking = $state(false);
  let available = $state(false);
  let downloadError = $state(false);
  let help = $state(false);
  let prompting = $state(false);
  let installError = $state('');

  async function checkDownload() {
    checking = true;
    downloadError = false;
    try {
      available = await desktopInstallerAvailable();
    } catch {
      downloadError = true;
    } finally {
      checking = false;
    }
  }
  onMount(() => {
    device = browserDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
    if (device !== 'mobile') void checkDownload();
  });
  async function install() {
    if (prompting) return;
    prompting = true;
    installError = '';
    try {
      if (await installViewer()) close();
      else help = true;
    } catch {
      installError = 'The browser could not open installation. Try again or use its install menu.';
    } finally {
      prompting = false;
    }
  }
</script>

<ConnectionDialog title="Install Agent Studio" {close} busy={prompting}>
  <div class="install-options">
    <section aria-labelledby="install-viewer-title">
      <h3 id="install-viewer-title"><Smartphone size={20} />Viewer <span>PWA</span></h3>
      <p>View chats and manage agents running on your connected computers.</p>
      <button class="primary" type="button" onclick={install} disabled={prompting}>
        <Download size={16} />{prompting ? 'Opening installation…' : 'Install Viewer'}
      </button>
      {#if help}<p class="install-help" role="status">
          {#if device === 'mobile'}On iPhone, open this page in Safari, tap Share, then Add to Home
            Screen. On Android, choose Install app or Add to Home screen in your browser menu.
          {:else}Use your browser’s install option, if available. You can also keep using Viewer in
            this tab.{/if}
        </p>{/if}
      {#if installError}<p role="alert">{installError}</p>{/if}
    </section>
    {#if device !== 'mobile'}<section aria-labelledby="install-desktop-title">
        <h3 id="install-desktop-title"><Monitor size={20} />Desktop app</h3>
        <p>
          {device === 'windows'
            ? 'Run agents on this computer and connect it to your workspace.'
            : 'Run agents on a Windows computer and connect it to your workspace.'}
        </p>
        {#if checking}<p role="status">Checking installer availability…</p>
        {:else if downloadError}<p role="alert">Could not check desktop downloads.</p>
          <button class="text-button" type="button" onclick={checkDownload}>Try again</button>
        {:else if available}<a class="desktop-download" href={windowsInstallerUrl} download>
            <Download size={16} />Download for Windows
          </a>
          <p class="download-detail">Windows · 64-bit installer</p>
        {:else}<p role="status">The desktop installer is not available on this server yet.</p>{/if}
      </section>{/if}
  </div>
</ConnectionDialog>

<style>
  .install-options {
    display: grid;
    gap: 24px;
  }
  section {
    display: grid;
    gap: 12px;
  }
  section + section {
    padding-top: 24px;
    border-top: 1px solid var(--line);
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 16px;
    font-weight: 600;
  }
  h3 span {
    font-size: 11px;
    font-weight: 400;
    color: var(--muted);
  }
  .primary,
  .desktop-download {
    min-height: 44px;
    width: 100%;
  }
  .desktop-download {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 1px solid var(--line);
    border-radius: 7px;
    text-decoration: none;
    font-size: 13px;
    color: var(--text);
  }
  .desktop-download:hover {
    background: var(--panel);
    border-color: var(--muted);
  }
  .download-detail {
    text-align: center;
  }
</style>
