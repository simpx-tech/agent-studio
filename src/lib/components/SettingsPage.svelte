<script lang="ts">
  import { Download, ShieldCheck } from '@lucide/svelte';
  import AppUpdates from './AppUpdates.svelte';
  import DesktopNotifications from './DesktopNotifications.svelte';
  import PushNotifications from './PushNotifications.svelte';
  import WorkspaceAdministration from './WorkspaceAdministration.svelte';
  import { desktop, type AppUpdateStatus } from '$lib/transport';
  let {
    paired,
    workspaceSession = 0,
    exportWorkspace,
    appUpdate,
    restartToUpdate,
  }: {
    paired: boolean;
    workspaceSession?: number;
    exportWorkspace: () => Promise<void>;
    appUpdate?: AppUpdateStatus;
    restartToUpdate: () => Promise<void>;
  } = $props();
  let busy = $state(false);
  let error = $state('');
  async function exportNow() {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await exportWorkspace();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="page-scroll">
  <div class="page-content settings-page">
    <section class="page-heading">
      <div>
        <h1>Settings</h1>
        <p>
          {desktop()
            ? 'Notifications, app updates, workspace administration, and the data kept for this workspace.'
            : 'Notifications, workspace administration, and the data kept for this workspace.'}
        </p>
      </div>
    </section>
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <div class="settings-sections">
      {#if desktop()}<DesktopNotifications />{:else}<PushNotifications
          {paired}
          {workspaceSession}
        />{/if}
      {#if desktop()}<AppUpdates status={appUpdate} restart={restartToUpdate} />{/if}
      <WorkspaceAdministration {paired} {workspaceSession} />
      <section class="workspace-data" aria-labelledby="workspace-data-heading">
        <h2 id="workspace-data-heading"><ShieldCheck size={18} />Workspace data</h2>
        <p>
          Provider sign-ins stay on each computer. Passwords and provider tokens stay with their
          CLIs; Agent Studio never reads or copies them.
        </p>
        <p>
          Pairing sync shares chat content, computer setups, and account labels only within your
          private workspace. Other workspace keys on the same server cannot access them. Anyone with
          your workspace key can join it; the server administrator controls its storage.
          Conversation files and exports are plain text.
        </p>
        <div class="actions">
          <button class="secondary" disabled={busy} onclick={exportNow}
            ><Download size={14} />{busy ? 'Exporting…' : 'Export workspace'}</button
          >
        </div>
      </section>
    </div>
  </div>
</div>

<style>
  .settings-page {
    padding-top: 32px;
    padding-bottom: 28px;
  }
  .page-heading {
    margin-bottom: 30px;
  }
  .page-heading h1 {
    font-size: 30px;
  }
  .page-heading p {
    font-size: 13px;
    line-height: 1.6;
  }
  .settings-sections {
    display: grid;
    gap: 28px;
  }
  .settings-sections > :global(section:first-child) {
    border-top: 0;
    padding-top: 0;
  }
  .workspace-data {
    border-top: 1px solid var(--line);
    padding-top: 24px;
  }
  .workspace-data h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 16px;
    margin: 0 0 12px;
  }
  .workspace-data p {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
    margin: 8px 0;
    max-width: 640px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin: 12px 0;
  }
  @media (max-width: 1190px) {
    .settings-page {
      padding-inline: 28px;
    }
  }
  @media (max-width: 650px) {
    .settings-page {
      padding-inline: 20px;
    }
  }
</style>
