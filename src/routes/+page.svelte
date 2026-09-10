<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { trackMobileViewport } from '$lib/mobileViewport';
  import {
    ArrowUp,
    ArrowUpRight,
    ArrowRight,
    Plus,
    Bot,
    Cpu,
    Brain,
    Plug,
    Search,
    ChevronRight,
    SlidersHorizontal,
    RefreshCw,
    Square,
    X,
    Trash2,
    Pencil,
    Check,
    Laptop,
    Copy,
    CircleAlert,
    Folder,
    Archive,
    ArchiveRestore,
    BookOpen,
    Paperclip,
  } from '@lucide/svelte';
  import {
    initialWorkspace,
    providerIds,
    providers,
    historyFor,
    messageText,
    settingsFor,
    rememberSettings,
    type ChatSettings,
    type Reasoning,
    type Conversation,
    type Message,
    type ProviderId,
    type ProviderStatus,
    type Workspace,
    type ChatLocation,
  } from '$lib/domain';
  import {
    desktop,
    loadWorkspace,
    loadModels,
    readUsage,
    generateTitle,
    cancelTitle,
    saveWorkspace,
    detectProviders,
    runAgent,
    cancelRun,
    signIn,
    openLink,
    getInstallation,
    discoverWsl,
    inspectEnvironmentClis,
    configureRuntime,
    detectConnection,
    connectRelay,
    disconnectRelay,
    pollRelay,
    resolveRelaySettings,
    listFolders,
    resumeBrowserRelay,
    OfflineHostError,
  } from '$lib/transport';
  import ChatInstructions from '$lib/components/ChatInstructions.svelte';
  import ModelContext from '$lib/components/ModelContext.svelte';
  import { applyRunEvent } from '$lib/activity';
  import WindowTitlebar from '$lib/components/WindowTitlebar.svelte';
  import BrowserStatus from '$lib/components/BrowserStatus.svelte';
  import ToolbarActions from '$lib/components/ToolbarActions.svelte';
  import SidebarResize from '$lib/components/SidebarResize.svelte';
  import FleetManager from '$lib/components/FleetManager.svelte';
  import FolderBrowser from '$lib/components/FolderBrowser.svelte';
  import {
    locationKey,
    locationExecutionId,
    locationExecutionEnvironment,
    computerFolderEnvironments,
    folderName,
    ensureLocationConnections,
    ensureEnvironmentConnections,
    locationConnections,
    rememberLocation,
    knownLocations,
    conversationLocation,
    groupConversations,
  } from '$lib/locations';
  import {
    registerInstallation,
    registerWslEnvironments,
    connectionLabel,
    executionHost,
    computerViewId,
    computerViews,
    type CliInventory,
    type Installation,
    type WslDiscovery,
  } from '$lib/fleet';
  import type { Presence } from '$lib/sync';
  import { fallbackModels, modelChoices, reasoningName, type ModelCatalog } from '$lib/models';
  import ChoicePicker from '$lib/components/ChoicePicker.svelte';
  import MessageView from '$lib/components/MessageView.svelte';
  import ImageAttachments from '$lib/components/ImageAttachments.svelte';
  import {
    readImage,
    imageTypes,
    supportsImages,
    maxImagesPerMessage,
    checkImageBudget,
    type ChatImage,
  } from '$lib/images';
  import {
    replySettingsChanged,
    replySwitches,
    selectedModelName,
    replyTimeTotals,
  } from '$lib/replies';
  import UsagePanel from '$lib/components/UsagePanel.svelte';
  import { estimatePromptTokens, usageKey, snapshotFor, type UsageSnapshot } from '$lib/usage';
  import '$lib/styles.css';

  type View = 'chat' | 'connections';
  let installation = $state<Installation>();
  let wslDiscovery = $state<WslDiscovery>();
  let wslError = $state('');
  let wslRefreshing = false;
  let connectionStatuses = $state<Record<string, ProviderStatus>>({});
  let cliInventories = $state<Record<string, CliInventory>>({});
  const connectionChecks = new Map<string, Promise<void>>();
  let presence = $state<Presence[]>([]);
  let paired = $state(false);
  let syncStatus = $state(
    'Saved on this environment. Pair a relay to bring your workspace together.',
  );
  let syncError = $state('');
  let view = $state<View>('chat');
  let sidebarWidth = $state<number>();
  let viewportWidth = $state(1024);
  let sidebarOpen = $state(false);
  let online = $state(true);
  const mobile = $derived(viewportWidth <= 650);
  let sidebarElement: HTMLElement;
  async function toggleSidebar(open: boolean) {
    sidebarOpen = open;
    await tick();
    if (open) sidebarElement?.querySelector<HTMLButtonElement>('.mobile-close')?.focus();
    else document.querySelector<HTMLButtonElement>('.mobile-menu')?.focus();
  }
  let workspace = $state<Workspace>(initialWorkspace());
  let loaded = $state(false);
  let storageError = $state('');
  let notice = $state('');
  let statuses = $state<ProviderStatus[]>([]);
  let refreshing = $state(false);
  let pendingSignIn = $state<{ provider: ProviderId; connectionId?: string } | null>(null);
  let signInDeadline = 0;
  let activeId = $state<string | null>(null);
  let draftSettings = $state<ChatSettings>(untrack(() => settingsFor(workspace.preferences)));
  let draftLocation = $state<ChatLocation>();
  let draftComputerId = $state('');
  let folderBrowserOpen = $state(false);
  let selectingLocation = $state(false);
  let locationPending = $state(false);
  let locationGeneration = 0;
  let settingsRevision = 0;
  let collapsedGroups = $state<Record<string, boolean>>({});
  let conversationScope = $state<'active' | 'history'>('active');
  let modelGeneration = 0;
  let models = $state<ModelCatalog>(structuredClone(fallbackModels));
  let modelsLoading = $state(false);
  const modelCache = new Map<string, { catalog: ModelCatalog; checkedAt: number }>();
  const modelRequests = new Map<string, Promise<ModelCatalog>>();
  let usageSnapshots = $state<Record<string, UsageSnapshot>>({});
  let usageLoading = $state<Record<string, boolean>>({});
  let usageErrors = $state<Record<string, string>>({});
  let prompt = $state('');
  let attachedImages = $state<ChatImage[]>([]);
  let attachmentError = $state('');
  let imagesLoading = $state(false);
  let imageDragDepth = $state(0);
  let attachmentGeneration = 0;
  let imageInput = $state<HTMLInputElement>();
  let query = $state('');
  let run = $state<{ id: string; conversationId: string } | null>(null);
  let stopping = $state(false);
  let editorOpen = $state(false);
  let contextOpen = $state(false);
  let deletion = $state<{ type: 'conversation'; id: string; name: string } | null>(null);
  let composerInput = $state<HTMLTextAreaElement>();
  let chatScroll = $state<HTMLDivElement>();
  let nearBottom = true;
  let saveQueue = Promise.resolve();
  const active = $derived(workspace.conversations.find((c) => c.id === activeId));
  const selectedSettings = $derived(active?.settings ?? draftSettings);
  const imagesSupported = $derived(supportsImages(selectedSettings.provider));
  const selectedLocation = $derived(
    locationPending ? undefined : active ? active.location : draftLocation,
  );
  const computers = $derived(computerViews(workspace.fleet));
  function locationComputerId(location: ChatLocation) {
    const environment = locationExecutionEnvironment(workspace.fleet, location);
    return environment ? computerViewId(environment) : location.computerId;
  }
  const selectedComputerId = $derived(
    selectedLocation ? locationComputerId(selectedLocation) : draftComputerId,
  );
  const selectedComputer = $derived(computers.find((c) => c.id === selectedComputerId));
  const selectedComputerOffline = $derived(
    !!selectedComputer && !computerOnline(selectedComputer.id),
  );
  const computerEnvironments = $derived(
    computerFolderEnvironments(workspace.fleet, selectedComputerId),
  );
  const selectedExecutionEnvironment = $derived(
    selectedComputer?.environments.find(
      (e) =>
        e.id ===
        (selectedLocation
          ? locationExecutionId(selectedLocation)
          : selectedConnection?.environmentId),
    ) ?? selectedComputer?.environments[0],
  );
  const savedLocations = $derived(knownLocations(workspace, selectedComputerId));
  const scopedConnections = $derived(locationConnections(workspace.fleet, selectedLocation));
  const availableProviders = $derived(
    providerIds.filter((provider) =>
      scopedConnections.some(
        (c) =>
          workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider === provider &&
          canChooseConnection(c.id),
      ),
    ),
  );
  const providerOptions = $derived([
    ...new Set([...availableProviders, selectedSettings.provider]),
  ]);
  const agentOptions = $derived.by(() => {
    const ids = selectedLocation ? providerOptions : providerIds;
    return ids.flatMap((provider) => {
      const candidates = scopedConnections.filter(
        (c) =>
          workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider === provider &&
          (canChooseConnection(c.id) || c.id === selectedSettings.connectionId),
      );
      const base = { mark: providers[provider].mark, color: providers[provider].color };
      if (candidates.length > 1)
        return candidates.map((c) => ({
          ...base,
          id: `connection:${c.id}`,
          provider,
          connectionId: c.id,
          name: `${providers[provider].name} · ${workspace.fleet.accounts.find((a) => a.id === c.accountId)?.name ?? 'Account'}`,
          detail: connectionStatus(c.id)?.installed
            ? providers[provider].company
            : canChooseConnection(c.id)
              ? 'Checking availability…'
              : 'Unavailable connection',
        }));
      return [
        {
          ...base,
          id: provider,
          provider,
          connectionId: candidates[0]?.id,
          name: providers[provider].name,
          detail:
            selectedLocation && !availableProviders.includes(provider)
              ? 'Unavailable on this computer'
              : candidates.some((c) => !connectionStatus(c.id))
                ? 'Checking availability…'
                : providers[provider].company,
        },
      ];
    });
  });
  const selectedAgentOption = $derived(
    agentOptions.find(
      (option) =>
        option.provider === selectedSettings.provider &&
        option.connectionId === selectedSettings.connectionId,
    )?.id ?? selectedSettings.provider,
  );
  const selectedConnection = $derived(
    workspace.fleet.connections.find((c) => c.id === selectedSettings.connectionId),
  );
  const selectedRemote = $derived(
    !!selectedConnection &&
      executionHost(workspace.fleet, selectedConnection.environmentId) !== installation?.id,
  );
  const selectedStatus = $derived(
    selectedSettings.connectionId
      ? selectedRemote
        ? presence
            .find(
              (p) =>
                p.environmentId ===
                  executionHost(workspace.fleet, selectedConnection?.environmentId ?? '') &&
                p.online,
            )
            ?.connections.find((c) => c.connectionId === selectedSettings.connectionId)
        : connectionStatuses[selectedSettings.connectionId]
      : statusFor(selectedSettings.provider),
  );

  const selectedUsageKey = $derived(usageKey(selectedSettings));
  const selectedUsage = $derived(snapshotFor(usageSnapshots, selectedSettings));
  const accountUsageTargets = $derived.by(() =>
    workspace.fleet.connections.flatMap((connection) => {
      const account = workspace.fleet.accounts.find((a) => a.id === connection.accountId);
      const host = executionHost(workspace.fleet, connection.environmentId);
      const status =
        host === installation?.id
          ? connectionStatuses[connection.id]
          : paired
            ? presence
                .find((p) => p.environmentId === host && p.online)
                ?.connections.find((c) => c.connectionId === connection.id)
            : undefined;
      return account && status?.installed && status.auth === 'ready'
        ? [{ provider: account.provider, model: '', connectionId: connection.id }]
        : [];
    }),
  );
  const accountUsageTargetKey = $derived(accountUsageTargets.map(usageKey).sort().join('|'));
  $effect(() => {
    const key = accountUsageTargetKey;
    if (loaded && view === 'connections' && key) untrack(() => void refreshAccountUsage());
  });
  $effect(() => {
    const provider = selectedSettings.provider;
    const model = selectedSettings.model;
    const connectionId = selectedSettings.connectionId;
    if (loaded && view === 'chat')
      untrack(() => void refreshUsage({ provider, model, connectionId }));
  });
  const selectedModelScope = $derived(modelScopeKey(selectedSettings));
  const selectedModelReady = $derived(!!active || !!selectedLocation);
  const selectedConnectionAvailable = $derived(canQueryConnection(selectedSettings.connectionId));
  $effect(() => {
    const key = selectedModelScope;
    const ready = selectedModelReady;
    const available = selectedConnectionAvailable;
    if (loaded)
      untrack(() => {
        models = modelCache.get(key)?.catalog ?? structuredClone(fallbackModels);
        if (ready && available) void refreshModels(false);
        else {
          ++modelGeneration;
          modelsLoading = false;
          if (notice === modelRefreshWarning) notice = '';
        }
      });
  });
  const selectedAgent = $derived({
    ...selectedSettings,
    name: providers[selectedSettings.provider].name,
  });
  const availableModels = $derived(
    modelChoices(models, selectedSettings.provider, selectedSettings.model),
  );
  const currentModel = $derived(
    availableModels.find((model) => model.id === selectedSettings.model)!,
  );
  const reasoningOptions = $derived(
    [
      ...new Set([
        '',
        ...currentModel.reasoningLevels,
        ...(selectedSettings.reasoning ? [selectedSettings.reasoning] : []),
      ]),
    ].map((id) => ({ id, name: reasoningName(id as Reasoning) })),
  );
  const recent = $derived(
    [...workspace.conversations]
      .filter((c) =>
        `${c.title} ${providers[c.settings.provider].name} ${c.location?.path ?? ''} ${computers.find((computer) => computer.id === (c.location ? locationComputerId(c.location) : ''))?.name ?? ''}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );
  const conversationGroups = $derived(groupConversations(recent, workspace.fleet, installation));
  const observedReply = $derived(
    active?.messages.find((m) => m.role === 'assistant' && m.status === 'running'),
  );
  const activeRunning = $derived(run?.conversationId === activeId || !!observedReply);
  const switchNotices = $derived(replySwitches(active?.messages ?? []));
  const timeTotals = $derived(replyTimeTotals(active?.messages ?? []));
  const nextReplyChanged = $derived(
    !!observedReply?.settings && replySettingsChanged(observedReply.settings, selectedSettings),
  );
  const hostBusy = $derived(
    workspace.conversations.some((c) =>
      c.messages.some(
        (m) =>
          m.status === 'running' &&
          m.settings?.connectionId &&
          executionHost(
            workspace.fleet,
            workspace.fleet.connections.find(
              (connection) => connection.id === m.settings?.connectionId,
            )?.environmentId ?? '',
          ) === installation?.id,
      ),
    ),
  );
  const canSend = $derived(
    loaded &&
      !imagesLoading &&
      (!attachedImages.length || imagesSupported) &&
      !selectingLocation &&
      !locationPending &&
      (!selectedLocation ||
        selectedSettings.connectionId ||
        executionHost(workspace.fleet, selectedLocation.environmentId) === installation?.id) &&
      (!!selectedLocation || !!active) &&
      (!selectedLocation ||
        (!!active && !selectedLocation.path) ||
        scopedConnections.some((c) => c.id === selectedSettings.connectionId)) &&
      !run &&
      !activeRunning &&
      (selectedRemote || !hostBusy) &&
      (desktop() || paired) &&
      (desktop() || online) &&
      (!selectedRemote || (paired && !syncError)) &&
      !!selectedStatus?.installed,
  );
  const viewTitle = $derived(
    {
      chat: active?.title ?? 'New conversation',
      connections: 'Connections',
    }[view],
  );

  let browserRestorePending = true;
  let browserRestoreBusy = false;
  let relaySelectionVersion = 0;
  async function restoreBrowserConnection() {
    if (desktop() || !loaded || browserRestoreBusy) return;
    browserRestoreBusy = true;
    const version = relaySelectionVersion;
    try {
      const connected = await resumeBrowserRelay();
      if (version !== relaySelectionVersion) return;
      browserRestorePending = false;
      paired = connected;
      syncError = '';
      if (connected) await syncNow();
    } catch (error) {
      if (version !== relaySelectionVersion) return;
      browserRestorePending = true;
      syncError =
        error instanceof Error && error.message.includes('Pair this device')
          ? error.message
          : 'Server unavailable. Reconnecting automatically…';
    } finally {
      browserRestoreBusy = false;
    }
  }

  onMount(() => {
    const network = () => {
      online = navigator.onLine;
    };
    network();
    window.addEventListener('online', network);
    window.addEventListener('offline', network);
    const stopViewport = trackMobileViewport();
    let focusTimer: ReturnType<typeof setTimeout>;
    const onReturn = () => {
      if (!loaded || document.visibilityState === 'hidden') return;
      if (paired) void syncNow();
      else if (!desktop()) void restoreBrowserConnection();
      if (run) return;
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        void refresh();
        if (view === 'chat') void refreshUsage();
      }, 250);
    };
    window.addEventListener('focus', onReturn);
    window.addEventListener('online', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    const loginPoll = setInterval(() => {
      if (pendingSignIn && Date.now() < signInDeadline && !run) void refresh();
    }, 5000);
    const usagePoll = setInterval(() => {
      if (loaded && document.visibilityState !== 'hidden') {
        if (view === 'chat') void refreshUsage();
        if (view === 'connections') void refreshAccountUsage();
      }
    }, 60_000);
    const relayPoll = setInterval(() => {
      if (paired) void syncNow();
      else if (browserRestorePending && online && document.visibilityState !== 'hidden')
        void restoreBrowserConnection();
    }, 2500);
    const wslPoll = setInterval(() => {
      if (loaded && view === 'connections' && document.visibilityState !== 'hidden')
        void refreshWsl();
    }, 15_000);
    void (async () => {
      try {
        workspace = await loadWorkspace();
        installation = await getInstallation();
        if (installation && desktop()) registerInstallation(workspace.fleet, installation);
        // Legacy chats retain a stable owning computer when the workspace is synchronized.
        for (const conversation of workspace.conversations) {
          // Start each app session with a clean Active list without changing chat recency.
          if (desktop()) conversation.archived = true;
          if (!conversation.location)
            conversation.location = conversationLocation(
              conversation,
              workspace.fleet,
              installation,
            );
        }
        draftComputerId =
          workspace.fleet.environments.find((e) => e.id === installation?.id)?.computerId ??
          installation?.computerId ??
          '';
        draftLocation = workspace.preferences.recentLocations?.find(
          (l) => locationConnections(workspace.fleet, l).length,
        );
        draftSettings = settingsFor(workspace.preferences);
        loaded = true;
        newChat();
        if (installation)
          configureRuntime({
            installation,
            workspace: () => $state.snapshot(workspace),
            statuses: () => $state.snapshot(connectionStatuses),
            localRuns: () => (run ? [run.id] : []),
            checkpointRun: async (request, event, status, error) => {
              const conversation = workspace.conversations.find(
                (c) => c.id === request.conversationId,
              );
              const message = conversation?.messages.find((m) => m.id === request.assistantId);
              if (!conversation || !message) return;
              if (event) applyRunEvent(message, event);
              if (status) {
                message.status = status;
                message.error = error;
                conversation.updatedAt = new Date().toISOString();
              }
              await persist();
            },
            apply: async (value) => {
              workspace.fleet = value.fleet;
              // Preserve active object identities while network responses arrive.
              workspace.conversations = value.conversations.map((incoming) => {
                const existing = workspace.conversations.find((c) => c.id === incoming.id);
                if (existing) {
                  Object.assign(existing, incoming);
                  return existing;
                }
                return incoming;
              });
              await persist();
              if (
                workspace.fleet.connections.some(
                  (c) =>
                    executionHost(workspace.fleet, c.environmentId) === installation?.id &&
                    !connectionStatuses[c.id],
                )
              )
                void refreshConnections();
            },
          });
        await persist();
        if (!desktop()) await restoreBrowserConnection();
      } catch (e) {
        storageError = `Could not load your workspace. ${String(e)} No saved data has been overwritten.`;
      }
      void refreshModels();
      await refresh();
    })();
    return () => {
      window.removeEventListener('online', network);
      window.removeEventListener('offline', network);
      stopViewport();
      clearTimeout(focusTimer);
      clearInterval(loginPoll);
      clearInterval(usagePoll);
      clearInterval(relayPoll);
      clearInterval(wslPoll);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('online', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  });
  async function syncNow() {
    try {
      const peers = await pollRelay();
      if (peers) {
        presence = peers;
        syncError = '';
        syncStatus = `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · Environments report every few seconds`;
      }
    } catch (e) {
      syncError = String(e);
      presence = presence.map((p) => ({ ...p, online: false }));
    }
  }
  async function pair(url: string, key: string) {
    ++relaySelectionVersion;
    await persist();
    await connectRelay(url, key);
    paired = true;
    browserRestorePending = false;
    await syncNow();
    if (!active && !draftComputerId) draftComputerId = computers[0]?.id ?? '';
  }
  async function unpair() {
    ++relaySelectionVersion;
    await disconnectRelay();
    paired = false;
    browserRestorePending = false;
    presence = [];
    syncError = '';
    syncStatus = 'Disconnected. Changes continue to save on this environment.';
  }
  async function persist() {
    if (!loaded) return;
    const snapshot = $state.snapshot(workspace);
    const next = saveQueue.catch(() => {}).then(() => saveWorkspace(snapshot));
    saveQueue = next;
    try {
      await next;
      storageError = '';
    } catch (e) {
      storageError = `Changes could not be saved: ${String(e)}`;
      throw e;
    }
  }
  function saveSoon() {
    void persist().catch(() => {});
  }
  async function refresh(forceUsage = false) {
    if (refreshing) return;
    refreshing = true;
    try {
      await refreshWsl();
      await refreshCliInventories();
      statuses = await detectProviders();
      const before = workspace.fleet.connections.length;
      for (const environment of workspace.fleet.environments) {
        if (executionHost(workspace.fleet, environment.id) !== installation?.id) continue;
        const inventory = cliInventories[environment.id];
        if (inventory?.error || !inventory?.entries) continue;
        ensureEnvironmentConnections(
          workspace.fleet,
          environment.id,
          inventory.entries.filter((entry) => entry.path).map((entry) => entry.id),
        );
      }
      if (workspace.fleet.connections.length !== before) await persist();
      await refreshConnections();
      if (view === 'connections') void refreshAccountUsage(forceUsage);
      const loginStatus = pendingSignIn?.connectionId
        ? connectionStatuses[pendingSignIn.connectionId]
        : statuses.find((s) => s.id === pendingSignIn?.provider);
      if (pendingSignIn && loginStatus?.auth === 'ready') {
        notice = `${providers[pendingSignIn.provider].name} is connected. You're ready to chat.`;
        pendingSignIn = null;
      }
    } catch (e) {
      notice = String(e);
    } finally {
      refreshing = false;
    }
  }
  async function refreshWsl() {
    if (installation?.platform !== 'windows' || wslRefreshing) return;
    wslRefreshing = true;
    try {
      const discovery = await discoverWsl();
      wslDiscovery = discovery;
      wslError = discovery.warning ?? '';
      const before = JSON.stringify(workspace.fleet);
      registerWslEnvironments(workspace.fleet, installation, discovery);
      if (JSON.stringify(workspace.fleet) !== before) await persist();
    } catch (e) {
      wslError = String(e);
    } finally {
      wslRefreshing = false;
    }
  }
  async function refreshConnections(location?: ChatLocation, missingOnly = false) {
    if (!desktop() || !installation) return;
    await Promise.all(
      workspace.fleet.connections
        .filter(
          (c) =>
            executionHost(workspace.fleet, c.environmentId) === installation?.id &&
            (!location || c.environmentId === locationExecutionId(location)) &&
            (!missingOnly || !connectionStatuses[c.id]),
        )
        .map((c) => {
          const pending = connectionChecks.get(c.id);
          if (pending) return pending;
          const account = workspace.fleet.accounts.find((a) => a.id === c.accountId);
          if (!account) return;
          const check = detectConnection(account.provider, c.id)
            .then((status) => {
              connectionStatuses[c.id] = status;
            })
            .catch((e) => {
              connectionStatuses[c.id] = {
                id: account.provider,
                installed: false,
                auth: 'unknown',
                version: null,
                detail: String(e),
              };
            })
            .finally(() => {
              connectionChecks.delete(c.id);
            });
          connectionChecks.set(c.id, check);
          return check;
        }),
    );
  }
  async function refreshCliInventories() {
    if (!desktop() || !installation) return;
    await Promise.all(
      workspace.fleet.environments
        .filter((e) => executionHost(workspace.fleet, e.id) === installation?.id)
        .map(async (environment) => {
          cliInventories[environment.id] = { ...cliInventories[environment.id], checking: true };
          try {
            const entries = await inspectEnvironmentClis(environment.id);
            cliInventories[environment.id] = { entries, checking: false };
          } catch (e) {
            cliInventories[environment.id] = {
              ...cliInventories[environment.id],
              checking: false,
              error: String(e),
            };
          }
        }),
    );
  }
  function statusFor(id: ProviderId) {
    return statuses.find((s) => s.id === id);
  }
  function environmentOnline(environmentId: string) {
    const host = executionHost(workspace.fleet, environmentId);
    if (desktop() && host === installation?.id) return true;
    return (
      paired && !syncError && online && presence.some((p) => p.environmentId === host && p.online)
    );
  }
  function computerOnline(computerId: string) {
    return (
      computers
        .find((c) => c.id === computerId)
        ?.environments.some((e) => environmentOnline(e.id)) ?? false
    );
  }
  function canQueryConnection(connectionId?: string) {
    if (!connectionId) return desktop();
    const connection = workspace.fleet.connections.find((c) => c.id === connectionId);
    if (!connection) return false;
    if (desktop() && executionHost(workspace.fleet, connection.environmentId) === installation?.id)
      return true;
    const status = connectionStatus(connectionId);
    return (
      environmentOnline(connection.environmentId) && !!status?.installed && status.auth === 'ready'
    );
  }
  function connectionStatus(id: string) {
    const connection = workspace.fleet.connections.find((c) => c.id === id);
    if (!connection) return undefined;
    const host = executionHost(workspace.fleet, connection.environmentId);
    return host === installation?.id
      ? connectionStatuses[id]
      : presence
          .find((p) => p.environmentId === host && p.online)
          ?.connections.find((c) => c.connectionId === id);
  }
  function canChooseConnection(id: string) {
    const status = connectionStatus(id);
    if (status) return status.installed;
    const connection = workspace.fleet.connections.find((c) => c.id === id);
    // Local choices can be prepared while detection runs; sending still requires a ready result.
    return (
      !!connection &&
      desktop() &&
      executionHost(workspace.fleet, connection.environmentId) === installation?.id
    );
  }
  function modelScopeKey(settings: Pick<ChatSettings, 'provider' | 'connectionId'>) {
    const connection = workspace.fleet.connections.find((c) => c.id === settings.connectionId);
    return JSON.stringify([settings.provider, connection ?? settings.connectionId ?? null]);
  }
  const modelRefreshWarning = 'Could not refresh models. Your saved choices are still available.';
  async function refreshModels(force = true) {
    const generation = ++modelGeneration;
    if ((!active && !selectedLocation) || !canQueryConnection(selectedSettings.connectionId)) {
      modelsLoading = false;
      return;
    }
    const selected = { ...selectedSettings };
    const key = modelScopeKey(selected);
    const cached = modelCache.get(key);
    if (!force && cached && Date.now() - cached.checkedAt < 300_000) {
      models = cached.catalog;
      modelsLoading = false;
      return;
    }
    modelsLoading = true;
    try {
      let request = modelRequests.get(key);
      if (!request) {
        // A newly created connection must reach native storage before its catalog is queried.
        request = saveQueue
          .then(() => {
            if (!canQueryConnection(selected.connectionId))
              throw new Error('The selected connection is unavailable.');
            return loadModels(selected);
          })
          .then((catalog) => {
            modelCache.set(key, { catalog, checkedAt: Date.now() });
            return catalog;
          })
          .finally(() => {
            modelRequests.delete(key);
          });
        modelRequests.set(key, request);
      }
      const catalog = await request;
      if (generation === modelGeneration && key === modelScopeKey(selectedSettings)) {
        models = catalog;
        if (notice === modelRefreshWarning) notice = '';
      }
    } catch (error) {
      if (error instanceof OfflineHostError) {
        const connection = workspace.fleet.connections.find((c) => c.id === selected.connectionId);
        const host = connection && executionHost(workspace.fleet, connection.environmentId);
        presence = presence.map((p) => (p.environmentId === host ? { ...p, online: false } : p));
      } else if (generation === modelGeneration && canQueryConnection(selected.connectionId))
        notice = modelRefreshWarning;
    } finally {
      if (generation === modelGeneration) modelsLoading = false;
    }
  }
  async function refreshUsage(
    settings: Pick<ChatSettings, 'provider' | 'model' | 'connectionId'> = selectedSettings,
    force = false,
  ) {
    if (
      !canQueryConnection(settings.connectionId) ||
      (!settings.connectionId && !active && !selectedLocation)
    )
      return;
    const key = usageKey(settings);
    if (usageLoading[key]) return;
    usageLoading[key] = true;
    try {
      await saveQueue;
      const snapshot = await readUsage(
        settings.provider,
        settings.model,
        force,
        settings.connectionId,
      );
      if (!snapshot || !Array.isArray(snapshot.windows))
        throw new Error('Usage was not reported by this CLI.');
      usageSnapshots[key] = { ...snapshot, connectionId: settings.connectionId };
      usageErrors[key] = '';
    } catch (e) {
      usageErrors[key] = String(e);
    } finally {
      usageLoading[key] = false;
    }
  }
  async function refreshAccountUsage(force = false) {
    await Promise.all(accountUsageTargets.map((settings) => refreshUsage(settings, force)));
  }
  function changeSettings(settings: ChatSettings) {
    if (!loaded) return;
    // Only the next request's model/reasoning may change while a reply is running.
    if (
      (run || activeRunning) &&
      (settings.provider !== selectedSettings.provider ||
        settings.connectionId !== selectedSettings.connectionId ||
        settings.instructions !== selectedSettings.instructions)
    )
      return;
    if (
      active &&
      (settings.provider !== active.settings.provider ||
        settings.connectionId !== active.settings.connectionId)
    )
      return;
    settingsRevision++;
    if (active) {
      active.settings = settings;
      active.updatedAt = new Date().toISOString();
    } else draftSettings = settings;
    rememberSettings(workspace.preferences, settings);
    saveSoon();
  }
  function chooseProvider(value: string) {
    if (active) return;
    if (selectedLocation && !availableProviders.includes(value as ProviderId)) return;
    const settings = settingsFor(workspace.preferences, value as ProviderId);
    if (selectedLocation)
      settings.connectionId = preferredConnection(settings.provider, selectedLocation);
    const model = models[settings.provider].find((m) => m.id === settings.model);
    if (
      workspace.preferences.reasoningByProvider[settings.provider]?.[settings.model] ===
        undefined &&
      model
    )
      settings.reasoning = model.defaultReasoning;
    changeSettings({ ...settings, instructions: selectedSettings.instructions });
  }
  function chooseAgent(value: string) {
    if (active) return;
    const option = agentOptions.find((option) => option.id === value);
    if (!option) return;
    if (!value.startsWith('connection:')) {
      chooseProvider(option.provider);
      return;
    }
    if (!option.connectionId || !canChooseConnection(option.connectionId)) return;
    const settings =
      option.provider === selectedSettings.provider
        ? selectedSettings
        : settingsFor(workspace.preferences, option.provider);
    changeSettings({
      ...settings,
      connectionId: option.connectionId,
      instructions: selectedSettings.instructions,
    });
  }
  function chooseModel(model: string) {
    const reasoning =
      workspace.preferences.reasoningByProvider[selectedSettings.provider]?.[model] ??
      availableModels.find((m) => m.id === model)?.defaultReasoning ??
      '';
    changeSettings({ ...selectedSettings, model, reasoning });
  }
  function newChat(
    provider?: ProviderId,
    connectionId?: string,
    location?: ChatLocation,
    computerId?: string,
  ) {
    if (!loaded || selectingLocation) return;
    sidebarOpen = false;
    folderBrowserOpen = false;
    locationGeneration++;
    conversationScope = 'active';
    locationPending = false;
    draftSettings = settingsFor(workspace.preferences, provider);
    draftLocation = location
      ? { ...location }
      : computerId
        ? undefined
        : workspace.preferences.recentLocations?.find(
            (l) => locationConnections(workspace.fleet, l).length,
          );
    if (computerId) draftComputerId = computerId;
    if (
      location &&
      !location.path &&
      workspace.fleet.environments.some(
        (e) => e.id === location.environmentId && e.computerId === location.computerId,
      )
    ) {
      ensureLocationConnections(workspace.fleet, location);
      saveSoon();
      void saveQueue
        .then(() => refreshConnections(location, true))
        .catch((e) => {
          notice = String(e);
        });
    }
    const connection = workspace.fleet.connections.find((c) => c.id === connectionId);
    if (connection) {
      const environment = workspace.fleet.environments.find(
        (e) => e.id === connection.environmentId,
      );
      draftComputerId = environment ? computerViewId(environment) : '';
      draftLocation = workspace.preferences.recentLocations?.find(
        (l) => locationExecutionId(l) === connection.environmentId,
      );
      draftSettings.connectionId = connection.id;
    } else if (draftLocation) {
      draftComputerId = locationComputerId(draftLocation);
      if (location) draftSettings = settingsAtLocation(draftSettings, location);
      else draftSettings.connectionId = preferredConnection(draftSettings.provider, draftLocation);
    } else delete draftSettings.connectionId;
    activeId = null;
    prompt = '';
    clearImages();
    editorOpen = false;
    contextOpen = false;
    view = 'chat';
    if (location || computerId) {
      query = '';
      const computerKey = `active/${location ? locationComputerId(location) : computerId}`;
      collapsedGroups[computerKey] = false;
      if (location) collapsedGroups[`${computerKey}/${locationKey(location)}`] = false;
      void tick().then(() => composerInput?.focus());
    }
    if (provider) {
      rememberSettings(workspace.preferences, draftSettings);
      saveSoon();
    }
  }
  function preferredConnection(provider: ProviderId, location: ChatLocation) {
    const candidates = locationConnections(workspace.fleet, location, provider);
    const remembered = workspace.preferences.connectionByProvider?.[provider];
    return (
      candidates.find((c) => c.id === remembered)?.id ??
      candidates.find((c) => c.profile === 'existing' && connectionStatus(c.id)?.installed)?.id ??
      candidates[0]?.id
    );
  }
  function chooseComputer(id: string) {
    if (active || run || activeRunning || selectingLocation || id === selectedComputerId) return;
    locationGeneration++;
    draftComputerId = id;
    locationPending = true;
  }
  function settingsAtLocation(settings: ChatSettings, location: ChatLocation): ChatSettings {
    const installed = providerIds.filter((p) =>
      locationConnections(workspace.fleet, location, p).some(
        (c) => connectionStatus(c.id)?.installed,
      ),
    );
    const supported = providerIds.filter(
      (p) => locationConnections(workspace.fleet, location, p).length,
    );
    const provider = installed.includes(settings.provider)
      ? settings.provider
      : (installed[0] ??
        (supported.includes(settings.provider) ? settings.provider : supported[0]) ??
        settings.provider);
    return {
      ...(provider === settings.provider ? settings : settingsFor(workspace.preferences, provider)),
      instructions: settings.instructions,
      connectionId: preferredConnection(provider, location),
    };
  }
  async function chooseLocation(location: ChatLocation, verified = false) {
    if (active || run || activeRunning || selectingLocation) return;
    if (selectedLocation && locationKey(location) === locationKey(selectedLocation)) return;
    const generation = ++locationGeneration;
    const conversationId = activeId;
    selectingLocation = true;
    try {
      if (!verified) {
        const listing = await listFolders(location.environmentId, location.path);
        location = { ...location, path: listing.path };
      }
      if (generation !== locationGeneration || conversationId !== activeId) return;
      ensureLocationConnections(workspace.fleet, location);
      const settings = settingsAtLocation(selectedSettings, location);
      draftLocation = { ...location };
      locationPending = false;
      draftComputerId = locationComputerId(location);
      rememberLocation(workspace, location);
      changeSettings(settings);
      const revision = settingsRevision;
      await persist();
      // CLI availability belongs to the environment, not each folder. Reuse known results.
      void (async () => {
        await refreshConnections(location, true);
        if (paired) await syncNow();
        if (
          generation !== locationGeneration ||
          conversationId !== activeId ||
          revision !== settingsRevision ||
          !selectedLocation ||
          locationKey(selectedLocation) !== locationKey(location) ||
          JSON.stringify(selectedSettings) !== JSON.stringify(settings)
        )
          return;
        const resolved = settingsAtLocation(selectedSettings, location);
        if (JSON.stringify(resolved) !== JSON.stringify(selectedSettings)) changeSettings(resolved);
      })().catch((e) => {
        notice = String(e);
      });
    } finally {
      selectingLocation = false;
    }
  }
  function toggleArchive() {
    if (!active || activeRunning) return;
    active.archived = !active.archived;
    active.updatedAt = new Date().toISOString();
    revealConversation(active);
    saveSoon();
  }
  function openConversation(c: Conversation) {
    sidebarOpen = false;
    locationGeneration++;
    folderBrowserOpen = false;
    revealConversation(c);
    locationPending = false;
    activeId = c.id;
    prompt = '';
    clearImages();
    editorOpen = false;
    contextOpen = false;
    view = 'chat';
    void scrollToEnd();
  }
  function revealConversation(c: Conversation) {
    conversationScope = c.archived ? 'history' : 'active';
    const location = conversationLocation(c, workspace.fleet, installation);
    const computerKey = `${conversationScope}/${location ? locationComputerId(location) : 'unassigned'}`;
    collapsedGroups[computerKey] = false;
    collapsedGroups[`${computerKey}/${location ? locationKey(location) : 'unassigned'}`] = false;
  }
  async function conversationTabKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tablist = (event.currentTarget as HTMLElement).parentElement;
    conversationScope =
      event.key === 'Home'
        ? 'active'
        : event.key === 'End'
          ? 'history'
          : conversationScope === 'active'
            ? 'history'
            : 'active';
    await tick();
    tablist?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }
  async function scrollToEnd() {
    await tick();
    if (nearBottom && chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight;
  }
  function remove() {
    if (!deletion || run?.conversationId === deletion.id) return;
    void cancelTitle(deletion.id).catch(() => {});
    workspace.conversations = workspace.conversations.filter((c) => c.id !== deletion!.id);
    if (activeId === deletion.id) {
      newChat();
    }
    deletion = null;
    saveSoon();
  }
  function clearImages() {
    imageDragDepth = 0;
    attachmentGeneration++;
    attachedImages = [];
    attachmentError = '';
    imagesLoading = false;
  }
  async function attachImages(files: File[]) {
    if (!files.length || imagesLoading) return;
    attachmentError = '';
    if (!imagesSupported) {
      attachmentError =
        'Image attachments are available with Codex and Claude. Choose one in Agent to attach images.';
      return;
    }
    if (attachedImages.length + files.length > maxImagesPerMessage) {
      attachmentError = 'Attach up to 4 images per message. Remove an image before adding more.';
      return;
    }
    const generation = attachmentGeneration;
    imagesLoading = true;
    try {
      const images = await Promise.all(files.map(readImage));
      if (generation !== attachmentGeneration) return;
      checkImageBudget([
        ...(active ? historyFor(active) : []),
        { images: [...attachedImages, ...images] },
      ]);
      attachedImages = [...attachedImages, ...images];
    } catch (error) {
      if (generation === attachmentGeneration) attachmentError = (error as Error).message;
    } finally {
      if (generation === attachmentGeneration) imagesLoading = false;
    }
  }
  function hasDraggedFiles(event: DragEvent) {
    return event.dataTransfer?.types.includes('Files') || !!event.dataTransfer?.files.length;
  }
  function dragImagesOver(event: DragEvent) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    imageDragDepth = Math.max(1, imageDragDepth);
    if (event.dataTransfer)
      event.dataTransfer.dropEffect =
        imagesSupported && !imagesLoading && attachedImages.length < maxImagesPerMessage
          ? 'copy'
          : 'none';
  }
  function dropImages(event: DragEvent) {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    imageDragDepth = 0;
    composerInput?.focus();
    void attachImages(files);
  }
  async function send(retry = false) {
    if (!canSend || (!retry && !prompt.trim() && !attachedImages.length)) return;
    if (!retry && attachedImages.length) {
      // Keep the draft intact when the portable workspace cannot fit the images.
      const bytes = new TextEncoder().encode(JSON.stringify($state.snapshot(workspace))).length;
      const addition = new TextEncoder().encode(
        JSON.stringify($state.snapshot(attachedImages)),
      ).length;
      if (bytes + addition + prompt.length * 4 + 64000 > 20_000_000) {
        attachmentError =
          'The saved workspace is nearly full (20 MB). Export and delete older chats, or remove an attachment before sending.';
        return;
      }
    }
    nearBottom = true;
    const now = new Date().toISOString();
    const isNewConversation = !active;
    if (!active) {
      const c: Conversation = {
        id: crypto.randomUUID(),
        settings: structuredClone($state.snapshot(selectedSettings)),
        location: selectedLocation ? { ...selectedLocation } : undefined,
        title: prompt.trim().slice(0, 80) || 'Image conversation',
        titleStatus: 'pending',
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      workspace.conversations.unshift(c);
      activeId = c.id;
    }
    const conversation = workspace.conversations.find((c) => c.id === activeId)!;
    if (conversation.archived) {
      conversation.archived = false;
      revealConversation(conversation);
    }
    if (retry && conversation.messages.at(-1)?.role === 'assistant') conversation.messages.pop();
    if (!retry) {
      conversation.messages.push({
        id: crypto.randomUUID(),
        role: 'user',
        blocks: [{ type: 'markdown', text: prompt.trim() }],
        ...(attachedImages.length
          ? { images: structuredClone($state.snapshot(attachedImages)) }
          : {}),
        status: 'complete',
        createdAt: now,
      });
      prompt = '';
      clearImages();
    }
    const history = historyFor(conversation);
    const assistantId = crypto.randomUUID();
    const responseSettings = structuredClone($state.snapshot(conversation.settings));
    const runId = crypto.randomUUID();
    rememberSettings(workspace.preferences, responseSettings);
    conversation.messages.push({
      id: assistantId,
      role: 'assistant',
      settings: responseSettings,
      modelName: selectedModelName(responseSettings.model, availableModels),
      executionLabel: responseSettings.connectionId
        ? connectionLabel(workspace.fleet, responseSettings.connectionId)
        : `${statusFor(responseSettings.provider)?.location ?? 'This computer'} · CLI login`,
      runId,
      promptTokensEstimate: estimatePromptTokens(responseSettings, history),
      blocks: [],
      status: 'running',
      createdAt: now,
    });
    conversation.updatedAt = now;
    const message = () => conversation.messages.find((m) => m.id === assistantId)!;
    run = { id: runId, conversationId: conversation.id };
    const started = performance.now();
    try {
      await persist();
      if (isNewConversation)
        void nameConversation(
          conversation.id,
          responseSettings.provider,
          history[0].text || 'A conversation about attached images',
          conversation.title,
          responseSettings.connectionId,
        );
      const result = stopping
        ? 'cancelled'
        : await runAgent(
            {
              runId,
              agent: responseSettings,
              messages: history,
              conversationId: conversation.id,
              assistantId,
              location: conversation.location?.path ? { ...conversation.location } : undefined,
            },
            (event) => {
              if (stopping) void cancelRun(runId).catch(() => {});
              const m = message();
              applyRunEvent(m, event);
              if (activeId === conversation.id) void scrollToEnd();
            },
          );
      message().status = result;
      if (result === 'complete') {
        const s = responseSettings.connectionId
          ? connectionStatuses[responseSettings.connectionId]
          : statusFor(responseSettings.provider);
        if (s) {
          s.auth = 'ready';
          s.detail = 'Connection verified by a completed response.';
        }
      }
    } catch (e) {
      message().status = 'error';
      message().error = String(e);
      if (String(e).includes('login needs attention')) {
        const s = responseSettings.connectionId
          ? connectionStatuses[responseSettings.connectionId]
          : statusFor(responseSettings.provider);
        if (s) {
          s.auth = 'login';
          s.detail = 'Sign in through the CLI, then send another message.';
        }
      }
    } finally {
      message().durationMs = performance.now() - started;
      conversation.updatedAt = new Date().toISOString();
      run = null;
      stopping = false;
      saveSoon();
      void scrollToEnd();
      void refreshUsage(responseSettings, true);
    }
  }
  async function nameConversation(
    id: string,
    provider: ProviderId,
    firstMessage: string,
    fallback: string,
    connectionId?: string,
  ) {
    try {
      const result = await generateTitle(id, provider, firstMessage, connectionId);
      const conversation = workspace.conversations.find((c) => c.id === id);
      if (
        !conversation ||
        conversation.titleStatus !== 'pending' ||
        conversation.title !== fallback
      )
        return;
      if (!result?.title?.trim() || result.title.length > 100) throw new Error('No title returned');
      conversation.title = result.title;
      conversation.titleStatus = 'generated';
      conversation.titleSource = { provider: result.provider, model: result.model };
      saveSoon();
      void refreshUsage(conversation.settings, true);
    } catch {
      const conversation = workspace.conversations.find((c) => c.id === id);
      if (conversation?.titleStatus === 'pending') {
        conversation.titleStatus = 'fallback';
        saveSoon();
      }
    }
  }
  async function stop() {
    const ownedRun = run?.conversationId === activeId ? run : null;
    const id = ownedRun?.id ?? observedReply?.runId;
    if (!id || stopping) return;
    if (!ownedRun) {
      try {
        await cancelRun(id, observedReply?.settings?.connectionId);
      } catch (e) {
        notice = String(e);
      }
      return;
    }
    stopping = true;
    try {
      await cancelRun(id, observedReply?.settings?.connectionId);
    } catch (e) {
      notice = String(e);
      stopping = false;
    }
  }
  async function login(id: ProviderId, connectionId?: string) {
    try {
      await signIn(id, connectionId);
      pendingSignIn = { provider: id, connectionId };
      signInDeadline = Date.now() + 10 * 60_000;
      notice = `Finish signing in through ${providers[id].name}. We'll update the connection automatically; you can leave the sign-in window open.`;
      void refresh();
    } catch (e) {
      notice = String(e);
      throw e;
    }
  }
  async function copyConversation() {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(
        active.messages
          .map(
            (m) =>
              `## ${m.role === 'user' ? 'You' : providers[(m.settings ?? active.settings).provider].name}\n\n${messageText(m)}`,
          )
          .join('\n\n'),
      );
      notice = 'Conversation copied as Markdown.';
    } catch {
      notice = 'Clipboard unavailable. Select the conversation text to copy it.';
    }
  }
  async function exportWorkspace() {
    try {
      if (desktop()) {
        const { invoke } = await import('@tauri-apps/api/core');
        const path = await invoke<string>('export_workspace', {
          workspace: $state.snapshot(workspace),
        });
        notice = `Workspace exported to ${path}`;
      } else {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify($state.snapshot(workspace), null, 2)], {
            type: 'application/json',
          }),
        );
        const a = document.createElement('a');
        a.href = url;
        a.download = 'agent-studio-workspace.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) {
      notice = String(e);
    }
  }
  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Tab' && (editorOpen || contextOpen || deletion)) {
      const modal = document.querySelector('[aria-modal="true"]');
      const elements = modal?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, textarea, select, summary, [tabindex="0"]',
      );
      if (elements?.length) {
        const first = elements[0],
          last = elements[elements.length - 1];
        if (
          !modal?.contains(document.activeElement) ||
          (event.shiftKey && document.activeElement === first)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    if (event.key === 'Escape') {
      editorOpen = false;
      contextOpen = false;
      deletion = null;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      newChat();
    }
  }
</script>

<svelte:head
  ><title>Agent Studio</title><meta
    name="description"
    content="Your AI agents, together in one local workspace."
  /></svelte:head
>
<svelte:window
  bind:innerWidth={viewportWidth}
  onkeydown={(event) => {
    if (mobile && sidebarOpen) {
      if (event.key === 'Escape') {
        event.preventDefault();
        void toggleSidebar(false);
        return;
      }
      if (event.key === 'Tab') {
        const elements = [
          ...sidebarElement.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input, [tabindex="0"]',
          ),
        ].filter((element) => element.getClientRects().length);
        const first = elements[0],
          last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    if (event.key === 'Escape') imageDragDepth = 0;
    keyboard(event);
  }}
  ondragover={(event) => {
    if (hasDraggedFiles(event)) event.preventDefault();
  }}
  ondrop={(event) => {
    if (hasDraggedFiles(event)) event.preventDefault();
    imageDragDepth = 0;
  }}
  ondragend={() => (imageDragDepth = 0)}
  onblur={() => (imageDragDepth = 0)}
/>

<div class="app-shell" style:--sidebar-width={sidebarWidth ? `${sidebarWidth}px` : undefined}>
  {#if mobile && sidebarOpen}<button
      class="sidebar-backdrop"
      aria-label="Close conversation menu"
      onclick={() => toggleSidebar(false)}
    ></button>{/if}
  <aside
    class="sidebar"
    class:mobile-open={mobile && sidebarOpen}
    id="conversation-sidebar"
    bind:this={sidebarElement}
    inert={mobile && !sidebarOpen}
    role={mobile ? 'dialog' : undefined}
    aria-modal={mobile && sidebarOpen ? true : undefined}
    aria-label="Conversations"
  >
    <button
      class="icon-button mobile-close"
      aria-label="Close conversations"
      onclick={() => toggleSidebar(false)}><X size={20} /></button
    >
    <button
      class="brand"
      class:draggable-brand={desktop()}
      data-tauri-drag-region={desktop() ? 'deep' : undefined}
      onclick={() => {
        view = 'chat';
        sidebarOpen = false;
      }}
      aria-label="Back to conversation"
      title="Back to conversation"
    >
      <span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <span>agent<span class="brand-light">studio</span></span>
    </button>
    <div class="sidebar-section">
      <span>CONVERSATIONS</span><button
        class="icon-button"
        onclick={() => newChat()}
        aria-label="New conversation"
        title="New conversation (Ctrl+N)"
        aria-keyshortcuts="Control+N Meta+N"
        disabled={!loaded}><Plus size={15} /></button
      >
    </div>
    <label class="search"
      ><Search size={14} /><input
        aria-label="Search conversations"
        placeholder="Search conversations"
        bind:value={query}
      />{#if query}<button
          class="icon-button"
          onclick={() => (query = '')}
          aria-label="Clear search"><X size={12} /></button
        >{/if}</label
    >
    <div class="conversation-tabs" role="tablist" aria-label="Conversation status">
      {#each conversationGroups as group}
        <button
          id={`conversation-tab-${group.id}`}
          role="tab"
          aria-selected={conversationScope === group.id}
          aria-controls={`conversation-panel-${group.id}`}
          tabindex={conversationScope === group.id ? 0 : -1}
          onclick={() => (conversationScope = group.id as 'active' | 'history')}
          onkeydown={conversationTabKey}
          ><span>{group.name}</span><span class="conversation-tab-count">{group.count}</span
          ></button
        >
      {/each}
    </div>
    <div class="conversation-list">
      {#each conversationGroups as group}
        <div
          id={`conversation-panel-${group.id}`}
          class="conversation-section"
          role="tabpanel"
          tabindex="0"
          aria-labelledby={`conversation-tab-${group.id}`}
          hidden={conversationScope !== group.id}
        >
          {#each group.computers as computer}
            {@const computerKey = `${group.id}/${computer.id}`}
            <div
              class="conversation-computer"
              aria-label={`${computer.name} ${group.name.toLowerCase()} chats`}
            >
              <div class="computer-group-row">
                <button
                  class="computer-group-toggle"
                  title={computer.name}
                  aria-expanded={!collapsedGroups[computerKey]}
                  onclick={() => (collapsedGroups[computerKey] = !collapsedGroups[computerKey])}
                  ><Laptop size={13} /><span>{computer.name}</span
                  >{#if !computerOnline(computer.id)}<small class="computer-offline">Offline</small
                    >{/if}<ChevronRight
                    size={12}
                    class={!collapsedGroups[computerKey] ? 'expanded-chevron' : ''}
                  /></button
                >
                <button
                  class="computer-new-chat"
                  title={`New conversation on ${computer.name}`}
                  aria-label={`New conversation on ${computer.name}`}
                  disabled={!loaded ||
                    selectingLocation ||
                    !computers.some((c) => c.id === computer.id)}
                  onclick={() => newChat(undefined, undefined, undefined, computer.id)}
                  ><Plus size={14} /></button
                >
              </div>
              {#if !collapsedGroups[computerKey]}{#each computer.folders as folder}
                  {@const folderKey = `${computerKey}/${folder.id}`}
                  <div class="conversation-folder" aria-label={folder.detail}>
                    <div class="folder-group-row">
                      <button
                        class="folder-group-toggle"
                        title={folder.detail}
                        aria-expanded={!collapsedGroups[folderKey]}
                        onclick={() => (collapsedGroups[folderKey] = !collapsedGroups[folderKey])}
                        ><Folder size={14} /><span>{folder.name}</span><ChevronRight
                          size={12}
                          class={!collapsedGroups[folderKey] ? 'expanded-chevron' : ''}
                        /></button
                      >
                      <button
                        class="folder-new-chat"
                        title={`New conversation in ${folder.name}`}
                        aria-label={`New conversation in ${folder.name} on ${computer.name}`}
                        disabled={!loaded || selectingLocation || !folder.location}
                        onclick={() => newChat(undefined, undefined, folder.location)}
                        ><Plus size={14} /></button
                      >
                    </div>
                    {#if !collapsedGroups[folderKey]}<div class="folder-conversations">
                        {#each folder.conversations as c}<button
                            class="conversation-item"
                            class:current={activeId === c.id && view === 'chat'}
                            aria-current={activeId === c.id && view === 'chat' ? 'page' : undefined}
                            onclick={() => openConversation(c)}
                            title={c.title}
                            ><span>{c.title}</span
                            >{#if c.messages.some((m) => m.status === 'running')}<i
                                class="pulse-dot"
                              ></i>{/if}</button
                          >{/each}
                      </div>{/if}
                  </div>
                {/each}{/if}
            </div>
          {:else}<p class="sidebar-empty">
              {query
                ? `No matches in ${group.name.toLowerCase()}.`
                : group.id === 'active'
                  ? 'No active conversations yet.'
                  : 'No conversations in history.'}
            </p>{/each}
        </div>
      {/each}
    </div>
    <div class="sidebar-tools">
      <button
        class="icon-button connections-button"
        class:active={view === 'connections'}
        aria-label="Connections"
        aria-pressed={view === 'connections'}
        title={view === 'connections' ? 'Back to conversation' : 'Connections'}
        onclick={() => {
          view = view === 'connections' ? 'chat' : 'connections';
          sidebarOpen = false;
        }}><Plug size={17} aria-hidden="true" /></button
      >
    </div>
    <SidebarResize onresize={(width) => (sidebarWidth = width)} />
  </aside>

  <main class="main-area" inert={mobile && sidebarOpen}>
    <WindowTitlebar
      title={viewTitle}
      onerror={(message) => (notice = message)}
      onmenu={() => toggleSidebar(true)}
    />
    {#if storageError}<div class="error-banner" role="alert">
        <CircleAlert size={17} />{storageError}
      </div>{/if}
    {#if notice}<div class="notice" role="status">
        <span>{notice}</span><button
          class="icon-button"
          aria-label="Dismiss notification"
          onclick={() => (notice = '')}><X size={16} /></button
        >
      </div>{/if}
    {#if !desktop()}<BrowserStatus
        {paired}
        error={syncError}
        connect={() => (view = 'connections')}
      />{/if}

    {#if view === 'chat'}
      <section
        class="chat-layout"
        aria-label="Chat"
        ondragenter={(event) => {
          if (hasDraggedFiles(event)) {
            event.preventDefault();
            imageDragDepth++;
          }
        }}
        ondragover={dragImagesOver}
        ondragleave={() => (imageDragDepth = Math.max(0, imageDragDepth - 1))}
        ondrop={dropImages}
      >
        {#if imageDragDepth > 0}
          <div class="image-drop-overlay" role="status">
            <div>
              <Paperclip size={28} aria-hidden="true" />
              <strong
                >{!imagesSupported
                  ? 'Images are available in Codex and Claude chats'
                  : imagesLoading
                    ? 'Reading images…'
                    : attachedImages.length >= maxImagesPerMessage
                      ? 'Remove an attachment to add more images'
                      : 'Drop images to attach'}</strong
              >
              {#if imagesSupported && !imagesLoading && attachedImages.length < maxImagesPerMessage}<span
                  >PNG, JPEG or WebP · Up to 4 images · 2 MB each</span
                >{/if}
            </div>
          </div>
        {/if}
        <div class="chat-toolbar" aria-label="Conversation settings">
          <div class="chat-configuration">
            <div class="chat-setting computer-setting">
              <span>Computer{selectedComputerOffline ? ' · Offline' : ''}</span><ChoicePicker
                label="Computer"
                title={active
                  ? 'Fixed for this conversation. Start a new conversation to change it.'
                  : undefined}
                value={selectedComputerId}
                options={[
                  ...computers.map((c) => ({
                    id: c.id,
                    name: c.name,
                    detail: !computerOnline(c.id)
                      ? c.wsl
                        ? `Offline · On ${c.hostName}`
                        : 'Offline'
                      : c.wsl
                        ? `On ${c.hostName}`
                        : undefined,
                  })),
                  ...(selectedComputerId && !selectedComputer
                    ? [{ id: selectedComputerId, name: 'Unavailable computer' }]
                    : []),
                ]}
                disabled={!loaded || !!run || activeRunning || selectingLocation || !!active}
                onchange={chooseComputer}
              >
                {#snippet icon()}<Laptop size={16} />{/snippet}
              </ChoicePicker>
            </div>
            <div class="chat-setting folder-setting">
              <span>Folder</span><ChoicePicker
                label="Folder"
                title={selectedLocation?.path}
                value={selectedLocation ? locationKey(selectedLocation) : 'browse'}
                options={[
                  ...savedLocations.map((l) => ({
                    id: locationKey(l),
                    name: folderName(l.path),
                    detail:
                      workspace.fleet.environments.find((e) => e.id === l.environmentId)?.name ??
                      'Environment',
                    title: l.path,
                  })),
                  ...(selectedLocation &&
                  !savedLocations.some((l) => locationKey(l) === locationKey(selectedLocation))
                    ? [
                        {
                          id: locationKey(selectedLocation),
                          name: selectedLocation.path
                            ? folderName(selectedLocation.path)
                            : 'No folder',
                          title: selectedLocation.path,
                        },
                      ]
                    : []),
                  { id: 'browse', name: 'Browse folders…' },
                ]}
                disabled={!loaded ||
                  !selectedComputer ||
                  !!run ||
                  activeRunning ||
                  selectingLocation ||
                  !!active}
                onchange={(id) => {
                  if (active) return;
                  const location = savedLocations.find((l) => locationKey(l) === id);
                  if (location) void chooseLocation(location).catch((e) => (notice = String(e)));
                  else folderBrowserOpen = true;
                }}
              >
                {#snippet icon()}<Folder size={16} />{/snippet}
              </ChoicePicker>
            </div>
            <div class="chat-setting agent-setting">
              <span>Agent</span><ChoicePicker
                label="Agent"
                title={`${active ? 'Fixed for this conversation. Start a new conversation to change it. ' : ''}${
                  selectedSettings.provider === 'gemini'
                    ? 'Gemini conversations cannot use tools.'
                    : 'Full access: file access, editing, commands, and configured CLI tools are enabled. Tool calls run without approval prompts.'
                }`}
                value={selectedAgentOption}
                options={agentOptions}
                disabled={!loaded ||
                  !!run ||
                  activeRunning ||
                  selectingLocation ||
                  (desktop() && !selectedLocation && !active) ||
                  !!active}
                onchange={chooseAgent}
              >
                {#snippet icon()}<Bot size={16} />{/snippet}
              </ChoicePicker>
            </div>
            <div class="chat-setting model-setting">
              <span>Model</span><ChoicePicker
                label="Model"
                value={selectedSettings.model}
                options={availableModels}
                disabled={!loaded ||
                  (desktop() && (locationPending || (!selectedLocation && !active)))}
                onchange={chooseModel}
              >
                {#snippet icon()}<Cpu size={16} />{/snippet}
              </ChoicePicker>
            </div>
            <div class="chat-setting">
              <span>Reasoning</span><ChoicePicker
                label="Reasoning"
                value={selectedSettings.reasoning}
                options={reasoningOptions}
                disabled={!loaded ||
                  reasoningOptions.length < 2 ||
                  (desktop() && (locationPending || (!selectedLocation && !active)))}
                onchange={(value) =>
                  changeSettings({ ...selectedSettings, reasoning: value as Reasoning })}
              >
                {#snippet icon()}<Brain size={16} />{/snippet}
              </ChoicePicker>
            </div>
          </div>
          <ToolbarActions>
            <button
              class="icon-button"
              title="Model context"
              aria-label="Model context"
              disabled={!loaded || locationPending || (desktop() && !selectedLocation && !active)}
              onclick={async () => {
                await saveQueue;
                contextOpen = true;
              }}><BookOpen size={16} /></button
            >
            {#if active}<button
                class="icon-button"
                disabled={activeRunning}
                onclick={toggleArchive}
                title={active.archived ? 'Restore conversation' : 'Move to history'}
                aria-label={active.archived ? 'Restore conversation' : 'Move to history'}
                >{#if active.archived}<ArchiveRestore size={16} />{:else}<Archive
                    size={16}
                  />{/if}</button
              ><button
                class="icon-button"
                onclick={copyConversation}
                title="Copy conversation"
                aria-label="Copy conversation"><Copy size={16} /></button
              ><button
                class="icon-button"
                disabled={activeRunning}
                onclick={() =>
                  (deletion = { type: 'conversation', id: active.id, name: active.title })}
                aria-label="Delete conversation"><Trash2 size={16} /></button
              >{/if}<button
              class="icon-button"
              onclick={() => (editorOpen = true)}
              disabled={!loaded || !!run || activeRunning}
              title="Chat instructions"
              aria-label="Chat instructions"><SlidersHorizontal size={16} /></button
            >
            <button
              class="icon-button"
              title="Refresh model list"
              aria-label="Refresh model list"
              disabled={modelsLoading ||
                !selectedConnectionAvailable ||
                !!run ||
                activeRunning ||
                locationPending ||
                (!selectedLocation && !active)}
              onclick={() => void refreshModels()}
              ><RefreshCw size={15} class={modelsLoading ? 'spinning' : ''} /></button
            >
          </ToolbarActions>
        </div>
        {#if nextReplyChanged}
          <p class="next-reply-settings" role="status">
            Next message: {selectedModelName(selectedSettings.model, availableModels)} · {reasoningName(
              selectedSettings.reasoning,
            )} reasoning
          </p>
        {/if}
        <div
          class="chat-scroll"
          bind:this={chatScroll}
          onscroll={() => {
            if (chatScroll)
              nearBottom =
                chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 100;
          }}
        >
          <div class="message-column" class:empty={!active?.messages.length}>
            {#if active?.messages.length}
              {#each active.messages as m, i (m.id)}<MessageView
                  message={m}
                  timeTotal={timeTotals.get(m.id)}
                  switchNotice={switchNotices.get(m.id)}
                  agent={active.settings}
                  canRetry={i === active.messages.length - 1 &&
                    (m.status === 'error' || m.status === 'cancelled') &&
                    !run}
                  retry={() => void send(true)}
                />{/each}
            {:else}<div class="chat-empty">
                <span
                  class="large-provider"
                  style:--provider-color={providers[selectedAgent.provider].color}
                  >{providers[selectedAgent.provider].mark}</span
                ><span class="eyebrow">A CONVERSATION WITH {selectedAgent.name.toUpperCase()}</span>
                <h1>What’s on your mind?</h1>
                <p>Bring a question, an idea, or the thing you can’t quite untangle.</p>
              </div>{/if}
          </div>
        </div>
        <div class="composer-area">
          {#if selectedComputerOffline}<div class="setup-hint">
              <Laptop size={15} />{selectedComputer?.name} is offline. Open Agent Studio on {selectedComputer?.wsl
                ? selectedComputer.hostName
                : selectedComputer?.name} and connect it to sync.
            </div>
          {:else if locationPending || (!selectedLocation && !active)}<div class="setup-hint">
              <Folder size={15} />Choose a computer and folder to see its available CLIs.<button
                class="text-button"
                disabled={!selectedComputer}
                onclick={() => (folderBrowserOpen = true)}
                >Choose folder<ArrowRight size={13} /></button
              >
            </div>
          {:else if !selectedStatus && desktop()}<div class="setup-hint">
              {#if selectedRemote}<Laptop size={15} />Computer offline or relay disconnected.
              {:else if selectedSettings.connectionId && !selectedConnection}<Plug size={15} />This
                CLI connection is no longer available. Choose another connection.
              {:else}<RefreshCw size={15} class="spinning" />Checking this folder’s CLIs…{/if}
            </div>
          {:else if !selectedStatus?.installed && desktop()}<div class="setup-hint">
              <Plug size={15} />{providers[selectedAgent.provider].name} needs to be set up.<button
                class="text-button"
                onclick={() => (view = 'connections')}
                >Open Connections<ArrowRight size={13} /></button
              >
            </div>{/if}
          {#if run && !activeRunning}<button
              class="setup-hint"
              onclick={() => {
                const c = workspace.conversations.find((c) => c.id === run?.conversationId);
                if (c) openConversation(c);
              }}
              ><i class="pulse-dot"></i>An agent is responding in another conversation. View it<ArrowUpRight
                size={14}
              /></button
            >{/if}
          <form
            class="composer"
            aria-label="Message composer"
            onsubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            {#if attachedImages.length}<ImageAttachments
                images={attachedImages}
                remove={(id) => {
                  attachedImages = attachedImages.filter((image) => image.id !== id);
                  attachmentError = '';
                }}
              />{/if}
            <input
              bind:this={imageInput}
              type="file"
              accept={imageTypes.join(',')}
              multiple
              hidden
              aria-label="Image files"
              onchange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                void attachImages(files);
              }}
            />
            <textarea
              bind:this={composerInput}
              aria-label="Message"
              title="Enter to send · Shift + Enter for a new line"
              placeholder={`Message ${selectedAgent.name}…`}
              bind:value={prompt}
              rows="3"
              maxlength="30000"
              onpaste={(event) => {
                const files = Array.from(event.clipboardData?.files ?? []);
                if (files.length) {
                  event.preventDefault();
                  void attachImages(files);
                }
              }}
              onkeydown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !mobile) {
                  e.preventDefault();
                  void send();
                }
              }}></textarea>
            {#if imagesLoading}<p class="attachment-notice" role="status">Reading images…</p>{/if}
            {#if attachmentError}<p class="attachment-notice" role="alert">{attachmentError}</p>
            {:else if attachedImages.length && !imagesSupported}<p
                class="attachment-notice"
                role="alert"
              >
                Choose Codex or Claude to send these images, or remove them to use Gemini.
              </p>{/if}
            <div class="composer-bottom">
              <button
                type="button"
                class="attach-button"
                aria-label="Attach images"
                title={imagesSupported
                  ? 'Attach images · PNG, JPEG, WebP · 2 MB each · up to 4'
                  : 'Image attachments are available with Codex and Claude'}
                disabled={!imagesSupported ||
                  imagesLoading ||
                  attachedImages.length >= maxImagesPerMessage}
                onclick={() => imageInput?.click()}><Paperclip size={17} /></button
              >
              {#if activeRunning}<button
                  class="stop-button"
                  type="button"
                  onclick={stop}
                  disabled={stopping}
                  ><Square size={12} fill="currentColor" />{stopping
                    ? 'Stopping…'
                    : 'Stop response'}</button
                >{:else}<button
                  class="send-button"
                  type="submit"
                  disabled={!canSend || (!prompt.trim() && !attachedImages.length)}
                  aria-label="Send message"><ArrowUp size={19} /></button
                >{/if}
            </div>
          </form>
          <UsagePanel
            conversation={active}
            settings={selectedSettings}
            model={currentModel}
            snapshot={selectedUsage}
            loading={!!usageLoading[selectedUsageKey]}
            error={usageErrors[selectedUsageKey] ?? ''}
            preview={!desktop() && !paired}
          />
        </div>
      </section>
    {:else if view === 'connections'}
      <FleetManager
        bind:workspace
        {installation}
        {wslDiscovery}
        {wslError}
        {cliInventories}
        {usageSnapshots}
        {usageLoading}
        {usageErrors}
        bind:statuses={connectionStatuses}
        {presence}
        {syncStatus}
        {syncError}
        {paired}
        save={persist}
        refresh={() => refresh(true)}
        connect={pair}
        disconnect={unpair}
        resolveConflict={async () => {
          const backup = await resolveRelaySettings();
          notice = `Local workspace backed up to ${backup}. Using the relay’s computer and account settings.`;
          await syncNow();
        }}
        chat={(provider, connectionId, computerId) =>
          newChat(provider, connectionId, undefined, computerId)}
        providerStatuses={statuses}
        {login}
        {exportWorkspace}
        running={!!run}
      />
    {/if}
  </main>
</div>
{#if folderBrowserOpen && !active}
  <FolderBrowser
    computerId={selectedComputer?.computerId ?? selectedComputerId}
    computerName={selectedComputer?.name ?? 'Computer'}
    environments={computerEnvironments}
    executionEnvironmentId={selectedExecutionEnvironment?.id}
    initialEnvironment={selectedLocation?.environmentId ?? selectedConnection?.environmentId}
    browse={listFolders}
    choose={(location) => chooseLocation(location, true)}
    close={() => (folderBrowserOpen = false)}
  />
{/if}
{#if contextOpen}<ModelContext
    settings={selectedSettings}
    location={selectedLocation?.path ? selectedLocation : undefined}
    modelName={selectedModelName(selectedSettings.model, availableModels)}
    accountName={workspace.fleet.accounts.find((a) => a.id === selectedConnection?.accountId)
      ?.name ?? 'Existing CLI login'}
    computerName={selectedComputer?.name ?? 'This computer'}
    close={() => (contextOpen = false)}
    useSkill={(name, path) => {
      prompt = `Use the skill ${JSON.stringify(name)} at ${JSON.stringify(path)} for this request.\n\n${prompt}`;
      contextOpen = false;
      void tick().then(() =>
        document.querySelector<HTMLTextAreaElement>('[aria-label="Message"]')?.focus(),
      );
    }}
  />{/if}
{#if editorOpen}<ChatInstructions
    instructions={selectedSettings.instructions}
    close={() => (editorOpen = false)}
    save={(instructions) => {
      changeSettings({ ...selectedSettings, instructions });
      editorOpen = false;
    }}
  />{/if}
{#if deletion}<div class="modal-backdrop" role="presentation">
    <div
      class="modal small-modal"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-title"
      tabindex="-1"
    >
      <h2 id="delete-title">Delete {deletion.type}?</h2>
      <p>
        “{deletion.name}” will be removed from this workspace. This cannot be undone.
      </p>
      <footer>
        <button class="secondary" onclick={() => (deletion = null)}>Cancel</button><button
          class="danger"
          onclick={remove}>Delete {deletion.type}</button
        >
      </footer>
    </div>
  </div>{/if}
