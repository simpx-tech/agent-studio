<script lang="ts">
  import { Download, ShieldCheck } from '@lucide/svelte';
  import AppUpdates from './AppUpdates.svelte';
  import AppearanceSettings from './AppearanceSettings.svelte';
  import ClaudeInstructions from './ClaudeInstructions.svelte';
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
    claudeInstructions,
    saveClaudeInstructions,
  }: {
    paired: boolean;
    workspaceSession?: number;
    exportWorkspace: () => Promise<void>;
    appUpdate?: AppUpdateStatus;
    restartToUpdate: () => Promise<void>;
    claudeInstructions?: string;
    saveClaudeInstructions: (
      value: string | undefined,
      previous: string | undefined,
    ) => Promise<void>;
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
            ? 'Appearance, notifications, app updates, Claude chat instructions, workspace administration, and the data kept for this workspace.'
            : 'Appearance, notifications, Claude chat instructions, workspace administration, and the data kept for this workspace.'}
        </p>
      </div>
    </section>
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <div class="settings-sections">
      <AppearanceSettings />
      {#if desktop()}<DesktopNotifications />{:else}<PushNotifications
          {paired}
          {workspaceSession}
        />{/if}
      {#if desktop()}<AppUpdates status={appUpdate} restart={restartToUpdate} />{/if}
      {#key workspaceSession}<ClaudeInstructions
          value={claudeInstructions}
          save={saveClaudeInstructions}
        />{/key}
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
    max-width: 800px;
    padding-top: 36px;
    padding-bottom: 32px;
  }
  .settings-sections {
    display: grid;
    gap: 14px;
  }
  .settings-sections > :global(section) {
    min-width: 0;
    padding: 18px 20px 20px;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--surface-1);
  }
  :global(.settings-sections > section :where(h2)) {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0 0 6px;
    font-size: var(--text-md);
    font-weight: 600;
  }
  .settings-sections > :global(section h2 svg) {
    color: var(--text-muted);
  }
  :global(.settings-sections > section :where(p)) {
    color: var(--text-muted);
    font-size: var(--text-base);
    line-height: var(--leading-normal);
    margin: 6px 0;
    max-width: 640px;
  }
  :global(.settings-sections > section :where([role='alert'])) {
    color: var(--danger);
  }
  .workspace-data p {
    color: var(--text-muted);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin: 14px 0 0;
  }
  @media (max-width: 1190px) {
    .settings-page {
      padding-inline: 28px;
    }
  }
  @media (max-width: 650px) {
    .settings-page {
      padding-inline: 18px;
    }
    .settings-sections > :global(section) {
      padding: 16px;
    }
  }
</style>
