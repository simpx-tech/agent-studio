<script lang="ts">
  import { onMount } from 'svelte';
  import { Bell } from '@lucide/svelte';
  import {
    pushSettings,
    savePushSubscription,
    disablePushNotifications,
    testPushNotification,
    type PushStatus,
  } from '$lib/transport';
  let { paired }: { paired: boolean } = $props();
  let status = $state<PushStatus>();
  let supported = $state(false);
  let permission = $state<NotificationPermission>('default');
  let registration: ServiceWorkerRegistration | undefined;
  let busy = $state(false);
  let error = $state('');
  let feedback = $state('');
  let disposed = false;
  let refreshing = false;
  let revision = 0;
  const enabled = $derived(!!status?.enabled && permission === 'granted');
  async function refresh() {
    if (!paired || !supported || refreshing || busy) return;
    refreshing = true;
    const generation = revision;
    try {
      const current = await navigator.serviceWorker.getRegistration('/');
      const next = await pushSettings();
      if (disposed || !paired || generation !== revision) return;
      registration = current;
      status = next;
      permission = Notification.permission;
      error = '';
      if (current && next.enabled && permission === 'granted') {
        const subscription = await current.pushManager.getSubscription();
        if (disposed || !paired || generation !== revision) return;
        if (!subscription) {
          status = { ...next, enabled: false };
          error = 'Your browser subscription expired. Enable notifications again.';
        }
      }
    } catch {
      if (!disposed) error = 'Could not check notification settings. Try again when connected.';
    } finally {
      refreshing = false;
    }
  }
  onMount(() => {
    supported =
      window.isSecureContext &&
      'Notification' in window &&
      'PushManager' in window &&
      'serviceWorker' in navigator;
    if (supported) permission = Notification.permission;
    const onReturn = () => {
      if (document.visibilityState === 'visible' && !busy) void refresh();
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    const timer = setInterval(onReturn, 60_000);
    void refresh();
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  });
  $effect(() => {
    if (paired && supported) void refresh();
  });
  async function enable() {
    if (busy) return;
    ++revision;
    busy = true;
    error = '';
    feedback = '';
    try {
      // Invoke permission before any await so Safari retains the button gesture.
      permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        error =
          permission === 'denied'
            ? 'Notifications are blocked. Allow them in your browser or phone settings.'
            : 'Notifications were not enabled. Tap Enable notifications to try again.';
        return;
      }
      const settings = await pushSettings();
      registration = registration ?? (await navigator.serviceWorker.getRegistration('/'));
      if (!registration?.active)
        throw new Error('Close and reopen the installed app to finish its update, then try again.');
      const bytes = Uint8Array.from(
        atob(settings.publicKey.replace(/-/g, '+').replace(/_/g, '/')),
        (c) => c.charCodeAt(0),
      );
      let subscription = await registration.pushManager.getSubscription();
      if (
        subscription?.options.applicationServerKey &&
        Array.from(new Uint8Array(subscription.options.applicationServerKey)).join() !==
          Array.from(bytes).join()
      ) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes,
      });
      status = await savePushSubscription(subscription);
      feedback = 'Notifications enabled on this device.';
    } catch (e) {
      error = e instanceof Error ? e.message : 'Notifications could not be enabled. Try again.';
    } finally {
      busy = false;
    }
  }
  async function disable() {
    ++revision;
    busy = true;
    error = '';
    feedback = '';
    try {
      // Revoke delivery on the server first; a browser unsubscribe can fail offline.
      await disablePushNotifications();
      if (status) status = { ...status, enabled: false };
      await (await registration?.pushManager.getSubscription())?.unsubscribe();
      feedback = 'Notifications disabled on this device.';
    } catch {
      error = 'Could not finish disabling notifications. Reconnect and try again.';
    } finally {
      busy = false;
    }
  }
  async function test() {
    busy = true;
    error = '';
    feedback = '';
    try {
      await testPushNotification();
      feedback = 'Test notification queued. Check this device’s notifications.';
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not send the test notification.';
    } finally {
      busy = false;
    }
  }
</script>

<section aria-labelledby="notifications-heading" class="push-settings">
  <h2 id="notifications-heading"><Bell size={18} />Notifications</h2>
  <p>
    Get notified on this device when a reply finishes, stops, or needs your attention. Tap an alert
    to open its chat.
  </p>
  {#if !paired}<p>Connect to workspace sync to enable notifications.</p>
  {:else if !supported}<p>
      On iPhone or iPad, add Agent Studio to your Home Screen and open it there. Notifications
      require a supported browser and HTTPS.
    </p>
  {:else}
    <p class="notification-state">
      {enabled
        ? 'Enabled on this device'
        : permission === 'denied'
          ? 'Blocked in device settings'
          : 'Off on this device'}
    </p>
    <div class="notification-actions">
      {#if enabled}<button class="secondary" disabled={busy} onclick={test}
          >Send test notification</button
        >
        <button class="text-button" disabled={busy} onclick={disable}>Disable notifications</button>
      {:else}<button class="secondary" disabled={busy || permission === 'denied'} onclick={enable}
          >{busy ? 'Enabling…' : 'Enable notifications'}</button
        >{/if}
      {#if error}<button class="text-button" disabled={busy} onclick={refresh}>Check again</button
        >{/if}
    </div>
    {#if status?.unavailable || status?.deliveryFailed}<p role="status">
        Notification delivery is temporarily unavailable. The server will retry queued alerts.
      </p>{/if}
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if feedback}<p role="status">{feedback}</p>{/if}
  <p class="notification-privacy">
    Alerts do not include chat text or titles. Keep Agent Studio open on the computer running your
    agents.
  </p>
</section>

<style>
  .push-settings {
    border-top: 1px solid var(--line);
    padding-top: 24px;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 16px;
    margin: 0 0 12px;
  }
  p {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
    margin: 8px 0;
  }
  .notification-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin: 12px 0;
  }
  .notification-state {
    color: var(--text);
  }
  .notification-privacy {
    font-size: 12px;
  }
  [role='alert'] {
    color: #e5a29b;
  }
</style>
