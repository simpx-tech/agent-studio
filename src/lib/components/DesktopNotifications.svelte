<script lang="ts">
  import { onMount } from 'svelte';
  import { Bell } from '@lucide/svelte';
  import {
    desktopNotificationSettings,
    setDesktopNotifications,
    testDesktopNotification,
    type DesktopNotificationSettings,
  } from '$lib/transport';
  let settings = $state<DesktopNotificationSettings>();
  let busy = $state(false);
  let error = $state('');
  let feedback = $state('');
  let disposed = false;
  let revision = 0;
  async function refresh() {
    if (busy) return;
    const current = revision;
    try {
      const value = await desktopNotificationSettings();
      if (!disposed && !busy && current === revision) {
        settings = value;
        error = '';
      }
    } catch (e) {
      if (!disposed && current === revision) error = String(e);
    }
  }
  onMount(() => {
    void refresh();
    window.addEventListener('focus', refresh);
    const timer = setInterval(refresh, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  });
  async function update(enabled: boolean, sound: boolean) {
    ++revision;
    busy = true;
    error = '';
    feedback = '';
    try {
      settings = await setDesktopNotifications(enabled, sound);
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
  async function test() {
    ++revision;
    busy = true;
    error = '';
    feedback = '';
    try {
      await testDesktopNotification();
      feedback = 'Test sent. Check your desktop notifications.';
      settings = await desktopNotificationSettings();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<section aria-labelledby="notifications-heading">
  <h2 id="notifications-heading"><Bell size={18} />Notifications</h2>
  <p>Get notified on this computer when a reply finishes, stops, or needs your attention.</p>
  {#if settings}
    <p class="state">{settings.enabled ? 'Enabled on this computer' : 'Off on this computer'}</p>
    <label class="checkbox"
      ><input
        type="checkbox"
        checked={settings.sound}
        disabled={busy}
        onchange={(event) => update(settings!.enabled, event.currentTarget.checked)}
      /><span>Play the Agent Studio chime</span></label
    >
    <p>A short, distinctive chime replaces the system notification sound.</p>
    <div class="actions">
      {#if settings.enabled}
        <button class="secondary" disabled={busy} onclick={test}>Send test notification</button>
        <button class="text-button" disabled={busy} onclick={() => update(false, settings!.sound)}
          >Disable notifications</button
        >
      {:else}
        <button class="secondary" disabled={busy} onclick={() => update(true, settings!.sound)}
          >{busy ? 'Enabling…' : 'Enable notifications'}</button
        >
      {/if}
    </div>
  {/if}
  {#if error || settings?.lastError}<p role="alert">{error || settings?.lastError}</p>{/if}
  {#if feedback}<p role="status">{feedback}</p>{/if}
  <p class="privacy">
    Alerts contain no chat text or titles. Keep Agent Studio open or minimized. Your computer’s
    notification settings control banners; mute the chime here when you need quiet.
  </p>
</section>

<style>
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .state {
    color: var(--text);
    font-weight: 500;
  }
  .checkbox {
    margin: 14px 0 2px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin: 14px 0 12px;
  }
  .privacy {
    padding-top: 12px;
    border-top: 1px solid var(--border);
    font-size: var(--text-sm);
  }
</style>
