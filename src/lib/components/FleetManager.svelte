<script lang="ts">
  import {
    Monitor,
    Server,
    Plus,
    Link,
    RefreshCw,
    Settings2,
    ArrowUpRight,
    LoaderCircle,
    CircleAlert,
  } from '@lucide/svelte';
  import { tick, untrack } from 'svelte';
  import {
    providers,
    providerIds,
    type Workspace,
    type ProviderId,
    type ProviderStatus,
  } from '$lib/domain';
  import {
    accountSchema,
    executionHost,
    computerViews,
    computerViewId,
    reconcileDiscoveredWsl,
    type Installation,
    type Account,
    type Environment,
    type WslDiscovery,
    type CliInventory,
    type Connection,
    sharedContextChoice,
    applySharedContextChoice,
    lendingConnection,
  } from '$lib/fleet';
  import ChoicePicker from './ChoicePicker.svelte';
  import ConnectionDialog from './ConnectionDialog.svelte';
  import AccountUsage from './AccountUsage.svelte';
  import { snapshotFor, usageKey, type UsageSnapshot } from '$lib/usage';
  import type { Presence } from '$lib/sync';
  import { desktop, contextCache, installCli, type CliUpdates } from '$lib/transport';
  import { cliUpdateSummary } from '$lib/cli-updates';
  let {
    workspace = $bindable(),
    installation,
    wslDiscovery,
    wslError,
    cliInventories,
    cliUpdates,
    statuses = $bindable(),
    usageSnapshots,
    usageLoading,
    usageErrors,
    presence,
    reconnecting = false,
    syncStatus,
    syncError,
    paired,
    save,
    refresh,
    connect,
    disconnect,
    resolveConflict,
    chat,
    providerStatuses,
    login,
    running,
    highlight = '',
  }: {
    workspace: Workspace;
    installation: Installation | undefined;
    wslDiscovery: WslDiscovery | undefined;
    wslError: string;
    cliInventories: Record<string, CliInventory>;
    cliUpdates?: CliUpdates;
    statuses: Record<string, ProviderStatus>;
    usageSnapshots: Record<string, UsageSnapshot>;
    usageLoading: Record<string, boolean>;
    usageErrors: Record<string, string>;
    presence: Presence[];
    reconnecting?: boolean;
    syncStatus: string;
    syncError: string;
    paired: boolean;
    save: () => Promise<void>;
    refresh: () => Promise<void>;
    connect: (url: string, key: string) => Promise<void>;
    disconnect: () => Promise<void>;
    resolveConflict: () => Promise<void>;
    chat: (provider: ProviderId, connectionId?: string, computerId?: string) => void;
    providerStatuses: ProviderStatus[];
    login: (provider: ProviderId, connectionId?: string) => Promise<void>;
    running: boolean;
    /** The connection this visit was opened for, shown and marked until it is connected. */
    highlight?: string;
  } = $props();
  let provider = $state<ProviderId>('claude');
  let name = $state('');
  let linkedAccountId = $state('');
  let createdConnectionId = $state('');
  let creationStage = $state('');
  // The connections, and providers' own logins, whose sign-in is opening. Each opens a console
  // of its own, so one opening never holds back another.
  let signingIn = $state<Record<string, boolean>>({});
  let refreshingConnections = $state(false);
  let error = $state('');
  let busy = $state(false);
  let page = $state<HTMLElement>();
  // Opened for an account: scroll to it and put its sign-in within reach of the keyboard.
  $effect(() => {
    const id = highlight;
    const root = page;
    if (!id || !root) return;
    untrack(() =>
      tick().then(() => {
        const row = root.querySelector<HTMLElement>(`[data-connection="${CSS.escape(id)}"]`);
        const card = row?.closest<HTMLElement>('.fleet-account');
        if (!row || !card) return;
        card.scrollIntoView({ block: 'center' });
        (row.querySelector<HTMLButtonElement>('.sign-in:not(:disabled)') ?? card).focus({
          preventScroll: true,
        });
      }),
    );
  });
  let url = $state(desktop() ? 'http://127.0.0.1:4317' : window.location.origin);
  let key = $state('');
  let computerName = $state('');
  let computerGroup = $state('');
  let dialog = $state<'account' | 'manage-account' | 'computer' | 'relay' | null>(null);
  let managedAccountId = $state('');
  let managedComputerId = $state<string | null>(null);
  let accountName = $state('');
  let sharedSources = $state<Record<string, string>>({});
  let sharedSourcesBaseline = $state<Record<string, string>>({});
  let removing = $state('');
  let environmentId = $state('');
  let accountComputerId = $state('');
  const computers = $derived(
    computerViews(workspace.fleet).sort(
      (a, b) =>
        Number(b.id === ownComputer?.id) - Number(a.id === ownComputer?.id) ||
        a.name.localeCompare(b.name),
    ),
  );
  const unassignedAccounts = $derived(
    workspace.fleet.accounts.filter(
      (account) =>
        !workspace.fleet.connections.some(
          (connection) =>
            connection.accountId === account.id &&
            workspace.fleet.environments.some(
              (environment) =>
                environment.id === connection.environmentId &&
                workspace.fleet.computers.some(
                  (computer) => computer.id === environment.computerId,
                ),
            ),
        ),
    ),
  );
  const targetEnvironment = $derived(
    workspace.fleet.environments.find((e) => e.id === (environmentId || installation?.id)),
  );
  function localEnvironment(id: string) {
    return executionHost(workspace.fleet, id) === installation?.id;
  }
  const ownEnvironment = $derived(
    workspace.fleet.environments.find((e) => e.id === installation?.id),
  );
  const ownComputer = $derived(
    workspace.fleet.computers.find((c) => c.id === ownEnvironment?.computerId),
  );
  const selectedProvider = $derived(
    workspace.fleet.accounts.find((a) => a.id === linkedAccountId)?.provider ?? provider,
  );
  function connectionOnTarget(accountId: string) {
    return workspace.fleet.connections.find(
      (connection) =>
        connection.accountId === accountId && connection.environmentId === targetEnvironment?.id,
    );
  }
  const managedAccount = $derived(workspace.fleet.accounts.find((a) => a.id === managedAccountId));
  const managedConnections = $derived(
    workspace.fleet.connections.filter(
      (c) => c.accountId === managedAccountId && onComputer(c.environmentId, managedComputerId),
    ),
  );
  // Where the managed account can also connect while it has no connection there: this computer,
  // and each WSL distribution it manages that has the agent's CLI, where an account removed after
  // joining by itself is not added again.
  const connectTargets = $derived(
    !installation || !managedAccount
      ? []
      : computers.filter(
          (computer) =>
            (computer.id === ownComputer?.id ||
              (computer.wsl &&
                computer.environments.some(
                  (e) =>
                    localEnvironment(e.id) &&
                    managedAccount.provider !== 'gemini' &&
                    cliInstalled(e.id, managedAccount.provider),
                ))) &&
            !workspace.fleet.connections.some(
              (c) => c.accountId === managedAccountId && onComputer(c.environmentId, computer.id),
            ),
        ),
  );
  function cliInstalled(environmentId: string, provider: ProviderId) {
    const inventory = cliInventories[environmentId];
    return (
      !!inventory?.entries?.some((entry) => entry.id === provider && entry.path) && !inventory.error
    );
  }
  function connectableProviders(computerId: string) {
    const environments = computers.find((c) => c.id === computerId)?.environments ?? [];
    return providerIds.filter(
      (id) =>
        id !== 'gemini' &&
        environments.some((e) => localEnvironment(e.id) && cliInstalled(e.id, id)),
    );
  }
  function distroState(environment: Environment) {
    if (
      !environment.distribution ||
      ownEnvironment?.computerId !== environment.computerId ||
      installation?.platform !== 'windows'
    )
      return '';
    if (wslError) return 'WSL state unavailable';
    const distro = wslDiscovery?.distributions.find(
      (d) => d.name.toLowerCase() === environment.distribution?.toLowerCase(),
    );
    return !wslDiscovery
      ? 'Checking WSL…'
      : !distro
        ? 'Not detected in Windows'
        : distro.running === null
          ? 'WSL state unavailable'
          : distro.running
            ? 'WSL running'
            : 'WSL stopped';
  }
  async function action(fn: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await fn();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
      creationStage = '';
    }
  }
  // Sign-in opens a console of its own, so neither other actions here, other sign-ins nor
  // replies running in any chat hold it back.
  async function openSignIn(id: ProviderId, connectionId?: string) {
    const key = connectionId ?? id;
    if (signingIn[key]) return;
    signingIn[key] = true;
    error = '';
    try {
      await login(id, connectionId);
    } catch (e) {
      error = String(e);
    } finally {
      delete signingIn[key];
    }
  }
  // Why sign-in cannot open, shown on its button. Only a check that found no CLI stops it:
  // sign-in never waits for a check, and after a failed one the sign-in reports what stops it.
  function signInUnavailable(status: ProviderStatus | undefined, provider: ProviderId) {
    if (!desktop()) return 'Sign in on the computer that runs this account.';
    return status && !status.installed && !status.checkFailed
      ? `Install the ${providers[provider].name} CLI on this computer, then refresh Connections to sign in.`
      : '';
  }
  async function add() {
    if (
      !installation ||
      !targetEnvironment ||
      !localEnvironment(targetEnvironment.id) ||
      computerViewId(targetEnvironment) !== accountComputerId
    )
      throw new Error('Choose an environment on this computer.');
    if (createdConnectionId) {
      creationStage = 'Opening sign-in…';
      await login(selectedProvider, createdConnectionId);
      closeDialog();
      return;
    }
    const account = linkedAccountId
      ? workspace.fleet.accounts.find((a) => a.id === linkedAccountId)
      : accountSchema.parse({ id: crypto.randomUUID(), name, provider, purpose: 'personal' });
    if (!account) throw new Error('Choose an account.');
    if (!cliInstalled(targetEnvironment.id, account.provider))
      throw new Error('Install this CLI on the selected computer, then refresh Connections.');
    if (account.provider === 'gemini')
      throw new Error('Additional accounts are supported for Claude and Codex.');
    if (linkedAccountId && connectionOnTarget(linkedAccountId))
      throw new Error('This account is already connected on this computer.');
    const connection = {
      id: crypto.randomUUID(),
      environmentId: targetEnvironment.id,
      accountId: account.id,
      profile: 'isolated' as const,
    };
    creationStage = 'Creating account…';
    if (!linkedAccountId) workspace.fleet.accounts.push(account);
    workspace.fleet.connections.push(connection);
    try {
      await save();
    } catch (e) {
      workspace.fleet.connections = workspace.fleet.connections.filter(
        (c) => c.id !== connection.id,
      );
      if (!linkedAccountId)
        workspace.fleet.accounts = workspace.fleet.accounts.filter((a) => a.id !== account.id);
      throw e;
    }
    createdConnectionId = connection.id;
    // A separate WSL profile that borrows its account's Windows login has nothing to sign in to.
    if (lendingConnection(workspace.fleet, connection)) {
      closeDialog();
      void refresh();
      return;
    }
    statuses[connection.id] = {
      id: account.provider,
      installed: true,
      auth: 'login',
      version: null,
      detail: 'Sign in to connect this account.',
    };
    creationStage = 'Opening sign-in…';
    await login(account.provider, connection.id);
    closeDialog();
  }
  function presenceFor(id: string) {
    return presence.find((p) => p.environmentId === executionHost(workspace.fleet, id));
  }
  function connectionStatus(id: string, environmentId: string) {
    if (localEnvironment(environmentId))
      return !statuses[id]
        ? 'Checking…'
        : statuses[id]?.auth === 'ready'
          ? 'Connected'
          : statuses[id]?.checkFailed
            ? 'Could not check this account'
            : !statuses[id]?.installed
              ? 'Install the CLI'
              : statuses[id]?.auth === 'login'
                ? 'Sign-in needed'
                : 'Sign in or refresh';
    const host = presenceFor(environmentId);
    if (!paired || !host?.online) return 'Offline';
    const reported = host.connections.find((c) => c.connectionId === id);
    return reported?.auth === 'ready'
      ? 'Connected'
      : reported?.installed && reported.auth === 'login'
        ? 'Sign-in needed on its computer'
        : 'Needs attention on host';
  }
  // A status that asks for the user, as an account to sign in to does.
  const needsAttention = (status: string) =>
    status.startsWith('Sign-in needed') || status === 'Needs attention on host';

  function closeDialog() {
    dialog = null;
    error = '';
    removing = '';
    creationStage = '';
  }
  function manageAccount(account: Account, computerId: string | null) {
    managedAccountId = account.id;
    managedComputerId = computerId;
    accountName = account.name;
    sharedSources = Object.fromEntries(
      workspace.fleet.connections.map((c) => [c.id, sharedContextChoice(c)]),
    );
    sharedSourcesBaseline = { ...sharedSources };
    error = '';
    removing = '';
    dialog = 'manage-account';
  }
  function sharedOptions(connection: Connection) {
    const isSource = workspace.fleet.connections.some(
      (c) => c.sharedContextConnectionId === connection.id,
    );
    return [
      { id: 'computer', name: 'This computer’s CLI context' },
      { id: '', name: 'This account only' },
      ...workspace.fleet.connections
        .filter(
          (c) =>
            !isSource &&
            c.id !== connection.id &&
            c.environmentId === connection.environmentId &&
            !c.sharedContextConnectionId &&
            workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider ===
              managedAccount?.provider,
        )
        .map((c) => ({
          id: c.id,
          name:
            workspace.fleet.accounts.find((a) => a.id === c.accountId)?.name ??
            'Unavailable account',
        })),
    ];
  }
  function openAccount(
    id: ProviderId = 'claude',
    computerId = ownComputer?.id ?? '',
    accountId = '',
  ) {
    const available = connectableProviders(computerId);
    provider = available.includes(id) ? id : (available[0] ?? id);
    linkedAccountId = accountId;
    createdConnectionId = '';
    creationStage = '';
    accountComputerId = computerId;
    environmentId =
      workspace.fleet.environments.find(
        (environment) =>
          computerViewId(environment) === computerId &&
          localEnvironment(environment.id) &&
          !environment.discoveredOn,
      )?.id ??
      workspace.fleet.environments.find(
        (environment) =>
          computerViewId(environment) === computerId && localEnvironment(environment.id),
      )?.id ??
      '';
    name = workspace.fleet.accounts.find((a) => a.id === accountId)?.name ?? '';
    error = '';
    dialog = 'account';
  }
  function openComputer() {
    computerName = ownComputer?.name ?? '';
    computerGroup = ownEnvironment?.computerId ?? '';
    error = '';
    dialog = 'computer';
  }
  function providerStatus(id: ProviderId) {
    return providerStatuses.find((s) => s.id === id);
  }
  function locationName(id: string) {
    const environment = workspace.fleet.environments.find((e) => e.id === id);
    return environment?.name ?? 'Unknown environment';
  }
  function computerAccounts(computerId: string, provider: ProviderId) {
    return workspace.fleet.accounts.filter(
      (account) =>
        account.provider === provider &&
        workspace.fleet.connections.some(
          (connection) =>
            connection.accountId === account.id &&
            workspace.fleet.environments.some(
              (environment) =>
                environment.id === connection.environmentId &&
                computerViewId(environment) === computerId,
            ),
        ),
    );
  }
  function onComputer(environmentId: string, computerId: string | null) {
    return (
      computerId === null ||
      workspace.fleet.environments.some(
        (environment) =>
          environment.id === environmentId && computerViewId(environment) === computerId,
      )
    );
  }
  function computerStatus(computerId: string) {
    const computer = computers.find((c) => c.id === computerId);
    if (computer?.wsl && computer.environments.some((e) => localEnvironment(e.id)))
      return distroState(computer.environments[0]);
    const hosts = workspace.fleet.environments
      .filter((environment) => computerViewId(environment) === computerId)
      .map((environment) => presenceFor(environment.id));
    if (computerId === ownComputer?.id) return running ? 'Working' : 'This computer';
    if (!paired || !hosts.some((host) => host?.online)) return 'Offline';
    return hosts.some((host) => host?.online && host.running.length) ? 'Working' : 'Online';
  }
  // CLIs installing in a WSL distribution, by environment and provider, and why the last attempt
  // failed. An install never holds back the page's other actions.
  let installing = $state<Record<string, boolean>>({});
  let installErrors = $state<Record<string, string>>({});
  const installKey = (environmentId: string, provider: ProviderId) =>
    `${environmentId}:${provider}`;
  function cliMissing(environmentId: string, provider: ProviderId) {
    const inventory = cliInventories[environmentId];
    return (
      !inventory?.checking &&
      !inventory?.error &&
      !!inventory?.entries?.some((entry) => entry.id === provider && !entry.path)
    );
  }
  async function install(environmentId: string, provider: ProviderId) {
    const key = installKey(environmentId, provider);
    if (installing[key] || provider === 'gemini') return;
    installing[key] = true;
    delete installErrors[key];
    try {
      await installCli(provider, environmentId);
      await refresh();
    } catch (e) {
      installErrors[key] = String(e).replace(/^Error: /, '');
    } finally {
      delete installing[key];
    }
  }
  // The login an account's connection on the Windows computer reports, to sign the same account
  // in inside one of its distributions. A borrowed login signs in on Windows instead.
  function hostIdentity(connection: Connection) {
    const environment = workspace.fleet.environments.find((e) => e.id === connection.environmentId);
    if (!environment?.discoveredOn || lendingConnection(workspace.fleet, connection))
      return undefined;
    const host = workspace.fleet.connections.find(
      (c) => c.accountId === connection.accountId && c.environmentId === environment.discoveredOn,
    );
    return (host && statuses[host.id]?.account) || undefined;
  }
  function inventoryLabel(environmentId: string, provider: ProviderId) {
    const inventory = cliInventories[environmentId];
    const entry = inventory?.entries?.find((entry) => entry.id === provider);
    if (inventory?.checking) return entry ? 'Updating…' : 'Checking installation…';
    if (inventory?.error) return entry ? 'Last check' : 'Installation unknown';
    return entry ? (entry.path ? 'Installed' : 'Not installed') : 'Installation unknown';
  }
