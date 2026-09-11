<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Bell } from '@lucide/svelte';
  import {
    pushSettings,
    savePushSubscription,
    disablePushNotifications,
    testPushNotification,
    workspaceStorageScope,
    type PushStatus,
  } from '$lib/transport';
  let { paired, workspaceSession = 0 }: { paired: boolean; workspaceSession?: number } = $props();
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
  function sessionGuard() {
    const generation = revision;
    const scope = workspaceStorageScope();
    return () =>
      !disposed &&
      paired &&
      generation === revision &&
      !!scope &&
      scope === workspaceStorageScope();
  }
  async function refresh() {
    if (!paired || !supported || refreshing || busy) return;
    refreshing = true;
    const currentSession = sessionGuard();
    try {
      const current = await navigator.serviceWorker.getRegistration('/');
      if (!currentSession()) return;
      const next = await pushSettings();
      if (!currentSession()) return;
      registration = current;
      status = next;
      permission = Notification.permission;
      error = '';
      if (current && next.enabled && permission === 'granted') {
        const subscription = await current.pushManager.getSubscription();
        if (!currentSession()) return;
        if (!subscription) {
          status = { ...next, enabled: false };
          error = 'Your browser subscription expired. Enable notifications again.';
        }
      }
    } catch {
      if (currentSession())
        error = 'Could not check notification settings. Try again when connected.';
    } finally {
      if (currentSession()) refreshing = false;
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
    const available = paired && supported;
    workspaceSession;
    untrack(() => {
      ++revision;
      status = undefined;
      registration = undefined;
      error = feedback = '';
      busy = refreshing = false;
      if (available) void refresh();
    });
  });
  async function enable() {
    if (busy) return;
    ++revision;
    const currentSession = sessionGuard();
    busy = true;
    error = '';
    feedback = '';
    try {
      // Invoke permission before any await so Safari retains the button gesture.
      const result = await Notification.requestPermission();
      if (!currentSession()) return;
      permission = result;
      if (permission !== 'granted') {
        error =
          permission === 'denied'
            ? 'Notifications are blocked. Allow them in your browser or phone settings.'
            : 'Notifications were not enabled. Tap Enable notifications to try again.';
        return;
      }
      const settings = await pushSettings();
      if (!currentSession()) return;
      const current = registration ?? (await navigator.serviceWorker.getRegistration('/'));
      if (!currentSession()) return;
      registration = current;
      if (!registration?.active)
        throw new Error('Close and reopen the installed app to finish its update, then try again.');
      const bytes = Uint8Array.from(
        atob(settings.publicKey.replace(/-/g, '+').replace(/_/g, '/')),
        (c) => c.charCodeAt(0),
      );
      let subscription = await registration.pushManager.getSubscription();
      if (!currentSession()) return;
      if (
        subscription?.options.applicationServerKey &&
        Array.from(new Uint8Array(subscription.options.applicationServerKey)).join() !==
          Array.from(bytes).join()
      ) {
        await subscription.unsubscribe();
        if (!currentSession()) return;
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes,
      });
      if (!currentSession()) return;
      const next = await savePushSubscription(subscription);
      if (!currentSession()) return;
      status = next;
      feedback = 'Notifications enabled on this device.';
    } catch (e) {
      if (currentSession())
        error = e instanceof Error ? e.message : 'Notifications could not be enabled. Try again.';
    } finally {
      if (currentSession()) busy = false;
    }
  }
  async function disable() {
    ++revision;
    const currentSession = sessionGuard();
    busy = true;
    error = '';
    feedback = '';
    try {
      // Revoke delivery on the server first; a browser unsubscribe can fail offline.
      await disablePushNotifications();
      if (!currentSession()) return;
      if (status) status = { ...status, enabled: false };
      const subscription = await registration?.pushManager.getSubscription();
      if (!currentSession()) return;
      await subscription?.unsubscribe();
      if (!currentSession()) return;
      feedback = 'Notifications disabled on this device.';
    } catch {
      if (currentSession())
        error = 'Could not finish disabling notifications. Reconnect and try again.';
    } finally {
      if (currentSession()) busy = false;
    }
  }
  async function test() {
    ++revision;
    const currentSession = sessionGuard();
    busy = true;
    error = '';
    feedback = '';
    try {
      await testPushNotification();
      if (!currentSession()) return;
      feedback = 'Test notification queued. Check this device’s notifications.';
    } catch (e) {
      if (currentSession())
        error = e instanceof Error ? e.message : 'Could not send the test notification.';
    } finally {
      if (currentSession()) busy = false;
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
