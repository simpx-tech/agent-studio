<script lang="ts">
  import { ArrowRight, Eye, EyeOff, KeyRound, LoaderCircle, WifiOff } from '@lucide/svelte';
  import BrowserStatus from './BrowserStatus.svelte';

  let {
    checking,
    ready,
    online,
    error,
    retry,
    login,
  }: {
    checking: boolean;
    ready: boolean;
    online: boolean;
    error: string;
    retry: () => void;
    login: (key: string) => Promise<void>;
  } = $props();
  let key = $state('');
  let keyVisible = $state(false);
  let busy = $state(false);
  let failure = $state('');

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || checking || !ready || !online || !key.trim()) return;
    busy = true;
    keyVisible = false;
    failure = '';
    try {
      await login(key.trim());
    } catch (error) {
      failure = String(error).replace(/^Error: /, '');
    } finally {
      key = '';
      busy = false;
    }
  }
</script>

<main class="workspace-login" aria-labelledby="workspace-login-title">
  <div class="login-content">
    <div class="login-brand">
      <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <span>Agent <span class="brand-light">Studio</span></span>
    </div>
    <div class="login-heading">
      <h1 id="workspace-login-title">Sign in to your workspace</h1>
      <p>View your chats and manage agents running on your connected computers.</p>
    </div>
    {#if !online}
      <p class="login-status" role="status">
        <WifiOff size={17} />You’re offline. Connect to the internet to sign in.
      </p>
    {:else if checking}
      <p class="login-status" role="status">
        <LoaderCircle size={17} class="spinning" />Checking your workspace session…
      </p>
    {/if}
    {#if failure || error}
      <div
        class="login-error"
        role={error.includes('Reconnecting automatically') && !failure ? 'status' : 'alert'}
      >
        <p>{failure || error}</p>
        {#if !failure}<button class="text-button" type="button" onclick={retry}>Try again</button
          >{/if}
      </div>
    {/if}
    <form onsubmit={submit} aria-busy={busy || checking}>
      <label for="workspace-key">Workspace key</label>
      <div class="key-field">
        <KeyRound size={17} aria-hidden="true" />
        <input
          id="workspace-key"
          name="workspace-key"
          type={keyVisible ? 'text' : 'password'}
          bind:value={key}
          placeholder="Enter your private workspace key"
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          minlength="32"
          required
          disabled={busy || checking || !ready}
          aria-describedby="workspace-key-help"
        />
        <button
          class="key-visibility"
          type="button"
          aria-label={keyVisible ? 'Hide workspace key' : 'Show workspace key'}
          title={keyVisible ? 'Hide workspace key' : 'Show workspace key'}
          aria-controls="workspace-key"
          disabled={busy || checking || !ready}
          onclick={() => (keyVisible = !keyVisible)}
        >
          {#if keyVisible}<EyeOff size={18} aria-hidden="true" />{:else}<Eye
              size={18}
              aria-hidden="true"
            />{/if}
        </button>
      </div>
      <p id="workspace-key-help">Use the key provided by your workspace administrator.</p>
      <button class="primary" disabled={busy || checking || !ready || !online || !key.trim()}>
        {#if busy}<LoaderCircle size={17} class="spinning" />Signing in…{:else}Sign in<ArrowRight
            size={17}
          />{/if}
      </button>
    </form>
    <p class="login-note">
      Your session stays signed in on this browser. Agents run on your computers, so keep Agent
      Studio open there.
    </p>
    <BrowserStatus showConnection={false} />
  </div>
</main>

<style>
  .workspace-login {
    height: var(--mobile-height, 100dvh);
    overflow: auto;
    display: flex;
    padding: 40px 24px;
  }
  .login-content {
    width: 100%;
    max-width: 400px;
    margin: auto;
  }
  .login-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 40px;
    font-family: 'Manrope Variable', sans-serif;
    font-size: 19px;
    font-weight: 750;
    letter-spacing: -0.5px;
  }
  .login-heading h1 {
    font-size: 29px;
    letter-spacing: -1px;
    line-height: 1.25;
    margin-bottom: 12px;
  }
  .login-heading {
    margin-bottom: 28px;
  }
  form {
    display: grid;
    gap: 10px;
  }
  label {
    font-weight: 500;
  }
  .key-field {
    position: relative;
  }
  .key-field > :global(svg) {
    position: absolute;
    left: 14px;
    top: 16px;
    color: var(--muted);
    pointer-events: none;
  }
  input {
    min-height: 48px;
    padding-left: 41px;
    padding-right: 48px;
    font-size: 16px;
  }
  input::-ms-reveal {
    display: none;
  }
  .key-visibility {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--muted);
  }
  .key-visibility:hover:not(:disabled) {
    color: var(--text);
  }
  #workspace-key-help,
  .login-note {
    font-size: 12px;
    color: var(--muted);
  }
  .primary {
    min-height: 46px;
    margin-top: 10px;
  }
  .login-note {
    margin-top: 24px;
  }
  .login-status {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
  }
  .login-error {
    border-left: 2px solid var(--green);
    padding-left: 14px;
    margin-bottom: 20px;
    overflow-wrap: anywhere;
  }
  .login-content :global(.browser-status) {
    padding: 16px 0 0;
    border: 0;
    background: transparent;
  }
  @media (max-width: 650px) {
    .workspace-login {
      position: fixed;
      inset: var(--mobile-top, 0px) 0 auto;
      padding: 28px 24px;
    }
    .login-brand {
      margin-bottom: 32px;
    }
  }
</style>