</script>

{#snippet accountCard(account: Account, computerId: string | null)}
  {@const connections = workspace.fleet.connections.filter(
    (c) => c.accountId === account.id && onComputer(c.environmentId, computerId),
  )}
  {@const target = connections.find((c) => c.id === highlight)}
  <div
    class="fleet-account"
    class:highlighted={!!target &&
      connectionStatus(target.id, target.environmentId) !== 'Connected'}
    tabindex="-1"
  >
    <div class="fleet-account-heading">
      <div>
        <h4>{account.name}</h4>
        {#if computerId === null}<small>{providers[account.provider].name}</small>{/if}
      </div>
      <button
        class="icon-button manage-account"
        aria-label="Manage account"
        title="Manage account"
        aria-haspopup="dialog"
        onclick={() => manageAccount(account, computerId)}><Settings2 size={16} /></button
      >
    </div>
    {#each connections as connection}
      {@const status = connectionStatus(connection.id, connection.environmentId)}
      {@const attention = needsAttention(status)}
      {@const usageSettings = {
        provider: account.provider,
        model: '',
        connectionId: connection.id,
      }}
      {@const key = usageKey(usageSettings)}
      <div
        class="account-connection"
        data-connection={connection.id}
        aria-label={'Account actions in ' + locationName(connection.environmentId)}
      >
        <div class="connection-controls">
          {#if status !== 'Connected'}<p class="connection-hint" class:attention>
              {#if attention}<CircleAlert size={14} aria-hidden="true" />{/if}{status}
            </p>{/if}
          <div class="fleet-actions">
            <button class="secondary" onclick={() => chat(account.provider, connection.id)}
              >Chat<ArrowUpRight size={13} /></button
            >
            {#if localEnvironment(connection.environmentId)}
              {@const blocked = signInUnavailable(statuses[connection.id], account.provider)}
              <button
                class={['sign-in', attention ? 'secondary' : 'text-button']}
                disabled={!!signingIn[connection.id] || !!blocked}
                title={blocked || undefined}
                onclick={() => openSignIn(account.provider, connection.id)}
                >{#if signingIn[connection.id]}<LoaderCircle size={13} class="spinning" />Opening
                  sign-in…{:else}Open sign-in{/if}</button
              >{/if}
          </div>
          {#if localEnvironment(connection.environmentId) && statuses[connection.id]?.detail && statuses[connection.id]?.auth !== 'ready'}<p
              class="connection-hint"
            >
              {statuses[connection.id].detail}
            </p>{/if}
          {#if statuses[connection.id]?.auth === 'login' && hostIdentity(connection)}<p
              class="connection-hint"
            >
              Sign in as {hostIdentity(connection)}, the login this account uses on its Windows
              computer.
            </p>{/if}
        </div>
        <AccountUsage
          connectionId={connection.id}
          provider={account.provider}
          name={account.name}
          snapshot={snapshotFor(usageSnapshots, usageSettings)}
          loading={!!usageLoading[key]}
          error={usageErrors[key] ?? ''}
          unavailable={status === 'Connected'
            ? ''
            : status === 'Offline'
              ? 'Computer offline. Usage is unavailable.'
              : status === 'Sign-in needed' || status === 'Sign in or refresh'
                ? 'Sign in to read usage.'
                : status === 'Checking…'
                  ? 'Checking account availability…'
                  : status === 'Install the CLI'
                    ? 'Install the CLI to read usage.'
                    : status === 'Could not check this account'
                      ? 'Refresh Connections to check this account and read its usage.'
                      : 'Connect the account on its computer to read usage.'}
        />
      </div>
    {:else}<p class="connection-hint">No computers connected yet.</p>{/each}
  </div>
{/snippet}

<div class="page-scroll" bind:this={page}>
  <div class="page-content fleet-page">
    <section class="page-heading">
      <div>
        <h1>Connections</h1>
        <p>Choose a computer to manage its accounts and CLIs.</p>
      </div>
      <button
        class="secondary refresh-connections"
        disabled={busy}
        aria-busy={refreshingConnections}
        onclick={() =>
          action(async () => {
            refreshingConnections = true;
            try {
              await refresh();
            } finally {
              refreshingConnections = false;
            }
          })}
        ><RefreshCw size={15} class={refreshingConnections ? 'spinning' : undefined} />Refresh
        connections</button
      >
    </section>
    {#if error && !dialog}<div class="error-banner" role="alert">{error}</div>{/if}
    <section class="computers-section" aria-labelledby="computers-heading">
      <div class="section-heading">
        <div>
          <h2 id="computers-heading">Your computers</h2>
          <span>Accounts and CLIs live with the computer that runs them.</span>
        </div>
        <span class="computer-count"
          >{computers.length} {computers.length === 1 ? 'computer' : 'computers'}</span
        >
      </div>
      <div class="fleet-computers">
        {#each computers as computer (computer.id)}
          {@const environments = computer.environments}
          {@const local = environments.some((environment) => localEnvironment(environment.id))}
          <article class="fleet-computer" aria-label={computer.name + ' computer'}>
            <header class="computer-heading">
              <span class="computer-icon"
                >{#if computer.wsl}<Server size={21} />{:else}<Monitor size={21} />{/if}</span
              >
              <div class="computer-identity">
                <h3>{computer.name}</h3>
                <span class="computer-state" class:ready={computerStatus(computer.id) !== 'Offline'}
                  >{computerStatus(computer.id)}</span
                >
              </div>
              {#if local}<div class="fleet-actions">
                  <button
                    class="secondary"
                    disabled={busy || !installation || !connectableProviders(computer.id).length}
                    onclick={() => openAccount('claude', computer.id)}
                    ><Plus size={14} />Add account</button
                  >{#if computer.id === ownComputer?.id}<button
                      class="icon-button"
                      aria-label={'Manage computer ' + computer.name}
                      title="Manage computer"
                      disabled={busy}
                      onclick={openComputer}><Settings2 size={17} /></button
                    >{/if}
                </div>{/if}
            </header>
            {#if computer.wsl}<p class="computer-hint">
                Linux CLI installations in this distribution are shown below. Managed through {computer.hostName}.
                Chats in its folders run here, with only its Linux CLI and login. Checking
                installations can start WSL.
              </p>{:else if local && installation?.platform === 'windows'}<p class="computer-hint">
                Selecting this computer uses its Windows CLIs. Choosing a folder inside a WSL
                distribution moves the chat to that distribution, which runs it with its own CLI.
              </p>{/if}
            {#if computer.id === ownComputer?.id && wslError}<p class="sync-error" role="alert">
                {wslError}
              </p>{/if}
            {#each environments.filter((e) => localEnvironment(e.id) && cliInventories[e.id]?.error) as environment}<p
                class="sync-error"
                role="alert"
              >
                {environment.name}: {cliInventories[environment.id]
                  .error}{#if cliInventories[environment.id].entries}
                  Showing the last successful installation check.{/if}
              </p>{/each}
            {#if environments.length}
              <div class="computer-providers" aria-label={'Accounts and CLIs on ' + computer.name}>
                {#each providerIds as id}
                  {@const accounts = computerAccounts(computer.id, id)}
                  {@const cliEnvironment = environments.find((e) => localEnvironment(e.id))}
                  {@const cliEntry =
                    cliEnvironment &&
                    cliInventories[cliEnvironment.id]?.entries?.find((entry) => entry.id === id)}
                  {@const cliUpdate = cliEnvironment
                    ? cliUpdates?.statuses.find(
                        (s) => s.provider === id && s.environmentId === cliEnvironment.id,
                      )
                    : undefined}
                  <article
                    class="connection-card provider-group"
                    aria-label={providers[id].name + ' connections'}
                  >
                    <div
                      class="provider-overview"
                      aria-label={cliEnvironment
                        ? providers[id].name + ' installation in ' + cliEnvironment.name
                        : undefined}
                    >
                      <header class="provider-heading">
                        <span class="provider-icon" style:--provider-color={providers[id].color}
                          >{providers[id].mark}</span
                        >
                        <div class="provider-identity">
                          <h4>{providers[id].name}</h4>
                          <span class="small muted"
                            >{accounts.length
                              ? accounts.length + (accounts.length === 1 ? ' account' : ' accounts')
                              : id === 'gemini'
                                ? 'Google · Antigravity CLI'
                                : providers[id].company}</span
                          >
                        </div>
                        {#if cliEnvironment}<strong
                            class="installation-status"
                            class:ready={!!cliEntry?.path &&
                              !cliInventories[cliEnvironment.id]?.error}
                            >{inventoryLabel(cliEnvironment.id, id)}</strong
                          >{/if}
                      </header>
                      {#if cliEntry?.path}<div class="cli-location">
                          <span>CLI path</span><code title={cliEntry.path}>{cliEntry.path}</code>
                        </div>{/if}
                      {#if cliUpdate}<div class="cli-location" title={cliUpdateSummary(cliUpdate)}>
                          <span>Version</span><code>{cliUpdate.version ?? 'unknown'}</code><span
                            class="cli-update"
                            class:failed={cliUpdate.phase === 'failed'}
                            >{cliUpdate.phase === 'updated'
                              ? cliUpdate.previous
                                ? 'Updated from ' + cliUpdate.previous
                                : 'Updated'
                              : cliUpdate.phase === 'checking'
                                ? 'Checking for updates…'
                                : cliUpdate.phase === 'current'
                                  ? 'Up to date'
                                  : cliUpdate.phase === 'waiting'
                                    ? 'Update waiting'
                                    : cliUpdate.phase === 'failed'
                                      ? 'Update failed'
                                      : 'Not updated automatically'}</span
                          >
                        </div>{/if}
                      {#if cliEnvironment && computer.wsl && id !== 'gemini'}
                        {@const key = installKey(cliEnvironment.id, id)}
                        {#if cliMissing(cliEnvironment.id, id) || installing[key] || installErrors[key]}<div
                            class="cli-install"
                          >
                            <p class:sync-error={!!installErrors[key]}>
                              {installErrors[key] ||
                                `Install ${providers[id].name} in ${computer.name} to run chats in its folders with its own Linux CLI. Its official installer downloads it.`}
                            </p>
                            <button
                              class="secondary"
                              disabled={!!installing[key] || !desktop()}
                              onclick={() => install(cliEnvironment.id, id)}
                              >{#if installing[key]}<LoaderCircle
                                  size={13}
                                  class="spinning"
                                />Installing…{:else}Install {providers[id].name}{/if}</button
                            >
                          </div>{/if}
                      {/if}
                    </div>
                    {#each accounts as account (account.id)}
                      {@render accountCard(account, computer.id)}
                    {:else}{#if local && computer.wsl}
                        <div class="current-login">
                          <p>
                            {id === 'gemini'
                              ? 'Antigravity chat connections are not supported through WSL.'
                              : cliInstalled(environments[0].id, id)
                                ? 'Connect an account using the Linux CLI in this distribution.'
                                : cliInventories[environments[0].id]?.error ||
                                    !cliInventories[environments[0].id]?.entries
                                  ? 'Refresh Connections to check whether this CLI is installed.'
                                  : 'Install this CLI in ' +
                                    computer.name +
                                    ', then refresh Connections.'}
                          </p>
                          {#if id !== 'gemini' && cliInstalled(environments[0].id, id)}<button
                              class="secondary"
                              disabled={busy || !desktop()}
                              onclick={() => openAccount(id, computer.id)}>Add account</button
                            >{/if}
                        </div>
                      {:else if local}
                        {@const blocked = signInUnavailable(providerStatus(id), id)}
                        <div class="current-login">
                          {#if !providerStatus(id)}<p>Checking login…</p>
                          {:else if !providerStatus(id)?.installed}<p>
                              Install {providers[id].name} to connect an account.
                            </p>
                          {:else if providerStatus(id)?.auth !== 'ready'}<p>
                              {providerStatus(id)?.detail ?? 'Sign in to connect your account.'}
                            </p>{/if}
                          <div class="fleet-actions">
                            <button
                              class="text-button"
                              disabled={!!signingIn[id] || !!blocked}
                              title={blocked || undefined}
                              onclick={() => openSignIn(id)}
                              >{#if signingIn[id]}<LoaderCircle size={13} class="spinning" />Opening
                                sign-in…{:else}Open sign-in{/if}</button
                            >{#if providerStatus(id)?.auth === 'ready'}<button
                                class="secondary"
                                onclick={() => chat(id, undefined, computer.id)}
                                >Start chat<ArrowUpRight size={13} /></button
                              >{/if}
                          </div>
                        </div>
                      {:else}<p class="connection-hint remote-empty">
                          No account connected on this computer.
                        </p>{/if}{/each}
                  </article>
                {/each}
              </div>
              {#if !local}<p class="computer-hint remote-hint">
                  Use connected accounts here when {computer.name} is online. Add CLI profiles and complete
                  sign-in in Agent Studio on {computer.name}.
                </p>{/if}
            {:else}<p class="connection-hint">No environments connected to this computer.</p>
              <button
                class="text-button"
                disabled={busy}
                onclick={() =>
                  action(async () => {
                    workspace.fleet.computers = workspace.fleet.computers.filter(
                      (c) => c.id !== computer.id,
                    );
                    await save();
                  })}>Remove empty computer</button
              >{/if}
          </article>
        {:else}<p class="connection-hint">Loading this computer’s connections…</p>{/each}
      </div>
    </section>
    {#if unassignedAccounts.length}<details class="unassigned-accounts">
        <summary>Accounts without a computer <span>{unassignedAccounts.length}</span></summary>
        <p class="connection-hint">
          These saved account labels are available when you add an account to a computer.
        </p>
        {#each unassignedAccounts as account (account.id)}{@render accountCard(
            account,
            null,
          )}{/each}
      </details>{/if}
    <section class="fleet-relay" aria-labelledby="sync-heading">
      <div class="relay-title">
        <Server size={18} />
        <h2 id="sync-heading">Workspace sync</h2>
      </div>
      <div class="relay-state">
        <span class="connection-badge" class:connected={paired && !syncError}
          ><i></i>{paired || reconnecting
            ? syncError
              ? 'Reconnecting'
              : 'Paired'
            : 'Local only'}</span
        >
      </div>
      <p>
        {paired
          ? syncStatus
          : 'Connect your computers and phone to your private workspace. Each person uses their own workspace key.'}
      </p>
      {#if syncError}<p class="sync-error" role="alert">{syncError}</p>{/if}
      {#if syncError.includes('changed on both devices')}<button
          class="secondary"
          disabled={busy}
          onclick={() => action(resolveConflict)}>Back up local data & use relay settings</button
        >{/if}
      {#if paired && !syncError}<details class="sync-settings">
          <summary>Sync settings</summary>
          <p>Keep Agent Studio open on each computer you want to use. WSL uses its Windows host.</p>
          <button class="text-button" disabled={busy} onclick={() => action(disconnect)}
            >{desktop() ? 'Disconnect relay' : 'Sign out'}</button
          >
        </details>{:else}<button
          class="secondary"
          disabled={busy}
          onclick={() => {
            error = '';
            dialog = 'relay';
          }}><Link size={14} />Set up sync</button
        >{/if}
      {#if syncError && (paired || reconnecting)}<button
          class="text-button"
          disabled={busy}
          onclick={() => action(disconnect)}>{desktop() ? 'Disconnect relay' : 'Sign out'}</button
        >{/if}
    </section>
  </div>
</div>

{#if dialog === 'account'}<ConnectionDialog title="Add account" {busy} close={closeDialog}>
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <form
      aria-busy={busy}
      onsubmit={(event) => {
        event.preventDefault();
        void action(add);
      }}
    >
      <p>
        Add an account on <strong
          >{computers.find((computer) => computer.id === accountComputerId)?.name ??
            'this computer'}</strong
        >.
      </p>
      <div class="fleet-fields">
        {#if !linkedAccountId}<div class="fleet-field">
            <span>Provider</span><ChoicePicker
              field
              label="Account provider"
              value={provider}
              disabled={busy || !!createdConnectionId}
              options={connectableProviders(accountComputerId).map((id) => ({
                id,
                name: providers[id].name,
                mark: providers[id].mark,
                color: providers[id].color,
              }))}
              onchange={(value) => (provider = value as ProviderId)}
            />
          </div>{/if}
        <label
          >Account name<input
            aria-label="Account name"
            bind:value={name}
            maxlength="60"
            required
            disabled={busy || !!createdConnectionId || !!linkedAccountId}
          /></label
        >
      </div>
      <p>Sign in with your additional account in the terminal that opens.</p>
      {#if creationStage}<p class="account-progress" role="status">
          <LoaderCircle size={15} class="spinning" />{creationStage}
        </p>{/if}
      <div class="dialog-actions">
        <button class="secondary" type="button" disabled={busy} onclick={closeDialog}>Cancel</button
        >
        <button
          class="primary"
          disabled={busy ||
            !installation ||
            !targetEnvironment ||
            !name.trim() ||
            !cliInstalled(targetEnvironment.id, selectedProvider)}
        >
          {#if busy}<LoaderCircle
              size={15}
              class="spinning"
            />{creationStage}{:else if createdConnectionId}Retry sign-in{:else}Add account<Plus
              size={15}
            />{/if}
        </button>
      </div>
    </form>
  </ConnectionDialog>
{:else if dialog === 'manage-account' && managedAccount}<ConnectionDialog
    title="Manage account"
    {busy}
    close={closeDialog}
  >
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void action(async () => {
          if (!managedAccount) return;
          const editedAccount = managedAccount;
          const previousName = editedAccount.name;
          const nextAccount = accountSchema.parse({ ...editedAccount, name: accountName });
          const editedConnections = managedConnections.map((connection) => ({
            connection,
            before: sharedContextChoice(connection),
            after: sharedSources[connection.id] ?? '',
            snapshot: { ...connection },
          }));
          const converting = managedConnections.filter(
            (connection) =>
              connection.profile === 'existing' && (sharedSources[connection.id] ?? '') === '',
          );
          for (const connection of converting) {
            if (!localEnvironment(connection.environmentId))
              throw new Error('Separate this login on its own computer.');
            if (!cliInstalled(connection.environmentId, managedAccount.provider))
              throw new Error('Install this CLI on the selected computer, then refresh Connections.');
            if (managedAccount.provider === 'gemini')
              throw new Error('Separate profiles are supported for Claude and Codex.');
          }
          for (const connection of workspace.fleet.connections) {
            if (sharedContextChoice(connection) !== (sharedSourcesBaseline[connection.id] ?? ''))
              throw new Error(
                'Shared context changed elsewhere. Reopen Manage account before saving.',
              );
          }
          for (const connection of managedConnections) {
            if (sharedContextChoice(connection) !== sharedSourcesBaseline[connection.id])
              throw new Error(
                'This account’s shared context changed elsewhere. Reopen Manage account before saving.',
              );
            const source = sharedSources[connection.id] ?? '';
            if (running && source !== sharedContextChoice(connection))
              throw new Error('Wait for the running reply before changing shared context.');
            if (source && !sharedOptions(connection).some((option) => option.id === source))
              throw new Error(
                'The shared context source changed. Reopen Manage account and choose it again.',
              );
          }
          Object.assign(editedAccount, nextAccount);
          for (const connection of managedConnections)
            applySharedContextChoice(connection, sharedSources[connection.id] ?? '');
          try {
            await save();
          } catch (error) {
            if (editedAccount.name === nextAccount.name) editedAccount.name = previousName;
            for (const { connection, after, snapshot } of editedConnections) {
              if (sharedContextChoice(connection) !== after) continue;
              for (const key of Object.keys(connection) as (keyof Connection)[])
                if (!(key in snapshot)) delete connection[key];
              Object.assign(connection, snapshot);
            }
            throw error;
          }
          contextCache.clear();
          for (const connection of converting) {
            statuses[connection.id] = {
              id: managedAccount.provider,
              installed: true,
              auth: 'login',
              version: null,
              detail: 'Sign in to connect this account.',
            };
          }
          const opened = converting[0];
          closeDialog();
          if (opened) await login(managedAccount.provider, opened.id);
        });
      }}
    >
      <p class="management-context">
        {providers[managedAccount.provider].name}{#if managedComputerId}
          · {computers.find((c) => c.id === managedComputerId)?.name ?? 'Unavailable computer'}{/if}
      </p>
      <label
        >Account name<input
          aria-label="Edit account name"
          bind:value={accountName}
          required
          maxlength="60"
        /></label
      >
      {#each managedConnections as connection}
        <section
          class="managed-connection"
          aria-label={'Connection in ' + locationName(connection.environmentId)}
        >
          <div>
            <h3>
              {connection.profile === 'isolated' ? 'Separate CLI profile' : 'Existing CLI login'}
            </h3>
            <p>
              {connection.profile === 'isolated'
                ? 'This account has its own login and settings. By default it uses this computer’s CLI context.'
                : 'Shares the login and settings you use in your terminal.'}
            </p>
          </div>
          {#if managedAccount.provider !== 'gemini'}
            <div class="shared-context-control">
              <span>Shared context source</span>
              <ChoicePicker
                field
                label="Shared context source"
                options={sharedOptions(connection)}
                value={sharedSources[connection.id] ?? ''}
                fallbackToFirst={false}
                placeholder="Source unavailable"
                disabled={busy || running}
                onchange={(value) => (sharedSources[connection.id] = value)}
              />
              <p>
                {#if connection.profile === 'existing' && (sharedSources[connection.id] ?? '') === ''}
                  Saving creates a separate profile for this account on this computer and opens its
                  sign-in. Existing chats continue from the terminal’s history, and the terminal
                  keeps its own login and files.
                {:else}
                  This computer’s CLI context is the terminal’s instructions, rules, skills, project
                  memories, and MCP server definitions. Choose another account to use its context
                  instead, or This account only to keep this profile separate. Logins and MCP
                  sign-ins always stay with the account. Applies to the next reply.
                {/if}
              </p>
            </div>
          {/if}
          {#if localEnvironment(connection.environmentId)}
            {#if removing === connection.id}<div
                class="remove-connection"
                role="group"
                aria-label="Confirm disconnection"
              >
                <p>Remove this connection? Saved chats and the CLI’s login files are kept.</p>
                <div class="fleet-actions">
                  <button
                    class="secondary"
                    type="button"
                    disabled={busy}
                    onclick={() =>
                      action(async () => {
                        workspace.fleet.connections = workspace.fleet.connections.filter(
                          (c) => c.id !== connection.id,
                        );
                        delete statuses[connection.id];
                        await save();
                        closeDialog();
                      })}>Remove connection</button
                  >
                  <button
                    class="text-button"
                    type="button"
                    disabled={busy}
                    onclick={() => (removing = '')}>Keep connection</button
                  >
                </div>
              </div>
            {:else}<button
                class="text-button disconnect-connection"
                type="button"
                disabled={busy}
                onclick={() => (removing = connection.id)}
                >{managedConnections.length > 1
                  ? 'Disconnect ' + locationName(connection.environmentId)
                  : 'Disconnect account'}</button
              >{/if}
          {:else}<p>Manage this connection on its computer.</p>{/if}
        </section>
      {/each}
      {#if connectTargets.length}<div class="managed-connect">
          {#each connectTargets as computer (computer.id)}<button
              class="text-button"
              type="button"
              disabled={busy ||
                (computer.id === ownComputer?.id &&
                  !cliInstalled(installation?.id ?? '', managedAccount.provider))}
              onclick={() => {
                if (managedAccount)
                  openAccount(managedAccount.provider, computer.id, managedAccount.id);
              }}>Connect on {computer.name}</button
            >{/each}
        </div>{/if}
      {#if !workspace.fleet.connections.some((c) => c.accountId === managedAccountId)}<button
          class="text-button disconnect-connection"
          type="button"
          disabled={busy}
          onclick={() =>
            action(async () => {
              workspace.fleet.accounts = workspace.fleet.accounts.filter(
                (a) => a.id !== managedAccountId,
              );
              await save();
              closeDialog();
            })}>Remove account label</button
        >{/if}
      <div class="dialog-actions">
        <button class="secondary" type="button" disabled={busy} onclick={closeDialog}>Cancel</button
        >
        <button class="primary" disabled={busy || !accountName.trim() || !!removing}
          >Save account</button
        >
      </div>
    </form>
  </ConnectionDialog>
{:else if dialog === 'computer' && ownComputer && ownEnvironment}<ConnectionDialog
    title="Manage computer"
    {busy}
    close={closeDialog}
  >
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        void action(async () => {
          if (!computerName.trim()) return;
          ownComputer.name = computerName.trim();
          const oldId = ownEnvironment.computerId;
          if (computerGroup !== oldId) {
            ownEnvironment.computerId = computerGroup;
            for (const environment of workspace.fleet.environments) {
              if (environment.discoveredOn === ownEnvironment.id)
                environment.computerId = computerGroup;
            }
            reconcileDiscoveredWsl(workspace.fleet);
          }
          await save();
          closeDialog();
        });
      }}
    >
      <p>
        Settings for {ownComputer.name}. Its WSL distributions appear as separate computers and
        remain managed by this Windows app.
      </p>
      <label
        >Computer name<input
          aria-label="Computer name"
          bind:value={computerName}
          required
          maxlength="60"
        /></label
      >
      <details>
        <summary>Advanced: group environments</summary>
        <p>Use this when separate app installations belong to the same physical computer.</p>
        <div class="fleet-field">
          <span>Group this environment under</span><ChoicePicker
            field
            label="Group this environment under"
            value={computerGroup}
            options={workspace.fleet.computers}
            disabled={busy}
            onchange={(id) => (computerGroup = id)}
          />
        </div>
      </details>
      <div class="dialog-actions">
        <button class="secondary" type="button" disabled={busy} onclick={closeDialog}>Cancel</button
        ><button class="primary" disabled={busy || !computerName.trim()}>Save computer</button>
      </div>
    </form>
  </ConnectionDialog>
{:else if dialog === 'relay'}<ConnectionDialog
    title="Set up workspace sync"
    {busy}
    close={closeDialog}
  >
    {#if error}<div class="error-banner" role="alert">{error}</div>{/if}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        void action(async () => {
          await connect(url.trim().replace(/\/$/, ''), key.trim());
          key = '';
          closeDialog();
        });
      }}
    >
      <p>
        {desktop()
          ? 'Enter your relay address and private workspace key. Use the same key only on your own computers and phone. Each person sharing the VPS needs a separate workspace key.'
          : 'Enter your private workspace key from the server owner. Each person has separate chats, computers, and agent connections. Keep Agent Studio open on your connected computers.'}
      </p>
      <label
        >Relay URL<input
          aria-label="Relay URL"
          type="url"
          bind:value={url}
          readonly={!desktop()}
          required
        /></label
      ><label
        >Private workspace key<input
          aria-label="Relay pairing key"
          type="password"
          bind:value={key}
          minlength="32"
          autocomplete="off"
          required
        /></label
      >
      <p>
        Pairing shares chat content and account labels with devices in this private workspace.
        Provider credentials stay on each host. {desktop()
          ? installation?.platform === 'windows'
            ? 'Windows protects the saved pairing and reconnects when you open the app. Disconnect relay removes it from this computer.'
            : 'The pairing key stays in memory until the app closes.'
          : 'This device stays paired across app updates and server restarts. Pairing renews while you use it and expires after seven days without renewal, or when you disconnect or change the workspace key. The key is not saved in your browser. Disconnecting clears chats from the screen; another workspace starts with its own data.'}
      </p>
      <div class="dialog-actions">
        <button class="secondary" type="button" disabled={busy} onclick={closeDialog}>Cancel</button
        ><button class="primary" disabled={busy}>Pair & sync<Link size={15} /></button>
      </div>
    </form>
  </ConnectionDialog>{/if}

<style>
  .cli-location {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 0 16px 14px 60px;
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .cli-location span {
    flex-shrink: 0;
  }
  .cli-install {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 0 16px 14px 60px;
  }
  .cli-install p {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
    line-height: var(--leading-normal);
  }
  .cli-install button {
    flex-shrink: 0;
  }
  .cli-location .cli-update {
    flex-shrink: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .cli-location .cli-update.failed {
    color: var(--warning);
  }
  .cli-location code {
    min-width: 0;
    color: var(--text-secondary);
    font-size: var(--text-xs);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .provider-identity {
    flex: 1;
    min-width: 0;
  }
  .installation-status {
    flex-shrink: 0;
    max-width: 120px;
    padding: 1px 8px;
    border-radius: var(--radius-full);
    background: var(--hover);
    text-align: center;
    font-size: var(--text-xs);
    line-height: 1.5;
    font-weight: 500;
    color: var(--text-muted);
  }
  .installation-status.ready {
    background: var(--success-soft);
    color: var(--success);
  }
  .managed-connection {
    border-top: 1px solid var(--border);
    padding-top: 16px;
  }
  .shared-context-control {
    display: grid;
    gap: 7px;
    margin-top: 12px;
  }
  .shared-context-control > span {
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: 600;
  }
  .managed-connection h3 {
    font-size: var(--text-base);
    font-weight: 600;
    margin: 0 0 6px;
  }
  .managed-connect {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
    border-top: 1px solid var(--border);
    padding-top: 16px;
  }
  .remove-connection .fleet-actions {
    margin-top: 12px;
  }
  .management-context {
    margin-top: -6px;
  }
  .fleet-page {
    padding-top: 36px;
    padding-bottom: 32px;
  }
  .section-heading {
    align-items: flex-end;
    margin: 0 0 18px;
    gap: 14px;
  }
  .section-heading > div {
    display: block;
  }
  .section-heading h2 {
    margin: 0 0 4px;
    font-size: var(--text-md);
  }
  .section-heading > div > span {
    display: block;
    color: var(--text-muted);
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
  }
  .computer-count {
    padding: 1px 9px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-muted);
    white-space: nowrap;
  }
  .fleet-computers {
    display: grid;
    gap: 28px;
  }
  .fleet-computer {
    min-width: 0;
  }
  .fleet-computer + .fleet-computer {
    padding-top: 28px;
    border-top: 1px solid var(--border);
  }
  .computer-heading {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 14px;
  }
  .computer-icon {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: var(--radius-lg);
    border: 1px solid var(--border-strong);
    background: var(--surface-2);
    color: var(--text-secondary);
    flex-shrink: 0;
  }
  .computer-identity {
    flex: 1;
    min-width: 0;
  }
  .computer-identity h3 {
    font-size: var(--text-lg);
    margin: 0 0 2px;
    overflow-wrap: anywhere;
  }
  .computer-state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--text-muted);
  }
  .computer-state::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .computer-state.ready {
    color: var(--success);
  }
  .computer-state.ready::before {
    background: var(--success);
    box-shadow: 0 0 0 3px var(--success-soft);
  }
  .computer-hint {
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    color: var(--text-muted);
    margin: 10px 0 0;
  }
  .computer-providers {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    align-items: start;
    margin-top: 16px;
  }
  .provider-group {
    padding: 0;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .provider-heading {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 16px;
  }
  .provider-heading h4 {
    font-size: var(--text-md);
    margin: 0 0 1px;
    font-weight: 600;
  }
  .provider-heading .provider-icon {
    width: 32px;
    height: 32px;
    font-size: 18px;
    border-radius: var(--radius-md);
    flex-shrink: 0;
  }
  .fleet-actions {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .fleet-actions .secondary {
    font-size: var(--text-sm);
    min-height: 30px;
    padding: 4px 11px;
  }
  .fleet-actions .text-button {
    font-size: var(--text-sm);
  }
  .current-login {
    padding: 0 16px 14px;
  }
  .current-login p {
    font-size: var(--text-sm);
    color: var(--text-muted);
    margin: 4px 0 12px;
    line-height: var(--leading-normal);
  }
  .current-login .fleet-actions {
    justify-content: flex-end;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  .fleet-account {
    border-top: 1px solid var(--border);
    padding: 14px 16px 16px;
  }
  .provider-group > .fleet-account:last-child {
    border-radius: 0 0 calc(var(--radius-xl) - 1px) calc(var(--radius-xl) - 1px);
  }
  /* The account Connections was opened for, while it still needs attention. */
  .fleet-account.highlighted {
    background: var(--warning-soft);
    box-shadow: inset 3px 0 0 var(--warning);
  }
  .fleet-account:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: -2px;
  }
  .fleet-account-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 9px;
  }
  .fleet-account-heading h4 {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 600;
  }
  .fleet-account-heading small {
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .fleet-account-heading > .manage-account {
    flex-shrink: 0;
    width: var(--control-sm);
    height: var(--control-sm);
  }
  .account-connection {
    display: grid;
    grid-template-columns: minmax(160px, 0.7fr) minmax(0, 2fr);
    align-items: start;
    gap: 24px;
    margin-top: 12px;
  }
  .connection-controls {
    min-width: 0;
  }
  .connection-controls > .connection-hint:first-child {
    margin-top: 0;
  }
  @media (max-width: 1000px) {
    .account-connection {
      grid-template-columns: minmax(0, 1fr);
      gap: 16px;
    }
  }
  .connection-hint {
    font-size: var(--text-sm);
    color: var(--text-muted);
    line-height: var(--leading-normal);
  }
  .connection-hint.attention {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--warning);
    font-weight: 500;
  }
  .connection-hint.attention > :global(svg) {
    flex-shrink: 0;
  }
  .remote-empty {
    padding: 0 16px 12px;
  }
  .fleet-fields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }
  label,
  .fleet-field {
    display: flex;
    flex-direction: column;
    gap: 7px;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
    min-width: 0;
  }
  input {
    width: 100%;
  }
  .disconnect-connection {
    font-size: var(--text-sm);
    margin-top: 12px;
    color: var(--danger);
  }
  .disconnect-connection:not(:disabled):hover {
    color: var(--danger);
    text-decoration: underline;
  }
  .remove-connection {
    font-size: var(--text-sm);
    padding: 12px 14px;
    border: 1px solid var(--danger-border);
    border-radius: var(--radius-lg);
    background: var(--danger-soft);
    margin-top: 12px;
  }
  .unassigned-accounts {
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--surface-1);
    margin-top: 24px;
    padding: 14px 16px;
  }
  .unassigned-accounts > summary {
    cursor: pointer;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--text-secondary);
  }
  .unassigned-accounts > summary span {
    margin-left: 6px;
    color: var(--text-muted);
  }
  .fleet-relay {
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    align-items: center;
    gap: 16px 20px;
    margin-top: 32px;
    padding: 16px 18px;
    border: 1px solid var(--border);
    background: var(--surface-1);
    border-radius: var(--radius-xl);
  }
  .relay-title {
    display: flex;
    align-items: center;
    gap: 9px;
  }
  .relay-title :global(svg) {
    color: var(--text-muted);
  }
  .relay-title h2 {
    font-size: var(--text-md);
    font-weight: 600;
    margin: 0;
  }
  .fleet-relay p {
    font-size: var(--text-sm);
    line-height: var(--leading-normal);
    color: var(--text-muted);
    margin: 0;
  }
  .fleet-relay > .sync-error {
    grid-column: 1 / -1;
  }
  .sync-settings summary {
    cursor: pointer;
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .sync-settings summary:hover {
    color: var(--text);
  }
  .sync-settings[open] {
    grid-column: 1 / -1;
  }
  .sync-settings p {
    margin: 12px 0;
  }
  .sync-error {
    color: var(--warning) !important;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
    line-height: var(--leading-normal);
  }
  .account-progress {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  @media (max-width: 1190px) {
    .fleet-page {
      padding-inline: 28px;
    }
  }
  @media (max-width: 1000px) {
    .page-heading {
      flex-wrap: wrap;
    }
    .fleet-relay {
      grid-template-columns: 1fr auto;
    }
    .fleet-relay > p {
      grid-column: 1 / -1;
    }
  }
  @media (max-width: 650px) {
    .fleet-page {
      padding-inline: 18px;
    }
    .computer-heading {
      flex-wrap: wrap;
    }
    .computer-heading > .fleet-actions {
      width: 100%;
      justify-content: flex-end;
    }
    .cli-location {
      padding-left: 16px;
    }
    .cli-install {
      flex-wrap: wrap;
      padding-left: 16px;
    }
    .fleet-fields {
      grid-template-columns: 1fr;
    }
  }
</style>
