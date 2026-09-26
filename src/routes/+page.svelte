<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import RewindDialog from '$lib/components/RewindDialog.svelte';
  import UndoFilesDialog from '$lib/components/UndoFilesDialog.svelte';
  import { rewindConversation, undoRewind } from '$lib/rewind';
  import { trackMobileViewport } from '$lib/mobileViewport';
  import { trackDrawerSwipe } from '$lib/drawerSwipe';
  import {
    notificationConversation,
    requestsAttention,
    pendingChatCount,
  } from '$lib/notifications';
  import {
    watchDesktopNotifications,
    watchNotificationView,
    publishNotificationView,
    watchAppUpdates,
    installAppUpdate,
    type AppUpdateStatus,
  } from '$lib/transport';
  import { restartBlocked } from '$lib/app-updates';
  import {
    ArrowUp,
    ArrowRight,
    Plus,
    Bot,
    Cpu,
    Brain,
    Plug,
    Settings,
    Search,
    ChevronRight,
    SlidersHorizontal,
    RefreshCw,
    LoaderCircle,
    MessageCircleQuestionMark,
    CircleStop,
    X,
    Pencil,
    Check,
    Laptop,
    CircleAlert,
    Folder,
    MessageCircle,
    Archive,
    BookOpen,
    Paperclip,
    FileText,
    GitFork,
    Rewind,
    PenLine,
    RotateCcwClock,
    CalendarDays,
  } from '@lucide/svelte';
  import {
    initialWorkspace,
    providerIds,
    providers,
    historyFor,
    settingsFor,
    rememberSettings,
    rememberAgent,
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
    loadDrafts,
    saveDrafts,
    loadModels,
    readUsage,
    watchAccountUpdates,
    watchBackgroundWork,
    watchUsageRefresh,
    accountUsageRevision,
    generateTitle,
    cancelTitle,
    steerRun,
    saveWorkspace,
    detectProviders,
    runAgent,
    cancelRun,
    releaseConversation,
    signIn,
    openLink,
    getInstallation,
    appSession,
    discoverWsl,
    inspectEnvironmentClis,
    configureRuntime,
    detectConnection,
    detectEnvironmentLogin,
    connectRelay,
    disconnectRelay,
    pollRelay,
    resolveRelaySettings,
    listFolders,
    resumeRelay,
    watchBrowserSession,
    workspaceStorageScope,
    BrowserWorkspaceStorageError,
    OfflineHostError,
  } from '$lib/transport';
  import ChatInstructions from '$lib/components/ChatInstructions.svelte';
  import InputTemplates from '$lib/components/InputTemplates.svelte';
  import {
    appendTemplateInput,
    inputTemplatesSchema,
    type InputTemplate,
  } from '$lib/input-templates';
  import { claudeInstructions } from '$lib/claude-instructions';
  import ConversationContextMenu from '$lib/components/ConversationContextMenu.svelte';
  import { forkConversation, forkPoint } from '$lib/forks';
  import ModelContext from '$lib/components/ModelContext.svelte';
  import { applyRunEvent } from '$lib/activity';
  import { awaitingAnswer } from '$lib/questions';
  import {
    messageBackgroundWork,
    type BackgroundWorkEvent,
    type HostBackgroundWork,
  } from '$lib/background-work';
  import WindowTitlebar from '$lib/components/WindowTitlebar.svelte';
  import BrowserStatus from '$lib/components/BrowserStatus.svelte';
  import WorkspaceLogin from '$lib/components/WorkspaceLogin.svelte';
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
    loginIdentity,
    type LoginIdentities,
    locationConnections,
    rememberLocation,
    knownLocations,
    conversationLocation,
    groupConversations,
    historySectionId,
    nextActiveConversation,
    scratchLocation,
  } from '$lib/locations';
  import {
    appSessionSchema,
    recordAppSession,
    sessionTimeline,
    startOfDay,
  } from '$lib/app-sessions';
  import {
    registerInstallation,
    registerWslEnvironments,
    accountName,
    connectionLabel,
    executionHost,
    computerViewId,
    computerViews,
    type CliInventory,
    type Installation,
    type WslDiscovery,
  } from '$lib/fleet';
  import { sharedChatSchema, sharedMeta, sharedWorkspace, type Presence } from '$lib/sync';
  import { fallbackModels, modelChoices, reasoningName, type ModelCatalog } from '$lib/models';
  import ChoicePicker from '$lib/components/ChoicePicker.svelte';
  import PlanModePicker from '$lib/components/PlanModePicker.svelte';
  import ComposerCommands from '$lib/components/ComposerCommands.svelte';
  let composerCommands = $state<ComposerCommands>();
  let focusFast = $state(false);
  let draftMentions = $state<import('$lib/mentions').Mention[]>([]);
  let staleMentionTokens = $state<string[]>([]);
  let mentionSelection = $state('');
  const hasComposerMentions = $derived(!!draftMentions.length || !!staleMentionTokens.length);
  let modelPicker = $state<ChoicePicker>();
  let reasoningPicker = $state<ChoicePicker>();
  let usageExpanded = $state(false);
  let preparingCommand = false;
  import { summarizeFileChanges } from '$lib/file-changes';
  import MessageView from '$lib/components/MessageView.svelte';
  import ArtifactViewer from '$lib/components/ArtifactViewer.svelte';
  import type { Artifact } from '$lib/artifacts';
  import ImageAttachments from '$lib/components/ImageAttachments.svelte';
  import {
    readImage,
    imageTypes,
    supportsImages,
    maxImagesPerMessage,
    maxImageLabel,
    type ChatImage,
  } from '$lib/images';
  import {
    enqueueMessage,
    maxQueuedMessages,
    queuedPreview,
    restoreToDraft,
    type QueuedMessage,
  } from '$lib/queue';
  import {
    draftKey,
    hasDraft,
    mergeSavedDrafts,
    readSavedDrafts,
    restoredDraft,
    sameDraft,
    savedDraft,
    savedScratch,
    scratchIdOf,
    scratchTitle,
    type Draft,
    type DraftChange,
    type DraftContent,
    type SavedDraft,
    type SavedScratch,
    type ScratchChat,
  } from '$lib/drafts';
  import {
    replySettingsChanged,
    replySwitches,
    selectedModelName,
    replyTimeTotals,
  } from '$lib/replies';
  import UsagePanel from '$lib/components/UsagePanel.svelte';
  import SettingsPage from '$lib/components/SettingsPage.svelte';
  import BrandMark from '$lib/components/BrandMark.svelte';
  import { estimatePromptTokens, usageKey, snapshotFor, type UsageSnapshot } from '$lib/usage';
  import { mergeLiveUsage, type AccountUpdate } from '$lib/live-usage';
  import { createVirtualSpace, type VirtualSpace } from '$lib/virtual-space';
  import '$lib/styles.css';
  import { initAppearance } from '$lib/appearance.svelte';

  initAppearance();

  type View = 'chat' | 'connections' | 'settings';
  let installation = $state<Installation>();
  let wslDiscovery = $state<WslDiscovery>();
  let wslError = $state('');
  let wslRefreshing = false;
  let connectionStatuses = $state<Record<string, ProviderStatus>>({});
  // Existing CLI login reports per locally managed environment, kept only for this session.
  let environmentLogins = $state<Record<string, Partial<Record<ProviderId, ProviderStatus>>>>({});
  let cliInventories = $state<Record<string, CliInventory>>({});
  const connectionChecks = new Map<string, Promise<void>>();
  let presence = $state<Presence[]>([]);
  let paired = $state(false);
  let workspaceSession = $state(0);
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
  let sidebarElement = $state<HTMLElement>();
  // A finger dragging the drawer keeps it between closed and open until it lifts,
  // and the drawer then carries itself the rest of the way.
  let drawerDrag = $state<number>();
  let drawerSettling = $state(false);
  let drawerSettleTimer: ReturnType<typeof setTimeout>;
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
  let appUpdate = $state<AppUpdateStatus>();
  let restartingForUpdate = $state(false);
  let statuses = $state<ProviderStatus[]>([]);
  let refreshing = $state(false);
  let pendingSignIn = $state<{ provider: ProviderId; connectionId?: string } | null>(null);
  let signInDeadline = 0;
  let activeId = $state<string | null>(null);
  let historyAction = $state<{
    kind: 'rewind' | 'files';
    conversationId: string;
    session: number;
    messageId?: string;
    runId?: string;
  }>();
  let historyBusy = $state(false);
  let historyError = $state('');
  $effect(() => {
    if (
      historyAction &&
      (historyAction.session !== workspaceSession ||
        activeId !== historyAction.conversationId ||
        view !== 'chat' ||
        activeRunning)
    )
      historyAction = undefined;
  });
  // A rewind or Undo error belongs to the conversation it was raised in.
  $effect(() => {
    void activeId;
    untrack(() => (historyError = ''));
  });
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
  let templatesOpen = $state(false);
  $effect(() => {
    if (view !== 'chat') templatesOpen = false;
  });
  let attachedImages = $state<ChatImage[]>([]);
  // Unsent composer content per chat and per scratch chat. Text is saved on this device only;
  // attached images stay until the app closes.
  const drafts = new Map<string, Draft>();
  const changedDrafts = new Map<string, number>();
  let composerDraftKey = '';
  let draftsReady = false;
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let draftSaves = Promise.resolve();
  let draftSaveFailed = false;
  // New conversations not sent yet. Every new chat opens its own scratch chat, and those with
  // unsent content stay in the sidebar until they are sent or discarded.
  type Scratch = ScratchChat & { title: string; filled: boolean };
  let scratches = $state<Scratch[]>([]);
  let scratchId = $state('');
  $effect(() => {
    const content = {
      text: prompt,
      images: $state.snapshot(attachedImages),
      mentions: $state.snapshot(draftMentions),
      staleMentions: $state.snapshot(staleMentionTokens),
      mentionScope: mentionSelection,
    };
    untrack(() => {
      if (!loaded) return;
      composerDraftKey ||= currentDraftKey();
      keepDraft(content);
    });
  });
  // The open scratch chat keeps the computer, folder and settings chosen for it.
  $effect(() => {
    const id = scratchId,
      open = loaded && !activeId;
    const place = {
      computerId: draftComputerId,
      location: locationPending ? undefined : $state.snapshot(draftLocation),
      settings: $state.snapshot(draftSettings),
    };
    untrack(() => {
      if (open && id) placeScratch(id, place);
    });
  });
  let forking = $state(false);
  let attachmentError = $state('');
  let imagesLoading = $state(false);
  let imageDragDepth = $state(0);
  let attachmentGeneration = 0;
  let imageInput = $state<HTMLInputElement>();
  let query = $state('');
  // Replies this window started, by conversation. Each conversation runs one reply at a time;
  // different conversations run side by side.
  let runs = $state<Record<string, string>>({});
  // Messages waiting for the running reply, per conversation. Session-only: never saved or relayed.
  let queued = $state<Record<string, QueuedMessage[]>>({});
  // Steering inputs still being delivered, by run.
  let steeringPending = $state<Record<string, boolean>>({});
  let steeringAttempt: { runId: string; text: string; id: string } | undefined;
  let selectedArtifact = $state<Artifact | null>(null);
  let artifactMode = $state<'modal' | 'panel'>('modal');
  let artifactConversationId = $state<string | null>(null);
  $effect(() => {
    if (view !== 'chat' || activeId !== artifactConversationId) selectedArtifact = null;
    else if (selectedArtifact?.visualization) {
      for (const message of active?.messages ?? []) {
        const visual = message.visualizations?.find(
          (v) => `${message.id}:visual:${v.id}` === selectedArtifact?.id,
        );
        if (visual && visual.revision > (selectedArtifact.revision ?? 0))
          selectedArtifact = {
            ...selectedArtifact,
            title: visual.title,
            source: visual.source,
            revision: visual.revision,
          };
      }
    }
  });
  function openArtifact(artifact: Artifact, mode: 'modal' | 'panel' = 'modal') {
    artifactMode = mode;
    artifactConversationId = activeId;
    selectedArtifact = artifact;
  }
  // Conversations whose reply this window is stopping.
  let stopping = $state<Record<string, boolean>>({});
  let editorOpen = $state(false);
  let contextOpen = $state(false);
  let deletion = $state<{
    type: 'conversation' | 'draft';
    id: string;
    name: string;
    trigger: HTMLButtonElement;
  } | null>(null);
  let deleting = $state(false);
  let deletionError = $state('');
  let conversationMenu = $state<{
    id: string;
    scratch?: boolean;
    trigger: HTMLButtonElement;
    x: number;
    y: number;
  } | null>(null);
  const menuConversation = $derived(
    conversationMenu?.scratch
      ? undefined
      : workspace.conversations.find((c) => c.id === conversationMenu?.id),
  );
  const menuScratch = $derived(
    conversationMenu?.scratch ? scratches.find((s) => s.id === conversationMenu?.id) : undefined,
  );
  const deletingConversation = $derived(
    deletion?.type === 'conversation'
      ? workspace.conversations.find((c) => c.id === deletion?.id)
      : undefined,
  );
  let touchMenuTimer: ReturnType<typeof setTimeout> | undefined;
  let touchMenuOrigin: { x: number; y: number } | undefined;
  let longPressedConversation: string | undefined;
  let composerInput = $state<HTMLTextAreaElement>();
  let chatScroll = $state<HTMLDivElement>();
  let chatColumn = $state<HTMLDivElement>();
  let chatSpace = $state<HTMLDivElement>();
  let composerArea = $state<HTMLDivElement>();
  let virtualSpace: VirtualSpace | undefined;
  let nearBottom = true;
  // The conversation's height when the chat last followed its end or the reader moved.
  let followedHeight = 0;
  // Runs after the reader scrolls, expands, or collapses content.
  function readingPosition() {
    const hold = virtualSpace?.scrolled() ?? 'free';
    // Scrolling up through held space is a deliberate reading position too. While space
    // holds the position, new content fills it before the chat follows.
    if (hold === 'up') nearBottom = false;
    else if (hold === 'free' && chatScroll)
      // Only follow at the end. A reading position just above it is still deliberate.
      nearBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 2;
    followedHeight = chatColumn?.getBoundingClientRect().height ?? 0;
  }
  $effect(() => {
    if (!chatScroll || !chatColumn || !chatSpace) return;
    // Expanding or collapsing content keeps the chat in place.
    const space = createVirtualSpace(chatScroll, chatColumn, chatSpace, readingPosition);
    virtualSpace = space;
    return () => {
      space.destroy();
      if (virtualSpace === space) virtualSpace = undefined;
    };
  });
  $effect(() => {
    void activeId;
    untrack(() => virtualSpace?.clear());
    followedHeight = 0;
  });
  $effect(() => {
    const scroll = chatScroll;
    if (!scroll) return;
    // Passive, so a busy main thread never delays the start of a scroll.
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && !event.ctrlKey) nearBottom = false;
    };
    scroll.addEventListener('wheel', wheel, { passive: true });
    return () => scroll.removeEventListener('wheel', wheel);
  });
  $effect(() => {
    const scroll = chatScroll,
      area = composerArea;
    if (!scroll || !area) return;
    let height = 0;
    const observer = new ResizeObserver(() => {
      const next = scroll.clientHeight;
      if (next === height) return;
      // Usage details open over the conversation, so they must fit in what remains of it.
      area.style.setProperty('--chat-height', `${next}px`);
      // A growing draft, a smaller window or a phone keyboard shortens the chat from below.
      // While following, keep its end in view instead of pushing it under the composer.
      if (next < height && nearBottom) {
        virtualSpace?.trim();
        scroll.scrollTop = scroll.scrollHeight;
      }
      height = next;
    });
    observer.observe(scroll);
    return () => observer.disconnect();
  });
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
  const standaloneChoice = $derived(standaloneLocation(selectedComputerId));
  const scopedConnections = $derived(
    selectedLocation
      ? locationConnections(workspace.fleet, selectedLocation)
      : workspace.fleet.connections.filter((c) =>
          selectedComputer?.environments.some((e) => e.id === c.environmentId),
        ),
  );
  const availableProviders = $derived(
    providerIds.filter((provider) =>
      scopedConnections.some(
        (c) =>
          workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider === provider &&
          canChooseConnection(c.id),
      ),
    ),
  );
  const agentOptions = $derived.by(() => {
    const preview = !desktop() && !paired && !selectedComputer;
    return providerIds.flatMap((provider) => {
      // A saved chat keeps its agent; only that agent's accounts on its computer are offered.
      if (active && provider !== selectedSettings.provider) return [];
      const candidates = scopedConnections.filter(
        (c) =>
          workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider === provider &&
          (canChooseConnection(c.id) || (!!active && c.id === selectedSettings.connectionId)),
      );
      // Saved chats retain their fixed agent; drafts only offer this computer's available CLIs.
      if (!preview && !candidates.length && !(active && provider === selectedSettings.provider))
        return [];
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
    )?.id ?? (active ? selectedSettings.provider : ''),
  );
  // A chat's account connection, whether another computer runs it, and its reported status.
  function replyConnection(settings: Pick<ChatSettings, 'provider' | 'connectionId'>) {
    const connection = workspace.fleet.connections.find((c) => c.id === settings.connectionId);
    const host = connection && executionHost(workspace.fleet, connection.environmentId);
    const remote = !!connection && host !== installation?.id;
    const status = settings.connectionId
      ? remote
        ? presence
            .find((p) => p.environmentId === host && p.online)
            ?.connections.find((c) => c.connectionId === settings.connectionId)
        : connectionStatuses[settings.connectionId]
      : statusFor(settings.provider);
    return { connection, remote, status };
  }
  const selectedReplyConnection = $derived(replyConnection(selectedSettings));
  const selectedConnection = $derived(selectedReplyConnection.connection);
  const selectedRemote = $derived(selectedReplyConnection.remote);
  const selectedStatus = $derived(selectedReplyConnection.status);

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
  // Scratch chats with unsent content, newest first. Typing reads their titles only while searching.
  const sidebarScratches = $derived.by(() => {
    const search = query.toLowerCase();
    return scratches
      .filter(
        (s) =>
          s.filled &&
          (!search ||
            `${s.title} ${s.location?.path ?? ''} ${computers.find((computer) => computer.id === (s.location ? locationComputerId(s.location) : s.computerId))?.name ?? ''}`
              .toLowerCase()
              .includes(search)),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  });
  // History names session days from today, which the minute timer moves on at midnight.
  let today = $state(startOfDay(Date.now()));
  const conversationGroups = $derived(
    groupConversations(
      recent,
      workspace.fleet,
      installation,
      sidebarScratches,
      workspace.appSessions,
      today,
    ),
  );
  const pendingChats = $derived(pendingChatCount(workspace.conversations));
  const observedReply = $derived(
    active?.messages.find((m) => m.role === 'assistant' && m.status === 'running'),
  );
  const activeRunning = $derived((!!activeId && !!runs[activeId]) || !!observedReply);
  const activeStopping = $derived(!!activeId && !!stopping[activeId]);
  const activeSteering = $derived(
    !!observedReply?.runId && !!steeringPending[observedReply.runId],
  );
  // A reply this window started is running in any conversation.
  const localRunning = $derived(Object.keys(runs).length > 0);
  // Background work this computer still runs for each chat, including after its reply.
  let hostBackground = $state<Record<string, HostBackgroundWork>>({});
  function applyBackgroundWork(event: BackgroundWorkEvent) {
    if (event.kind === 'snapshot') {
      if (event.runs.length)
        hostBackground[event.conversationId] = { runs: event.runs, at: Date.now() };
      else delete hostBackground[event.conversationId];
      return;
    }
    // A task that finished after its reply ended records its outcome in that reply.
    const reply = workspace.conversations
      .find((c) => c.id === event.conversationId)
      ?.messages.find((m) => m.role === 'assistant' && m.runId === event.runId);
    if (!reply) return;
    applyRunEvent(reply, { kind: 'tool', tool: event.tool });
    saveSoon(event.conversationId);
  }
  const switchNotices = $derived(
    replySwitches(active?.messages ?? [], (id) => accountName(workspace.fleet, id)),
  );
  // Other accounts of this chat's agent on its computer that may take the next reply.
  // Claude and Codex conversations start a fresh native session for the new account.
  const switchableConnections = $derived(
    active && (selectedSettings.provider === 'claude' || selectedSettings.provider === 'codex')
      ? scopedConnections.filter(
          (c) =>
            c.id !== selectedSettings.connectionId &&
            workspace.fleet.accounts.find((a) => a.id === c.accountId)?.provider ===
              selectedSettings.provider &&
            canChooseConnection(c.id),
        )
      : [],
  );
  const lastReplyConnection = $derived(
    active?.messages.findLast((m) => m.role === 'assistant' && !!m.settings?.connectionId)
      ?.settings?.connectionId,
  );
  const accountSwitchPending = $derived(
    !!active &&
      !activeRunning &&
      !!lastReplyConnection &&
      !!selectedSettings.connectionId &&
      lastReplyConnection !== selectedSettings.connectionId,
  );
  const timeTotals = $derived(replyTimeTotals(active?.messages ?? []));
  const chatChanges = $derived(
    summarizeFileChanges((active?.messages ?? []).filter((m) => !m.filesUndone)),
  );
  const nextReplyChanged = $derived(
    !!observedReply?.settings && replySettingsChanged(observedReply.settings, selectedSettings),
  );
  const canSend = $derived(
    loaded &&
      !historyBusy &&
      !historyAction &&
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
      !activeRunning &&
      (desktop() || paired) &&
      (desktop() || online) &&
      (!selectedRemote || (paired && !syncError)) &&
      !!selectedStatus?.installed &&
      selectedStatus.auth === 'ready',
  );
  const activeQueue = $derived(activeId ? (queued[activeId] ?? []) : []);
  const canCompact = $derived(canSend && !active?.rewind && !!active?.messages.some(m => m.role === 'assistant') &&
    ['claude', 'codex'].includes(selectedSettings.provider) &&
    active?.messages.findLast(m => m.role === 'assistant')?.settings?.connectionId === selectedSettings.connectionId);
  const steeringSupported = $derived(
    observedReply?.settings?.provider === 'codex' || observedReply?.settings?.provider === 'claude',
  );
  const canSteer = $derived(
    loaded &&
      activeRunning &&
      steeringSupported &&
      !observedReply?.compact &&
      !!observedReply?.runId &&
      !activeStopping &&
      !activeSteering &&
      !imagesLoading &&
      !attachedImages.length &&
      !hasComposerMentions &&
      !!prompt.trim() &&
      !prompt.trimStart().startsWith('/') &&
      (desktop() || (paired && online)) &&
      (!selectedRemote || (paired && !syncError)),
  );
  // A message may wait for the running reply of the open conversation.
  const canQueue = $derived(
    loaded &&
      !!active &&
      activeRunning &&
      !activeSteering &&
      !activeStopping &&
      !imagesLoading &&
      (!attachedImages.length || imagesSupported) &&
      !selectingLocation &&
      !locationPending &&
      (desktop() || paired) &&
      (desktop() || online) &&
      activeQueue.length < maxQueuedMessages,
  );
  const viewTitle = $derived(
    {
      chat: active?.title ?? 'New conversation',
      connections: 'Connections',
      settings: 'Settings',
    }[view],
  );

  let relayRestorePending = $state(true);
  let notificationTarget = $state<string>();
  function followNotification() {
    if (!notificationTarget || !loaded) return;
    const conversation = workspace.conversations.find((c) => c.id === notificationTarget);
    if (!conversation) return; // A cold start may still be downloading the checkpoint.
    // Unsent drafts stay with their own chat. Only an image still being read waits for it.
    if (activeId !== conversation.id && imagesLoading) return;
    notificationTarget = undefined;
    if (activeId !== conversation.id) openConversation(conversation);
    else {
      view = 'chat';
      sidebarOpen = false;
    }
    if (notificationConversation(window.location.hash))
      history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  let relayRestoreBusy = false;
  let relaySelectionVersion = 0;
  async function restoreRelayConnection() {
    if (!loaded || relayRestoreBusy) return;
    relayRestoreBusy = true;
    const version = relaySelectionVersion;
    try {
      const connected = await resumeRelay();
      if (version !== relaySelectionVersion) return;
      relayRestorePending = false;
      paired = connected;
      syncError = '';
      if (connected) await syncNow();
    } catch (error) {
      if (version !== relaySelectionVersion) return;
      if (error instanceof BrowserWorkspaceStorageError) {
        loaded = false;
        paired = false;
        relayRestorePending = false;
        storageError = error.message;
        syncError = error.message;
        return;
      }
      relayRestorePending = true;
      syncError =
        desktop() ||
        (error instanceof Error && /Pair this device|Relay data was replaced/.test(error.message))
          ? String(error).replace(/^Error: /, '')
          : 'Server unavailable. Reconnecting automatically…';
    } finally {
      relayRestoreBusy = false;
    }
  }

  $effect(() => {
    // Track only the visible chat selection, never streamed workspace content.
    loaded;
    view;
    activeId;
    untrack(() => {
      void publishNotificationView();
    });
  });
  onMount(() => {
    let disposed = false;
    const stopAccountUpdates = watchAccountUpdates(applyAccountUpdate);
    const stopBackgroundWork = watchBackgroundWork(applyBackgroundWork);
    const stopUsageRefresh = watchUsageRefresh(refreshUsageConnection);
    const stopNotificationView = watchNotificationView(
      () => (loaded && view === 'chat' ? activeId || undefined : undefined),
    );
    const stopBrowserSession = watchBrowserSession();
    let stopNotifications = () => {};
    void watchDesktopNotifications((id) => {
      notificationTarget = notificationConversation(`#conversation=${id}`);
      followNotification();
    }).then((stop) => {
      if (disposed) stop();
      else stopNotifications = stop;
    });
    let stopAppUpdates = () => {};
    void watchAppUpdates((status) => (appUpdate = status)).then((stop) => {
      if (disposed) stop();
      else stopAppUpdates = stop;
    });
    const notificationHash = () => {
      notificationTarget = notificationConversation(window.location.hash);
      followNotification();
    };
    const notificationMessage = (event: MessageEvent) => {
      if (
        event.source !== navigator.serviceWorker.controller ||
        event.data?.type !== 'studio-notification-open'
      )
        return;
      notificationTarget = notificationConversation(event.data.hash);
      followNotification();
    };
    if (!desktop()) {
      notificationHash();
      window.addEventListener('hashchange', notificationHash);
      navigator.serviceWorker?.addEventListener('message', notificationMessage);
    }
    const network = () => {
      online = navigator.onLine;
    };
    network();
    window.addEventListener('online', network);
    window.addEventListener('offline', network);
    const stopViewport = trackMobileViewport();
    const stopDrawerSwipe = trackDrawerSwipe({
      enabled: () => mobile && !deletion && !conversationMenu,
      open: () => sidebarOpen,
      drawer: () => sidebarElement,
      move: (progress) => {
        if (progress === undefined && drawerDrag !== undefined) {
          drawerSettling = true;
          clearTimeout(drawerSettleTimer);
          drawerSettleTimer = setTimeout(() => (drawerSettling = false), 400);
        }
        drawerDrag = progress;
      },
      settle: (open) => {
        if (open !== sidebarOpen) void toggleSidebar(open);
      },
    });
    let focusTimer: ReturnType<typeof setTimeout>;
    const onReturn = () => {
      if (!loaded || document.visibilityState === 'hidden') return;
      if (paired) void syncNow();
      else void restoreRelayConnection();
      if (localRunning) return;
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => {
        void refresh();
        if (view === 'chat') void refreshUsage();
      }, 250);
    };
    window.addEventListener('focus', onReturn);
    window.addEventListener('online', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    // Save typed drafts right away when the window is left, hidden, or closed.
    const saveDraftsOnLeave = () => void saveDraftsNow();
    const saveDraftsWhenHidden = () => {
      if (document.visibilityState === 'hidden') void saveDraftsNow();
    };
    window.addEventListener('blur', saveDraftsOnLeave);
    window.addEventListener('pagehide', saveDraftsOnLeave);
    document.addEventListener('visibilitychange', saveDraftsWhenHidden);
    const loginPoll = setInterval(() => {
      if (pendingSignIn && Date.now() < signInDeadline && !localRunning) void refresh();
    }, 5000);
    const usagePoll = setInterval(() => {
      today = startOfDay(Date.now());
      if (loaded && document.visibilityState !== 'hidden') {
        if (view === 'chat') void refreshUsage();
        if (view === 'connections') void refreshAccountUsage();
      }
    }, 60_000);
    const relayPoll = setInterval(() => {
      if (paired) void syncNow();
      else if (
        relayRestorePending &&
        online &&
        (desktop() || document.visibilityState !== 'hidden')
      )
        void restoreRelayConnection();
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
        // History lists the chats used from this start of the app until the next one under it.
        const started = desktop() ? await appSession().catch(() => undefined) : undefined;
        const session = started && installation && { ...started, environmentId: installation.id };
        if (session && appSessionSchema.safeParse(session).success)
          workspace.appSessions = recordAppSession(
            workspace.appSessions,
            session,
            workspace.conversations,
          );
        draftComputerId =
          workspace.fleet.environments.find((e) => e.id === installation?.id)?.computerId ??
          installation?.computerId ??
          '';
        draftLocation = workspace.preferences.recentLocations?.find(
          (l) => locationConnections(workspace.fleet, l).length,
        );
        draftSettings = settingsFor(workspace.preferences);
        await loadSavedDrafts();
        loaded = true;
        if (!continueScratch()) newChat();
        if (installation)
          configureRuntime({
            installation,
            workspace: () => $state.snapshot(workspace),
            // Validating the live workspace already detaches the replicated part of it, so this
            // costs about half of a snapshot of everything followed by the same validation.
            shared: () => sharedWorkspace(workspace),
            fleet: () => $state.snapshot(workspace.fleet),
            revision: () => localChanges,
            statuses: () => $state.snapshot(connectionStatuses),
            localRuns: () => Object.values(runs),
            replaceBrowserWorkspace: async (value, reason, preserveInitialNotification = false) => {
              workspaceSession++;
              queued = {};
              resetDrafts();
              forking = false;
              const previousView = view;
              workspace = value;
              connectionStatuses = {};
              cliInventories = {};
              presence = [];
              modelGeneration++;
              modelCache.clear();
              modelRequests.clear();
              models = structuredClone(fallbackModels);
              usageSnapshots = {};
              usageLoading = {};
              usageErrors = {};
              draftComputerId = '';
              selectingLocation = false;
              preparingCommand = false;
              runs = {};
              stopping = {};
              steeringPending = {};
              selectedArtifact = null;
              sidebarOpen = false;
              folderBrowserOpen = false;
              contextOpen = false;
              editorOpen = false;
              templatesOpen = false;
              conversationMenu = null;
              deletion = null;
              deleting = false;
              deletionError = '';
              if (!preserveInitialNotification) notificationTarget = undefined;
              collapsedGroups = {};
              query = '';
              notice = '';
              newChat();
              view = previousView;
              if (reason !== undefined) {
                ++relaySelectionVersion;
                paired = false;
                relayRestorePending = false;
                syncError = reason;
                syncStatus = 'Pair with your private workspace to see its chats and computers.';
              }
              await loadSavedDrafts();
              await persist();
            },
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
              await persistChat(conversation.id);
            },
            apply: async (value) => {
              workspace.fleet = value.fleet;
              workspace.workflows = value.workflows;
              workspace.inputTemplates = value.inputTemplates;
              workspace.claudeInstructions = value.claudeInstructions;
              workspace.appSessions = value.appSessions;
              // Preserve active object identities while network responses arrive.
              workspace.conversations = value.conversations.map((incoming) => {
                const existing = workspace.conversations.find((c) => c.id === incoming.id);
                if (existing) {
                  Object.assign(existing, incoming);
                  return existing;
                }
                return incoming;
              });
              // A conversation deleted on another device takes its unsent draft along.
              const chats = new Set(workspace.conversations.map((c) => draftKey.chat(c.id)));
              for (const key of [...drafts.keys()])
                if (key.startsWith('chat:') && key !== composerDraftKey && !chats.has(key))
                  forgetDraft(key);
              // Received from the relay, so nothing new to send back.
              await persist(false);
              refreshNewConnections();
            },
            chat: (id) => {
              const conversation = workspace.conversations.find((c) => c.id === id);
              return conversation && sharedChatSchema.parse(conversation);
            },
            chatIds: () => workspace.conversations.map((c) => c.id),
            meta: () => sharedMeta(workspace),
            takeUnsynced: () => {
              const pending = unsyncedChats;
              unsyncedChats = new Set();
              return pending;
            },
            restoreUnsynced: (ids) => {
              if (ids === undefined || !unsyncedChats) unsyncedChats = undefined;
              else for (const id of ids) unsyncedChats.add(id);
            },
            // Only the conversations a sync merged, so an unrelated chat is never rewritten.
            applyChats: async (upsert, remove, meta) => {
              if (meta) {
                workspace.fleet = meta.fleet;
                workspace.workflows = meta.workflows;
                workspace.inputTemplates = meta.inputTemplates;
                workspace.claudeInstructions = meta.claudeInstructions;
                workspace.appSessions = meta.appSessions;
              }
              const gone = new Set(remove);
              if (gone.size)
                workspace.conversations = workspace.conversations.filter((c) => !gone.has(c.id));
              for (const incoming of upsert) {
                const existing = workspace.conversations.find((c) => c.id === incoming.id);
                // Preserve active object identities while network responses arrive.
                if (existing) Object.assign(existing, incoming);
                else workspace.conversations.push(incoming);
              }
              // A conversation deleted on another device takes its unsent draft along.
              const chats = new Set(workspace.conversations.map((c) => draftKey.chat(c.id)));
              for (const key of [...drafts.keys()])
                if (key.startsWith('chat:') && key !== composerDraftKey && !chats.has(key))
                  forgetDraft(key);
              // Received from the relay, so only these conversations need saving here.
              if (!loaded) return;
              for (const conversation of upsert) markChats(conversation.id);
              if (gone.size || meta) markChats();
              await flushWorkspace();
              refreshNewConnections();
            },
          });
        await persist();
        await restoreRelayConnection();
        followNotification();
      } catch (e) {
        storageError = `Could not load your workspace. ${String(e)} No saved data has been overwritten.`;
      }
      void refreshModels();
      await refresh();
    })();
    return () => {
      disposed = true;
      stopAccountUpdates();
      stopBackgroundWork();
      stopUsageRefresh();
      stopNotificationView();
      stopNotifications();
      stopAppUpdates();
      stopBrowserSession();
      window.removeEventListener('hashchange', notificationHash);
      navigator.serviceWorker?.removeEventListener('message', notificationMessage);
      cancelTouchMenu();
      window.removeEventListener('online', network);
      window.removeEventListener('offline', network);
      stopViewport();
      stopDrawerSwipe();
      clearTimeout(drawerSettleTimer);
      clearTimeout(focusTimer);
      clearInterval(loginPoll);
      clearInterval(usagePoll);
      clearInterval(relayPoll);
      clearInterval(wslPoll);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('online', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('blur', saveDraftsOnLeave);
      window.removeEventListener('pagehide', saveDraftsOnLeave);
      document.removeEventListener('visibilitychange', saveDraftsWhenHidden);
    };
  });
  async function syncNow() {
    const version = relaySelectionVersion;
    try {
      const peers = await pollRelay();
      if (peers) {
        followNotification();
        presence = peers;
        syncError = '';
        syncStatus = `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · Environments report every few seconds`;
      }
    } catch (e) {
      if (version !== relaySelectionVersion) return;
      syncError = String(e);
      presence = presence.map((p) => ({ ...p, online: false }));
    }
  }
  async function pair(url: string, key: string) {
    ++relaySelectionVersion;
    await persist();
    try {
      await connectRelay(url, key);
    } catch (error) {
      syncError = String(error).replace(/^Error: /, '');
      if (error instanceof BrowserWorkspaceStorageError) {
        loaded = false;
        paired = false;
        relayRestorePending = false;
        storageError = error.message;
      }
      throw error;
    }
    paired = true;
    relayRestorePending = false;
    await syncNow();
    if (!desktop() && paired) {
      view = 'chat';
      notificationTarget = notificationConversation(window.location.hash);
      followNotification();
    }
    if (!active && !draftComputerId) draftComputerId = computers[0]?.id ?? '';
  }
  async function unpair() {
    ++relaySelectionVersion;
    await disconnectRelay();
    paired = false;
    relayRestorePending = false;
    presence = [];
    syncError = '';
    syncStatus = desktop()
      ? 'Disconnected. Changes continue to save on this environment.'
      : 'Disconnected. Pair with your private workspace to see its chats and computers.';
  }
  // Changes to be synchronized, so relay polls can skip the whole-workspace sync while nothing
  // changed. Streamed reply events count too, because they update messages before a save.
  let localChanges = 0;
  // Conversations changed since the last save and since the last sync, or `undefined` for all of
  // them. Naming no chat asks for everything, so a new call site is conservative by default.
  let unsavedChats: Set<string> | undefined;
  let unsyncedChats: Set<string> | undefined;
  function markChats(chatId?: string) {
    if (chatId === undefined) {
      unsavedChats = undefined;
      unsyncedChats = undefined;
      return;
    }
    if (unsavedChats) unsavedChats.add(chatId);
    if (unsyncedChats) unsyncedChats.add(chatId);
  }
  /** Checks any connection this device owns whose status is not known yet. */
  function refreshNewConnections() {
    if (
      workspace.fleet.connections.some(
        (c) =>
          executionHost(workspace.fleet, c.environmentId) === installation?.id &&
          !connectionStatuses[c.id],
      )
    )
      void refreshConnections();
  }
  async function flushWorkspace() {
    if (!loaded) return;
    const scope = workspaceStorageScope();
    // Saving serializes the workspace anyway, so copying it first only walked every
    // conversation twice. The queued save keeps this workspace and writes its newest state,
    // which is what the file should hold; a later reassignment cannot redirect it.
    const saved = workspace;
    const pending = unsavedChats;
    unsavedChats = new Set();
    const next = saveQueue.catch(() => {}).then(async () => {
      const started = performance.now();
      try {
        // Resolve the named conversations when the save runs, so it sends their newest state.
        await saveWorkspace(
          saved,
          scope,
          pending && saved.conversations.filter((c) => pending.has(c.id)),
        );
      } finally {
        lastSaveMs = performance.now() - started;
      }
    });
    saveQueue = next;
    try {
      await next;
      storageError = '';
    } catch (e) {
      // A failed save must never leave its conversations looking saved.
      unsavedChats = undefined;
      storageError = `Changes could not be saved: ${String(e)}`;
      throw e;
    }
  }
  async function persist(local = true) {
    if (!loaded) return;
    if (local) localChanges++;
    markChats();
    await flushWorkspace();
  }
  /** Saves a change to one conversation, leaving the rest to the host's last write. */
  async function persistChat(chatId: string) {
    if (!loaded) return;
    localChanges++;
    markChats(chatId);
    await flushWorkspace();
  }
  // How long the last save took, so a streamed reply can keep saving to a small share of the
  // time. A save writes the whole workspace, so it grows with the workspace and no frequency
  // makes it free; the reply's own end, its plans, questions and file changes still save at once.
  let lastSaveMs = 0;
  const streamSaveInterval = () => Math.min(15_000, Math.max(1_000, lastSaveMs * 50));
  // A streamed reply asks to save far faster than a large workspace can be written. Each save
  // writes the newest state, so requests made while one runs only need one more save after it.
  let savingSoon = false;
  let saveAgain = false;
  function saveSoon(chatId?: string) {
    markChats(chatId);
    saveAgain = true;
    if (savingSoon) return;
    void (async () => {
      savingSoon = true;
      try {
        while (saveAgain) {
          saveAgain = false;
          localChanges++;
          await flushWorkspace().catch(() => {});
        }
      } finally {
        savingSoon = false;
      }
    })();
  }
  async function restartToUpdate() {
    // Finish saving this workspace and its drafts before the installer closes the app.
    await saveDraftsNow();
    await persist();
    await installAppUpdate();
  }
  async function restartFromSidebar() {
    if (restartingForUpdate) return;
    restartingForUpdate = true;
    try {
      await restartToUpdate();
    } catch (e) {
      notice = String(e);
    } finally {
      restartingForUpdate = false;
    }
  }
  function openRewind(messageId?: string) {
    if (!active?.messages.some((m) => m.role === 'user')) {
      historyError = 'There are no messages to rewind.';
      return;
    }
    if (activeRunning || historyBusy || activeQueue.length) {
      historyError = 'Wait for the response and queued messages to finish before rewinding.';
      return;
    }
    historyError = '';
    historyAction = {
      kind: 'rewind',
      conversationId: active.id,
      messageId,
      session: workspaceSession,
    };
  }
  function openUndoFiles(runId?: string) {
    if (!active || activeRunning || historyBusy || activeQueue.length) {
      historyError = 'Open an idle conversation before Undo.';
      return;
    }
    const target =
      runId ??
      active.messages.findLast(
        (m) => m.role === 'assistant' && m.fileChanges?.edits.length && !m.filesUndone,
      )?.runId;
    if (!target) {
      historyError = 'There are no recorded file edits to undo.';
      return;
    }
    historyError = '';
    historyAction = {
      kind: 'files',
      conversationId: active.id,
      runId: target,
      session: workspaceSession,
    };
  }
  async function changeHistory(messageId?: string) {
    if (!active || activeRunning || historyBusy || activeQueue.length)
      throw new Error('Wait for the response to finish before rewinding.');
    const before = $state.snapshot(active),
      session = workspaceSession;
    const next = messageId ? rewindConversation(before, messageId) : undoRewind(before);
    historyBusy = true;
    try {
      workspace.conversations = workspace.conversations.map((c) => (c.id === next.id ? next : c));
      await persist();
      if (session !== workspaceSession) return;
      await releaseConversation(next.id, next.settings.connectionId).catch(() => {});
      selectedArtifact = null;
      historyError = '';
      // The conversation now ends elsewhere: drop held space and show the new end.
      virtualSpace?.clear();
      nearBottom = true;
      void scrollToEnd();
      // The control that started this is usually gone; continue in the composer.
      void tick().then(() =>
        requestAnimationFrame(() => {
          if (!historyAction && session === workspaceSession)
            composerInput?.focus({ preventScroll: true });
        }),
      );
    } catch (e) {
      if (session === workspaceSession)
        workspace.conversations = workspace.conversations.map((c) =>
          c.id === before.id ? before : c,
        );
      throw e;
    } finally {
      if (session === workspaceSession) historyBusy = false;
    }
  }
  async function prepareUndo(conversationId: string, session: number) {
    if (
      session !== workspaceSession ||
      !active ||
      active.id !== conversationId ||
      activeRunning
    )
      throw new Error('The conversation changed. Reopen Undo.');
    await persist();
  }
  async function markFilesUndone(conversationId: string, runId: string, session: number) {
    if (session !== workspaceSession) return;
    const conversation = workspace.conversations.find((c) => c.id === conversationId);
    const message = conversation?.messages.find((m) => m.runId === runId);
    if (!conversation || !message) return;
    if (!message.filesUndone) {
      message.filesUndone = true;
      conversation.historyRevision = (conversation.historyRevision ?? 0) + 1;
    }
    conversation.updatedAt = new Date().toISOString();
    await persist();
  }
  async function updateInputTemplate(
    template: InputTemplate | undefined,
    previous?: InputTemplate,
  ) {
    const session = workspaceSession;
    const before = $state.snapshot(workspace.inputTemplates);
    const current = before?.find((item) => item.id === (previous?.id ?? template?.id));
    if (JSON.stringify(current) !== JSON.stringify(previous))
      throw new Error(
        'This template changed on another device. Reopen it from the library before editing.',
      );
    const next = inputTemplatesSchema.parse(
      template
        ? previous
          ? (before ?? []).map((item) => (item.id === template.id ? template : item))
          : [...(before ?? []), template]
        : (before ?? []).filter((item) => item.id !== previous?.id),
    );
    workspace.inputTemplates = next;
    try {
      await persist();
    } catch {
      if (
        session === workspaceSession &&
        JSON.stringify(workspace.inputTemplates) === JSON.stringify(next)
      )
        workspace.inputTemplates = before;
      throw new Error('The template could not be saved. Your changes are still here; try again.');
    }
  }
  async function saveClaudeInstructions(value: string | undefined, previous: string | undefined) {
    const session = workspaceSession;
    const before = workspace.claudeInstructions;
    if (before !== previous)
      throw new Error(
        'These instructions changed on another device. Save again to replace them with your text.',
      );
    workspace.claudeInstructions = value;
    try {
      await persist();
    } catch {
      if (session === workspaceSession && workspace.claudeInstructions === value)
        workspace.claudeInstructions = before;
      throw new Error('The instructions could not be saved. Your text is still here; try again.');
    }
  }
  function closeTemplates() {
    templatesOpen = false;
    void tick().then(() => composerInput?.focus());
  }
  async function refresh(forceUsage = false) {
    if (refreshing) return;
    refreshing = true;
    try {
      await refreshWsl();
      await refreshCliInventories();
      statuses = await detectProviders();
      if (installation)
        environmentLogins[installation.id] = Object.fromEntries(statuses.map((s) => [s.id, s]));
      // Connected accounts report their own login identities first, so a terminal login that
      // is already connected through another profile is recognised instead of duplicated.
      await refreshConnections();
      const before = workspace.fleet.connections.length;
      for (const environment of workspace.fleet.environments) {
        if (executionHost(workspace.fleet, environment.id) !== installation?.id) continue;
        const inventory = cliInventories[environment.id];
        if (inventory?.error || !inventory?.entries) continue;
        const detected = inventory.entries.filter((entry) => entry.path).map((entry) => entry.id);
        if (environment.id !== installation?.id)
          await probeEnvironmentLogins(environment.id, detected);
        ensureEnvironmentConnections(workspace.fleet, environment.id, detected, loginIdentities());
      }
      if (workspace.fleet.connections.length !== before) {
        await persist();
        await refreshConnections(undefined, true);
      }
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
  // Managed WSL distributions have no provider-level status; check their existing logins only
  // while no connection registers them yet.
  async function probeEnvironmentLogins(environmentId: string, detected: ProviderId[]) {
    const missing = detected.filter(
      (provider) =>
        !workspace.fleet.connections.some(
          (c) =>
            c.environmentId === environmentId &&
            c.profile === 'existing' &&
            workspace.fleet.accounts.some((a) => a.id === c.accountId && a.provider === provider),
        ),
    );
    await Promise.all(
      missing.map(async (provider) => {
        let status: ProviderStatus;
        try {
          status = await detectEnvironmentLogin(environmentId, provider);
        } catch (e) {
          status = {
            id: provider,
            installed: false,
            auth: 'unknown',
            version: null,
            detail: String(e),
          };
        }
        environmentLogins[environmentId] = {
          ...environmentLogins[environmentId],
          [provider]: status,
        };
      }),
    );
  }
  function loginIdentities(): LoginIdentities {
    return {
      login: (environmentId, provider) =>
        loginIdentity(environmentLogins[environmentId]?.[provider]),
      connection: (id) => loginIdentity(connectionStatus(id)),
    };
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
  function canQueryConnection(connectionId?: string, provider = selectedSettings.provider) {
    if (!connectionId) return desktop() && statusFor(provider)?.auth === 'ready';
    const connection = workspace.fleet.connections.find((c) => c.id === connectionId);
    if (!connection) return false;
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
            if (!canQueryConnection(selected.connectionId, selected.provider))
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
      } else if (
        generation === modelGeneration &&
        canQueryConnection(selected.connectionId, selected.provider)
      )
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
      !canQueryConnection(settings.connectionId, settings.provider) ||
      (!settings.connectionId && !active && !selectedLocation)
    )
      return;
    const key = usageKey(settings);
    if (usageLoading[key]) return;
    usageLoading[key] = true;
    const scope = workspaceStorageScope();
    const revision = accountUsageRevision(settings.connectionId);
    const current = () =>
      scope === workspaceStorageScope() && revision === accountUsageRevision(settings.connectionId);
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
      if (!current()) return;
      snapshot.live = snapshotFor(usageSnapshots, settings)?.live;
      usageSnapshots[key] = { ...snapshot, connectionId: settings.connectionId };
      usageErrors[key] = '';
    } catch (e) {
      if (current()) usageErrors[key] = String(e);
    } finally {
      if (scope === workspaceStorageScope()) {
        usageLoading[key] = false;
        const latest = accountUsageRevision(settings.connectionId);
        if (latest?.accountChanged && (latest.epoch !== revision?.epoch || latest.accountChanged !== revision?.accountChanged))
          void refreshUsage(settings, true);
      }
    }
  }
  function refreshUsageConnection(connectionId: string) {
    const account = workspace.fleet.accounts.find(
      (a) => a.id === workspace.fleet.connections.find((c) => c.id === connectionId)?.accountId,
    );
    if (account)
      void refreshUsage(
        {
          provider: account.provider,
          connectionId,
          model: selectedSettings.connectionId === connectionId ? selectedSettings.model : '',
        },
        true,
      );
  }
  function applyAccountUpdate(update: AccountUpdate, accountChanged: boolean) {
    if (!loaded) return;
    const matching = Object.entries(usageSnapshots).filter(
      ([, snapshot]) =>
        snapshot.connectionId === update.connectionId &&
        snapshot.provider === update.snapshot.provider,
    );
    for (const [key, previous] of matching) {
      usageSnapshots[key] = mergeLiveUsage(accountChanged ? undefined : previous, update);
      usageErrors[key] = '';
    }
    if (!matching.length) {
      const key = usageKey({
        provider: update.snapshot.provider,
        connectionId: update.connectionId,
        model: '',
      });
      usageSnapshots[key] = mergeLiveUsage(undefined, update);
    }
    if (accountChanged) {
      const scope = workspaceStorageScope();
      const connection = workspace.fleet.connections.find((c) => c.id === update.connectionId);
      if (
        connection &&
        executionHost(workspace.fleet, connection.environmentId) === installation?.id
      ) {
        connectionStatuses[connection.id] = {
          id: update.snapshot.provider,
          installed: true,
          auth: update.authMode === null ? 'login' : 'unknown',
          detail: 'Account changed. Checking sign-in…',
          version: null,
        };
        void detectConnection(update.snapshot.provider, connection.id)
          .then((status) => {
            const latest = accountUsageRevision(connection.id);
            if (scope !== workspaceStorageScope() || latest?.epoch !== update.epoch || latest.accountChanged !== update.accountChanged)
              return;
            connectionStatuses[connection.id] = status;
            refreshUsageConnection(connection.id);
            if (selectedSettings.connectionId === connection.id) void refreshModels();
          })
          .catch(() => {});
      } else refreshUsageConnection(update.connectionId);
    }
  }
  async function refreshAccountUsage(force = false) {
    await Promise.all(accountUsageTargets.map((settings) => refreshUsage(settings, force)));
  }
  // `chosen` marks an agent or account the user picked, which new chats then start with.
  function changeSettings(settings: ChatSettings, remember = true, chosen = false) {
    if (!loaded) return;
    // Only the next request's model/reasoning may change while a reply is running.
    if (
      activeRunning &&
      (settings.provider !== selectedSettings.provider ||
        settings.connectionId !== selectedSettings.connectionId ||
        !!settings.planMode !== !!selectedSettings.planMode ||
        settings.outputSchema !== selectedSettings.outputSchema ||
        settings.maxThinkingTokens !== selectedSettings.maxThinkingTokens ||
        settings.fastMode !== selectedSettings.fastMode ||
        settings.fallbackModel !== selectedSettings.fallbackModel ||
        settings.instructions !== selectedSettings.instructions)
    )
      return;
    // The agent stays fixed; its account may change between replies to an offered one.
    if (
      active &&
      (settings.provider !== active.settings.provider ||
        (settings.connectionId !== active.settings.connectionId &&
          !switchableConnections.some((c) => c.id === settings.connectionId)))
    )
      return;
    settingsRevision++;
    if (active) {
      active.settings = settings;
      active.updatedAt = new Date().toISOString();
    } else draftSettings = settings;
    if (remember) rememberSettings(workspace.preferences, settings);
    if (chosen) rememberAgent(workspace.preferences, settings);
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
    changeSettings(
      {
        ...settings,
        instructions: selectedSettings.instructions,
        outputSchema: settings.provider === 'gemini' ? undefined : selectedSettings.outputSchema,
      },
      true,
      true,
    );
  }
  function chooseAgent(value: string) {
    const option = agentOptions.find((option) => option.id === value);
    if (!option) return;
    if (active) {
      // Only another account of the same agent may take over an existing conversation.
      if (
        activeRunning ||
        !option.connectionId ||
        !switchableConnections.some((c) => c.id === option.connectionId)
      )
        return;
      changeSettings({ ...selectedSettings, connectionId: option.connectionId }, true, true);
      return;
    }
    if (!value.startsWith('connection:')) {
      chooseProvider(option.provider);
      return;
    }
    if (!option.connectionId || !canChooseConnection(option.connectionId)) return;
    const settings =
      option.provider === selectedSettings.provider
        ? selectedSettings
        : settingsFor(workspace.preferences, option.provider);
    changeSettings(
      {
        ...settings,
        connectionId: option.connectionId,
        instructions: selectedSettings.instructions,
        outputSchema: settings.provider === 'gemini' ? undefined : selectedSettings.outputSchema,
      },
      true,
      true,
    );
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
    templatesOpen = false;
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
    const connection = workspace.fleet.connections.find((c) => c.id === connectionId);
    if (connection) {
      const environment = workspace.fleet.environments.find(
        (e) => e.id === connection.environmentId,
      );
      draftComputerId = environment ? computerViewId(environment) : '';
      draftLocation =
        workspace.preferences.recentLocations?.find(
          (l) => locationExecutionId(l) === connection.environmentId,
        ) ??
        (environment
          ? { computerId: environment.computerId, environmentId: environment.id, path: '' }
          : undefined);
      draftSettings.connectionId = connection.id;
    } else {
      draftLocation ??= standaloneLocation(draftComputerId);
      if (draftLocation) {
        ensureLocationConnections(workspace.fleet, draftLocation, loginIdentities());
        draftComputerId = locationComputerId(draftLocation);
        draftSettings = settingsAtLocation(draftSettings, draftLocation);
      } else delete draftSettings.connectionId;
    }
    if (draftLocation && !draftLocation.path) {
      const scope = { ...draftLocation };
      ensureLocationConnections(workspace.fleet, scope, loginIdentities());
      saveSoon();
      void saveQueue
        .then(() => refreshConnections(scope, true))
        .catch((e) => {
          notice = String(e);
        });
    }
    activeId = null;
    // Each new chat is a scratch chat of its own; the one left behind stays if it has content.
    scratchId = crypto.randomUUID();
    scratches.push({
      id: scratchId,
      computerId: draftComputerId,
      location: draftLocation && $state.snapshot(draftLocation),
      settings: $state.snapshot(draftSettings),
      createdAt: Date.now(),
      title: '',
      filled: false,
    });
    switchDraft(currentDraftKey());
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
    // Chat from Connections and `/new` name the agent and account to start with.
    if (provider) {
      rememberSettings(workspace.preferences, draftSettings);
      rememberAgent(workspace.preferences, draftSettings);
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
    if (active || activeRunning || selectingLocation || id === selectedComputerId) return;
    const location = standaloneLocation(id);
    folderBrowserOpen = false;
    if (location) {
      void chooseLocation(location, true).catch((e) => (notice = String(e)));
      return;
    }
    locationGeneration++;
    draftComputerId = id;
    draftLocation = undefined;
    draftSettings = { ...draftSettings, connectionId: undefined };
    locationPending = true;
  }
  function standaloneLocation(computerId: string): ChatLocation | undefined {
    const environment = computerViews(workspace.fleet).find((c) => c.id === computerId)?.environments[0];
    return environment
      ? { computerId: environment.computerId, environmentId: environment.id, path: '' }
      : undefined;
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
      outputSchema: provider === 'gemini' ? undefined : settings.outputSchema,
      connectionId: preferredConnection(provider, location),
    };
  }
  async function chooseLocation(location: ChatLocation, verified = false) {
    if (active || activeRunning || selectingLocation) return;
    if (selectedLocation && locationKey(location) === locationKey(selectedLocation)) return;
    const generation = ++locationGeneration;
    const conversationId = activeId;
    selectingLocation = true;
    try {
      if (!verified && location.path) {
        const listing = await listFolders(location.environmentId, location.path);
        location = { ...location, path: listing.path };
      }
      if (generation !== locationGeneration || conversationId !== activeId) return;
      ensureLocationConnections(workspace.fleet, location, loginIdentities());
      const sameComputer = selectedComputerId === locationComputerId(location);
      const settings = sameComputer
        ? { ...selectedSettings }
        : settingsAtLocation(selectedSettings, location);
      draftLocation = { ...location };
      locationPending = false;
      draftComputerId = locationComputerId(location);
      rememberLocation(workspace, location);
      // Automatic computer defaults must not replace the user's remembered account elsewhere.
      changeSettings(settings, sameComputer);
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
        const resolved = sameComputer
          ? selectedSettings
          : settingsAtLocation(selectedSettings, location);
        if (JSON.stringify(resolved) !== JSON.stringify(selectedSettings))
          changeSettings(resolved, sameComputer);
      })().catch((e) => {
        notice = String(e);
      });
    } finally {
      selectingLocation = false;
    }
  }
  // Moves a conversation to History. The open chat gives way to the Active conversation listed
  // below it, else above it (a search match first), or to a new chat when none is left. From the
  // sidebar, the view and the phone drawer stay as they are.
  function archiveConversation(c: Conversation, fromSidebar = false) {
    if (!loaded || c.archived || conversationRunning(c)) return;
    const open = c.id === activeId;
    const unfiltered = () =>
      groupConversations(
        workspace.conversations
          .filter((other) => !other.archived)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        workspace.fleet,
        installation,
      );
    const next = open
      ? (nextActiveConversation(conversationGroups, c.id) ??
        (query ? nextActiveConversation(unfiltered(), c.id) : undefined))
      : undefined;
    c.archived = true;
    c.updatedAt = new Date().toISOString();
    saveSoon();
    if (!open) return;
    const shown = view,
      drawer = sidebarOpen;
    if (next) {
      nearBottom = true;
      openConversation(next);
    } else newChat();
    if (fromSidebar) {
      view = shown;
      sidebarOpen = drawer;
    }
  }
  // The toolbar's Move to history. Its button leaves with the chat, so focus continues in the
  // next chat's composer, or at its actions menu on phones.
  function archiveOpenChat() {
    if (!active) return;
    archiveConversation(active);
    void tick().then(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      if (mobile) document.querySelector<HTMLElement>('.mobile-actions-toggle')?.focus();
      else composerInput?.focus({ preventScroll: true });
    });
  }
  // A sidebar row's Move to history. Keyboard focus moves on to the row now in its place.
  function archiveRow(event: MouseEvent, c: Conversation) {
    const control = event.currentTarget as HTMLElement;
    const rows = () => [
      ...(sidebarElement?.querySelectorAll<HTMLElement>(
        '#conversation-panel-active :is(.conversation-item, .scratch-item)',
      ) ?? []),
    ];
    const index = rows().indexOf(control.previousElementSibling as HTMLElement);
    const focused = document.activeElement === control,
      open = c.id === activeId;
    archiveConversation(c, true);
    if (!focused || !c.archived) return;
    void tick().then(() => {
      const listed = rows();
      const row =
        (open && listed.find((r) => r.getAttribute('aria-current') === 'page')) ||
        listed[index] ||
        listed[index - 1];
      (
        row || sidebarElement?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      )?.focus();
    });
  }
  function openConversation(c: Conversation) {
    templatesOpen = false;
    sidebarOpen = false;
    locationGeneration++;
    folderBrowserOpen = false;
    revealConversation(c);
    locationPending = false;
    activeId = c.id;
    switchDraft(draftKey.chat(c.id));
    editorOpen = false;
    contextOpen = false;
    view = 'chat';
    void scrollToEnd();
  }
  // Returns to a scratch chat with the computer, folder and settings chosen for it.
  function openScratch(scratch: Scratch, focus = true) {
    if (!loaded || selectingLocation) return;
    templatesOpen = false;
    sidebarOpen = false;
    folderBrowserOpen = false;
    editorOpen = false;
    contextOpen = false;
    view = 'chat';
    if (!activeId && scratchId === scratch.id) return;
    locationGeneration++;
    conversationScope = 'active';
    locationPending = false;
    const location = scratchLocation(workspace.fleet, scratch);
    const available = !!location && !!locationExecutionEnvironment(workspace.fleet, location);
    draftLocation = location && { ...location };
    draftComputerId = location ? locationComputerId(location) : scratch.computerId;
    const settings = $state.snapshot(scratch.settings) ?? settingsFor(workspace.preferences);
    if (!location) delete settings.connectionId;
    draftSettings =
      !available ||
      locationConnections(workspace.fleet, location).some((c) => c.id === settings.connectionId)
        ? settings
        : settingsAtLocation(settings, location);
    activeId = null;
    scratchId = scratch.id;
    switchDraft(draftKey.scratch(scratch.id));
    if (focus) void tick().then(() => composerInput?.focus());
    if (!available) return;
    const connections = workspace.fleet.connections.length;
    ensureLocationConnections(workspace.fleet, location, loginIdentities());
    if (workspace.fleet.connections.length !== connections) saveSoon();
    void refreshConnections(location, true).catch((e) => {
      notice = String(e);
    });
  }
  async function forkChat(id: string, messageId?: string) {
    if (!loaded || forking || deleting || imagesLoading) return;
    const source = workspace.conversations.find((c) => c.id === id);
    if (!source) return;
    const session = workspaceSession;
    const selected = activeId;
    const selectedView = view;
    let fork: Conversation | undefined;
    forking = true;
    closeConversationMenu();
    try {
      notice = '';
      fork = forkConversation($state.snapshot(source), messageId);
      workspace.conversations.unshift(fork);
      await persist();
      if (session !== workspaceSession) return;
      query = '';
      revealConversation(fork);
      // Navigation or a blank draft may have changed while saving. Do not
      // replace that selection or move an unrelated draft into the new chat.
      if (
        activeId !== selected || view !== selectedView || imagesLoading ||
        (!activeId && (prompt || attachedImages.length))
      ) {
        notice = `“${fork.title}” was created in Active. Your current draft is unchanged.`;
        return;
      }
      // The source chat keeps its draft for when it is reopened.
      nearBottom = true;
      openConversation(fork);
      await tick();
      composerInput?.focus();
    } catch (error) {
      if (session !== workspaceSession) return;
      if (fork) workspace.conversations = workspace.conversations.filter((c) => c.id !== fork!.id);
      notice = `Could not fork conversation: ${String(error)}`;
    } finally {
      if (session === workspaceSession) forking = false;
    }
  }
  function revealConversation(c: Conversation) {
    conversationScope = c.archived ? 'history' : 'active';
    const location = conversationLocation(c, workspace.fleet, installation);
    // Active lists chats by computer, History by the app session they were last used in.
    const sectionKey = `${conversationScope}/${
      c.archived
        ? historySectionId(c, sessionTimeline(workspace.appSessions))
        : location
          ? locationComputerId(location)
          : 'unassigned'
    }`;
    collapsedGroups[sectionKey] = false;
    collapsedGroups[`${sectionKey}/${location ? locationKey(location) : 'unassigned'}`] = false;
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
  /** `live` marks an update of a running reply, whose activity can fold into less space. */
  async function scrollToEnd(live = false) {
    await tick();
    if (nearBottom && chatScroll) {
      const height = chatColumn?.getBoundingClientRect().height ?? 0;
      if (height >= followedHeight)
        // New content fills any held space before the chat follows it.
        virtualSpace?.trim();
      // Finished calls folded into their groups: space keeps the chat in place until new
      // content fills it, instead of pulling everything down.
      else if (live) virtualSpace?.pad(followedHeight - height);
      // The conversation now ends elsewhere, as when a reply's activity becomes Work history.
      else virtualSpace?.clear();
      chatScroll.scrollTop = chatScroll.scrollHeight;
      followedHeight = height;
    }
  }
  function conversationRunning(conversation: Conversation) {
    return (
      !!runs[conversation.id] || conversation.messages.some((m) => m.status === 'running')
    );
  }
  function closeConversationMenu(restoreFocus = false) {
    const trigger = conversationMenu?.trigger;
    conversationMenu = null;
    if (restoreFocus) void tick().then(() => trigger?.focus({ preventScroll: true }));
  }
  // The actions of a sidebar row: a conversation, or a scratch chat when `scratch` is set.
  function openConversationMenu(event: MouseEvent | KeyboardEvent, id: string, scratch = false) {
    event.preventDefault();
    cancelTouchMenu();
    if ('pointerType' in event && event.pointerType === 'touch') longPressedConversation = id;
    const trigger = event.currentTarget as HTMLButtonElement;
    const bounds = trigger.getBoundingClientRect();
    const pointer = 'clientX' in event && (event.clientX !== 0 || event.clientY !== 0);
    conversationMenu = {
      id,
      ...(scratch ? { scratch } : {}),
      trigger,
      x: pointer ? event.clientX : bounds.left + 12,
      y: pointer ? event.clientY : bounds.bottom,
    };
  }
  function cancelTouchMenu() {
    clearTimeout(touchMenuTimer);
    touchMenuOrigin = undefined;
  }
  function moveTouchMenu(event: PointerEvent) {
    if (
      touchMenuOrigin &&
      Math.hypot(event.clientX - touchMenuOrigin.x, event.clientY - touchMenuOrigin.y) > 8
    )
      cancelTouchMenu();
  }
  function startTouchMenu(event: PointerEvent, id: string, scratch = false) {
    cancelTouchMenu();
    longPressedConversation = undefined;
    if (event.pointerType !== 'touch') return;
    const trigger = event.currentTarget as HTMLButtonElement;
    const x = event.clientX,
      y = event.clientY;
    touchMenuOrigin = { x, y };
    touchMenuTimer = setTimeout(() => {
      touchMenuOrigin = undefined;
      if (!trigger.isConnected || !trigger.getClientRects().length) return;
      longPressedConversation = id;
      conversationMenu = { id, ...(scratch ? { scratch } : {}), trigger, x, y };
    }, 500);
  }
  function requestConversationDeletion() {
    if (!conversationMenu || !menuConversation || deleting) return;
    deletionError = '';
    deletion = {
      type: 'conversation',
      id: menuConversation.id,
      name: menuConversation.title,
      trigger: conversationMenu.trigger,
    };
    closeConversationMenu();
  }
  function requestScratchDiscard() {
    if (!conversationMenu || !menuScratch || deleting) return;
    deletionError = '';
    deletion = {
      type: 'draft',
      id: menuScratch.id,
      name: menuScratch.title,
      trigger: conversationMenu.trigger,
    };
    closeConversationMenu();
  }
  // Discarding the open scratch chat empties it, which also takes it out of the sidebar.
  function discardScratch(id: string) {
    if (activeId || scratchId !== id) {
      dropScratch(draftKey.scratch(id));
      return;
    }
    clearImages();
    applyComposer(undefined);
    keepDraft(composerContent());
  }
  function focusDeletionDialog(node: HTMLElement) {
    const trigger = deletion?.trigger;
    node.querySelector<HTMLButtonElement>('button')?.focus();
    return {
      destroy() {
        void tick().then(() => {
          if (trigger?.isConnected && trigger.getClientRects().length)
            trigger.focus({ preventScroll: true });
          else if (mobile && sidebarOpen)
            sidebarElement
              ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
              ?.focus();
          else composerInput?.focus();
        });
      },
    };
  }
  async function remove() {
    if (deletion?.type === 'draft' && !deleting) {
      discardScratch(deletion.id);
      deletion = null;
      return;
    }
    if (!deletion || !deletingConversation || deleting) return;
    const session = workspaceSession;
    const target = deletingConversation;
    const ownedRun = runs[target.id];
    const reply = target.messages.find((m) => m.status === 'running');
    const runId = ownedRun ?? reply?.runId;
    deleting = true;
    deletionError = '';
    try {
      if (ownedRun) stopping[target.id] = true;
      if (runId)
        await cancelRun(runId, reply?.settings?.connectionId ?? target.settings.connectionId, true);
      if (session !== workspaceSession) return;
      delete queued[target.id];
      await releaseConversation(target.id, target.settings.connectionId).catch(() => {});
      if (session !== workspaceSession) return;
      await cancelTitle(target.id).catch(() => {});
      if (session !== workspaceSession) return;
      workspace.conversations = workspace.conversations.filter((c) => c.id !== target.id);
      await persist();
      if (session !== workspaceSession) return;
      // Its unsent draft is deleted with the conversation.
      forgetDraft(draftKey.chat(target.id));
      if (activeId === target.id) {
        composerDraftKey = '';
        newChat();
      }
      deletion = null;
    } catch (e) {
      if (session !== workspaceSession) return;
      if (!workspace.conversations.some((c) => c.id === target.id))
        workspace.conversations.unshift(target);
      deletionError = `Could not delete this conversation: ${String(e)}`;
      if (ownedRun && runs[target.id] === ownedRun) delete stopping[target.id];
    } finally {
      if (session === workspaceSession) deleting = false;
    }
  }
  function clearImages() {
    imageDragDepth = 0;
    attachmentGeneration++;
    attachedImages = [];
    attachmentError = '';
    imagesLoading = false;
  }
  function currentDraftKey() {
    if (activeId) return draftKey.chat(activeId);
    return scratchId ? draftKey.scratch(scratchId) : '';
  }
  function composerContent(): DraftContent {
    return {
      text: prompt,
      images: $state.snapshot(attachedImages),
      mentions: $state.snapshot(draftMentions),
      staleMentions: $state.snapshot(staleMentionTokens),
      mentionScope: mentionSelection,
    };
  }
  function applyComposer(draft?: DraftContent) {
    prompt = draft?.text ?? '';
    attachedImages = [...(draft?.images ?? [])];
    draftMentions = draft?.mentions.map((m) => ({ ...m })) ?? [];
    staleMentionTokens = [...(draft?.staleMentions ?? [])];
    // Restored mentions stay selected only while their chat, account, and folder still match.
    if (draft?.mentions.length) mentionSelection = draft.mentionScope;
  }
  function keepDraft(content: DraftContent) {
    const key = composerDraftKey;
    if (!key) return;
    const previous = drafts.get(key);
    if (!hasDraft(content)) {
      if (previous) forgetDraft(key);
    } else if (!previous || !sameDraft(previous, content)) {
      drafts.set(key, { ...content, updatedAt: Date.now() });
      draftChanged(key);
    }
    // A scratch chat is listed in the sidebar by its first line while it has content.
    const scratch = scratchFor(key);
    if (!scratch) return;
    const title = scratchTitle(content),
      filled = hasDraft(content);
    if (scratch.title !== title) scratch.title = title;
    if (scratch.filled !== filled) scratch.filled = filled;
  }
  function forgetDraft(key: string) {
    if (drafts.delete(key)) draftChanged(key);
  }
  function draftChanged(key: string) {
    changedDrafts.set(key, Date.now());
    // Save a few times a second even while typing continues, so closing loses little.
    if (draftsReady) draftTimer ??= setTimeout(() => void saveDraftsNow(), 300);
  }
  function scratchFor(key: string) {
    const id = scratchIdOf(key);
    return id === undefined ? undefined : scratches.find((s) => s.id === id);
  }
  // A saved scratch chat is saved again when its computer, folder or settings change.
  function placeScratch(id: string, place: Omit<SavedScratch, 'createdAt'>) {
    const scratch = scratches.find((s) => s.id === id);
    if (
      !scratch ||
      (scratch.computerId === place.computerId &&
        JSON.stringify(scratch.location) === JSON.stringify(place.location) &&
        JSON.stringify(scratch.settings) === JSON.stringify(place.settings))
    )
      return;
    scratch.computerId = place.computerId;
    scratch.location = place.location;
    scratch.settings = place.settings;
    const key = draftKey.scratch(id);
    const draft = drafts.get(key);
    if (!draft) return;
    draft.updatedAt = Date.now();
    draftChanged(key);
  }
  // What a scratch chat's saved draft records besides its text.
  function scratchPlace(key: string): SavedScratch | undefined {
    const scratch = scratchFor(key);
    if (!scratch) return;
    const { computerId, location, settings, createdAt } = $state.snapshot(scratch);
    return {
      computerId,
      ...(location ? { location } : {}),
      ...(settings ? { settings } : {}),
      createdAt,
    };
  }
  // A new session continues the scratch chat edited last, until another chat opens or text is
  // typed. The view stays, so a workspace loaded from Connections does not leave it.
  function continueScratch() {
    let latest: Scratch | undefined;
    let at = -1;
    for (const scratch of scratches) {
      const updatedAt = drafts.get(draftKey.scratch(scratch.id))?.updatedAt ?? -1;
      if (updatedAt > at) {
        latest = scratch;
        at = updatedAt;
      }
    }
    if (!latest || activeId || hasDraft(composerContent())) return false;
    const shown = view;
    openScratch(latest, false);
    view = shown;
    return true;
  }
  // Removes a scratch chat that was sent or discarded or, when `left`, one left without content.
  function dropScratch(key: string, left = false) {
    const id = scratchIdOf(key);
    if (id === undefined || (left && hasDraft(drafts.get(key)))) return;
    forgetDraft(key);
    const index = scratches.findIndex((s) => s.id === id);
    if (index >= 0) scratches.splice(index, 1);
  }
  // Opening another chat or scratch chat keeps the current draft for its return.
  function switchDraft(key: string) {
    keepDraft(composerContent());
    const left = composerDraftKey;
    composerDraftKey = key;
    if (left !== key) dropScratch(left, true);
    clearImages();
    applyComposer(drafts.get(key));
  }
  // `/new` moves the rest of the command into the new scratch chat.
  function carryDraft(from: string, carried: DraftContent) {
    forgetDraft(from);
    dropScratch(from);
    applyComposer(carried);
    keepDraft(carried);
  }
  function resetDrafts() {
    clearTimeout(draftTimer);
    draftTimer = undefined;
    drafts.clear();
    changedDrafts.clear();
    composerDraftKey = '';
    draftsReady = false;
    draftSaveFailed = false;
    scratches = [];
    scratchId = '';
  }
  async function loadSavedDrafts() {
    const session = workspaceSession;
    const scope = workspaceStorageScope();
    if (!scope) return;
    let saved = new Map<string, SavedDraft>();
    try {
      saved = readSavedDrafts(await loadDrafts(scope));
    } catch (error) {
      notice = `Saved drafts could not be read on this device. ${String(error).replace(/^Error: /, '')}`;
    }
    if (session !== workspaceSession || scope !== workspaceStorageScope()) return;
    for (const [key, draft] of saved) {
      if (key.startsWith('chat:')) {
        if (!drafts.has(key)) drafts.set(key, restoredDraft(draft));
        continue;
      }
      const scratch = savedScratch(draft);
      if (!scratch || scratches.some((s) => s.id === scratch.id)) continue;
      const next = draftKey.scratch(scratch.id);
      // An earlier release's new-chat draft for a folder or computer becomes a scratch chat.
      if (next !== key) {
        draftChanged(key);
        draftChanged(next);
      }
      drafts.set(next, restoredDraft(draft));
      scratches.push({
        ...scratch,
        title: scratchTitle({ text: draft.text, images: [] }),
        filled: true,
      });
    }
    draftsReady = true;
    if (loaded) continueScratch();
    if (changedDrafts.size) void saveDraftsNow();
  }
  function saveDraftsNow(): Promise<void> {
    clearTimeout(draftTimer);
    draftTimer = undefined;
    if (!draftsReady || !changedDrafts.size) return draftSaves;
    const changes = new Map<string, DraftChange>();
    for (const [key, at] of changedDrafts) {
      const draft = savedDraft(key, drafts.get(key), scratchPlace(key));
      changes.set(key, draft ? { at: draft.updatedAt, draft } : { at });
    }
    changedDrafts.clear();
    const session = workspaceSession;
    const scope = workspaceStorageScope();
    draftSaves = draftSaves
      .catch(() => {})
      .then(async () => {
        if (session !== workspaceSession) return;
        let saved: Map<string, SavedDraft>;
        try {
          saved = readSavedDrafts(await loadDrafts(scope));
        } catch {
          // Without a readable saved copy, this window's drafts are the best copy to keep.
          saved = new Map(
            [...drafts].flatMap(([key, draft]) => {
              const value = savedDraft(key, draft, scratchPlace(key));
              return value ? [[key, value] as const] : [];
            }),
          );
        }
        await saveDrafts(mergeSavedDrafts(saved, changes), scope);
      })
      .then(
        () => {
          draftSaveFailed = false;
        },
        (error) => {
          if (session !== workspaceSession) return;
          for (const [key, change] of changes)
            if (!changedDrafts.has(key)) changedDrafts.set(key, change.at);
          if (!draftSaveFailed)
            notice = `Unsent drafts could not be saved on this device. ${String(error).replace(/^Error: /, '')}`;
          draftSaveFailed = true;
        },
      );
    return draftSaves;
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
      attachmentError = `Attach up to ${maxImagesPerMessage} images per message. Remove an image before adding more.`;
      return;
    }
    const generation = attachmentGeneration;
    imagesLoading = true;
    try {
      const images = await Promise.all(files.map(readImage));
      if (generation !== attachmentGeneration) return;
      attachedImages = [...attachedImages, ...images];
    } catch (error) {
      if (generation === attachmentGeneration) attachmentError = (error as Error).message;
    } finally {
      if (generation === attachmentGeneration) {
        imagesLoading = false;
        followNotification();
      }
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
  function returnQueuedToDraft(id: string, only?: string) {
    const items = queued[id] ?? [];
    const returning = only ? items.filter((m) => m.id === only) : items;
    if (!returning.length) return;
    const remaining = only ? items.filter((m) => m.id !== only) : [];
    if (remaining.length) queued[id] = remaining;
    else delete queued[id];
    if (activeId !== id) return;
    const restored = restoreToDraft(returning, prompt, attachedImages, maxImagesPerMessage);
    prompt = restored.draft;
    for (const item of returning) restoreDraftMentions(item);
    attachedImages = restored.images;
    attachmentError = restored.droppedImages
      ? `${restored.droppedImages} queued image${restored.droppedImages === 1 ? ' was' : 's were'} dropped: up to ${maxImagesPerMessage} images per message.`
      : '';
    void tick().then(() => composerInput?.focus());
  }
  function restoreDraftMentions(item: QueuedMessage) {
    if (item.mentionConnectionId !== selectedSettings.connectionId)
      staleMentionTokens = [...staleMentionTokens, ...(item.mentions ?? []).map((m) => m.token)];
    else draftMentions = [...draftMentions, ...(item.mentions ?? []).map((m) => ({ ...m }))];
  }
  // Send the next queued message once the running reply completes. A stopped or failed
  // reply returns queued messages to the composer instead of sending into a broken state.
  $effect(() => {
    const id = activeId;
    const items = id ? queued[id] : undefined;
    const busy = activeRunning || activeStopping || activeSteering;
    if (!id || !items?.length || busy) return;
    const last = active?.messages.at(-1);
    const ready = last?.role === 'assistant' && last.status === 'complete';
    const failed =
      !last || last.role !== 'assistant' || ['cancelled', 'error'].includes(last.status);
    const sendable = canSend;
    untrack(() => {
      if (ready && sendable) {
        const [next, ...rest] = items;
        if (rest.length) queued[id] = rest;
        else delete queued[id];
        void send(false, next);
      } else if (failed) returnQueuedToDraft(id);
    });
  });
  // Conversations that are not open send their next queued message once their reply completes.
  // Anything else keeps the queue until the conversation is opened: a stopped or failed reply
  // returns it to the draft there, and the composer explains changed mentions.
  $effect(() => {
    const open = activeId;
    const ready = Object.keys(queued).filter((id) => {
      if (id === open) return false;
      const conversation = workspace.conversations.find((c) => c.id === id);
      const next = queued[id]?.[0];
      const last = conversation?.messages.at(-1);
      return (
        !!conversation &&
        !!next &&
        last?.role === 'assistant' &&
        last.status === 'complete' &&
        (!next.mentions?.length ||
          next.mentionConnectionId === conversation.settings.connectionId) &&
        canSendQueued(conversation)
      );
    });
    if (ready.length) untrack(() => ready.forEach(sendQueued));
  });
  // The composer's checks for a saved conversation, without the composer's own state.
  function canSendQueued(conversation: Conversation) {
    const { settings, location } = conversation;
    const target = replyConnection(settings);
    return (
      loaded &&
      !conversationRunning(conversation) &&
      !stopping[conversation.id] &&
      (!location ||
        !!settings.connectionId ||
        executionHost(workspace.fleet, location.environmentId) === installation?.id) &&
      (!location?.path ||
        locationConnections(workspace.fleet, location).some(
          (c) => c.id === settings.connectionId,
        )) &&
      (desktop() || paired) &&
      (desktop() || online) &&
      (!target.remote || (paired && !syncError)) &&
      !!target.status?.installed &&
      target.status.auth === 'ready'
    );
  }
  function sendQueued(id: string) {
    const conversation = workspace.conversations.find((c) => c.id === id);
    const [next, ...rest] = queued[id] ?? [];
    if (!conversation || !next) return;
    if (rest.length) queued[id] = rest;
    else delete queued[id];
    const now = new Date().toISOString();
    if (conversation.archived) conversation.archived = false;
    delete conversation.rewind;
    addUserMessage(conversation, next, now);
    const { provider, model } = conversation.settings;
    const catalog = modelCache.get(modelScopeKey(conversation.settings))?.catalog ?? fallbackModels;
    void startReply(conversation, {
      now,
      modelName: selectedModelName(model, modelChoices(catalog, provider, model)),
    });
  }
  async function steer() {
    if (!canSteer || !observedReply?.runId) return;
    const reply = observedReply,
      runId = reply.runId!,
      draft = prompt,
      selected = activeId,
      session = workspaceSession;
    const text = draft.trim();
    if (steeringAttempt?.runId !== runId || steeringAttempt.text !== text)
      steeringAttempt = { runId, text, id: crypto.randomUUID() };
    const input = { id: steeringAttempt.id, text };
    steeringPending[runId] = true;
    attachmentError = '';
    try {
      await steerRun(runId, input, reply.settings?.connectionId);
      if (session !== workspaceSession) return;
      if (activeId === selected && prompt === draft) prompt = '';
      steeringAttempt = undefined;
      saveSoon();
    } catch (error) {
      if (session === workspaceSession && activeId === selected) attachmentError = String(error);
    } finally {
      delete steeringPending[runId];
    }
  }
  async function send(retry = false, queuedMessage?: QueuedMessage, compactRequest?: string) {
    if (activeSteering) return;
    if (preparingCommand) return;
    if (queuedMessage?.mentions?.length && queuedMessage.mentionConnectionId !== selectedSettings.connectionId) {
      const restored = restoreToDraft([queuedMessage], prompt, attachedImages, maxImagesPerMessage);
      prompt = restored.draft;
      attachedImages = restored.images;
      restoreDraftMentions(queuedMessage);
      attachmentError = 'The account changed. Choose the queued mentions again before sending.';
      return;
    }
    const session = workspaceSession;
    let command: Awaited<ReturnType<ComposerCommands['submission']>>;
    if (!retry && !queuedMessage && !compactRequest) {
      const draft = prompt,
        selected = activeId;
      preparingCommand = true;
      try {
        command = await composerCommands?.submission();
      } finally {
        if (session === workspaceSession) preparingCommand = false;
      }
      if (session !== workspaceSession) return;
      if (!command || command.handled || prompt !== draft || activeId !== selected) return;
    }
    const compact = !!compactRequest || !!command?.compact || (retry && !!active?.messages.at(-1)?.compact);
    if (compact && (!canCompact || (!compactRequest && attachedImages.length))) {
      notice = 'Compact an idle conversation with its current account and no attachments. Send a message first after switching accounts or rewinding.';
      return;
    }
    const text = compactRequest ?? (queuedMessage ? queuedMessage.text : prompt.trim());
    const images = compactRequest ? [] : queuedMessage ? queuedMessage.images : attachedImages;
    const skills = queuedMessage ? queuedMessage.skills : command?.skills;
    const mentions = queuedMessage ? queuedMessage.mentions : command?.mentions;
    if (!retry && !queuedMessage && activeId && activeRunning) {
      // The reply is still running: hold this message and send it once the reply completes.
      if (!canQueue) return;
      const next = enqueueMessage(activeQueue, {
        text,
        images: structuredClone($state.snapshot(attachedImages)),
        skills,
        mentions,
        mentionConnectionId: selectedSettings.connectionId,
      });
      if (next.error) {
        attachmentError = next.error;
        return;
      }
      queued[activeId] = next.queue;
      prompt = '';
      clearImages();
      void tick().then(() => composerInput?.focus());
      return;
    }
    if (!canSend || (!retry && !text && !images.length)) return;
    nearBottom = true;
    const now = new Date().toISOString();
    const isNewConversation = !active;
    const sentDraft = composerDraftKey;
    if (!active) {
      const c: Conversation = {
        id: crypto.randomUUID(),
        settings: structuredClone($state.snapshot(selectedSettings)),
        location: selectedLocation ? { ...selectedLocation } : undefined,
        title: text.slice(0, 80) || 'Image conversation',
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
    // Any submission, including a retry, ends the chance to undo a rewind.
    delete conversation.rewind;
    if (retry && conversation.messages.at(-1)?.role === 'assistant') {
      if (conversation.messages.at(-1)?.steering?.length) {
        // Preserve the steered attempt and its accepted inputs for portable history.
        conversation.messages.push({
          id: crypto.randomUUID(),
          role: 'user',
          status: 'complete',
          createdAt: now,
          blocks: [
            {
              type: 'markdown',
              text: 'Continue the previous request, including my steering. Check existing results before repeating any work.',
            },
          ],
        });
      } else conversation.messages.pop();
    }
    if (!retry) {
      addUserMessage(conversation, { text, images, skills, mentions }, now);
      if (!queuedMessage && !compactRequest) {
        prompt = '';
        clearImages();
        forgetDraft(sentDraft);
      }
    }
    // The scratch chat is now this conversation, whose composer continues as its draft.
    if (isNewConversation) {
      composerDraftKey = draftKey.chat(conversation.id);
      dropScratch(sentDraft);
    }
    await startReply(conversation, {
      now,
      modelName: selectedModelName(conversation.settings.model, availableModels),
      compact,
      created: isNewConversation,
      remember: true,
    });
  }
  function addUserMessage(
    conversation: Conversation,
    input: Pick<QueuedMessage, 'text' | 'images' | 'skills' | 'mentions'>,
    now: string,
  ) {
    conversation.messages.push({
      id: crypto.randomUUID(),
      role: 'user',
      ...(input.skills?.length ? { skills: input.skills } : {}),
      ...(input.mentions?.length ? { mentions: input.mentions } : {}),
      blocks: [
        {
          type: 'markdown',
          text: input.text,
        },
      ],
      ...(input.images.length ? { images: structuredClone($state.snapshot(input.images)) } : {}),
      status: 'complete',
      createdAt: now,
    });
  }
  // Answer the conversation's latest messages and follow the reply until it ends. A reply sent
  // from the queue of a conversation that is not open leaves remembered choices unchanged.
  async function startReply(
    conversation: Conversation,
    options: {
      now: string;
      modelName: string;
      compact?: boolean;
      created?: boolean;
      remember?: boolean;
    },
  ) {
    const { now, compact } = options;
    const session = workspaceSession;
    const history = historyFor(conversation);
    const assistantId = crypto.randomUUID();
    const responseSettings = structuredClone($state.snapshot(conversation.settings));
    const runId = crypto.randomUUID();
    // Legacy host bindings cannot tell an account switch from a moved chat by themselves.
    const accountSwitch =
      !!responseSettings.connectionId &&
      conversation.messages.some(
        (m) =>
          m.role === 'assistant' &&
          !!m.settings?.connectionId &&
          m.settings.connectionId !== responseSettings.connectionId,
      );
    if (options.remember) rememberSettings(workspace.preferences, responseSettings);
    conversation.messages.push({
      id: assistantId,
      role: 'assistant',
      settings: responseSettings,
      modelName: options.modelName,
      executionLabel: responseSettings.connectionId
        ? connectionLabel(workspace.fleet, responseSettings.connectionId)
        : `${statusFor(responseSettings.provider)?.location ?? 'This computer'} · CLI login`,
      runId,
      ...(compact ? { compact: true } : {}),
      promptTokensEstimate: estimatePromptTokens(responseSettings, history),
      blocks: [],
      status: 'running',
      createdAt: now,
    });
    conversation.updatedAt = now;
    const message = () => conversation.messages.find((m) => m.id === assistantId)!;
    runs[conversation.id] = runId;
    const started = performance.now();
    let reasoningSavedAt = 0;
    try {
      await persist();
      if (session !== workspaceSession) return;
      if (options.created)
        void nameConversation(
          conversation.id,
          responseSettings.provider,
          history[0].text || 'A conversation about attached images',
          conversation.title,
          responseSettings.connectionId,
        );
      const instructions =
        responseSettings.provider === 'claude' ? claudeInstructions(workspace) : '';
      const result = stopping[conversation.id]
        ? 'cancelled'
        : await runAgent(
            {
              runId,
              ...(compact ? { compact: true } : {}),
              agent: responseSettings,
              ...(instructions.trim() ? { claudeInstructions: instructions } : {}),
              messages: history,
              conversationId: conversation.id,
              historyRevision: conversation.historyRevision,
              assistantId,
              location: conversation.location?.path ? { ...conversation.location } : undefined,
              ...(accountSwitch ? { accountSwitch: true } : {}),
              ...(conversation.forked ? { forked: true } : {}),
            },
            (event) => {
              if (session !== workspaceSession) return;
              if (stopping[conversation.id]) void cancelRun(runId).catch(() => {});
              const m = message();
              const hadQuestion = requestsAttention(m);
              applyRunEvent(m, event);
              localChanges++;
              if (
                event.kind === 'nativeworkflow' ||
                event.kind === 'plan' ||
                event.kind === 'proposedplan' ||
                event.kind === 'visualization' ||
                event.kind === 'filechanges' ||
                event.kind === 'question' ||
                event.kind === 'elicitation' ||
                event.kind === 'steering' ||
                event.kind === 'compaction' ||
                (event.kind === 'reasoning' &&
                  Date.now() - reasoningSavedAt >= streamSaveInterval()) ||
                (event.kind === 'tool' && !hadQuestion && requestsAttention(m))
              ) {
                if (event.kind === 'reasoning') reasoningSavedAt = Date.now();
                saveSoon(conversation.id);
              }
              if (activeId === conversation.id) void scrollToEnd(true);
            },
          );
      if (session !== workspaceSession) return;
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
      if (session !== workspaceSession) return;
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
      } else if (String(e).includes('Gemini connection could not be verified')) {
        const s = responseSettings.connectionId
          ? connectionStatuses[responseSettings.connectionId]
          : statusFor(responseSettings.provider);
        if (s) s.auth = 'unknown';
      }
    } finally {
      if (session === workspaceSession) {
        message().durationMs = message().accountUsage?.runDurationMs ?? performance.now() - started;
        conversation.updatedAt = new Date().toISOString();
        if (runs[conversation.id] === runId) {
          delete runs[conversation.id];
          delete stopping[conversation.id];
        }
        saveSoon(conversation.id);
        if (activeId === conversation.id) void scrollToEnd();
        void refreshUsage(responseSettings, true);
      }
    }
  }
  async function nameConversation(
    id: string,
    provider: ProviderId,
    firstMessage: string,
    fallback: string,
    connectionId?: string,
  ) {
    const session = workspaceSession;
    try {
      let result: Awaited<ReturnType<typeof generateTitle>> | undefined;
      for (let attempt = 1; ; attempt++) {
        try {
          result = await generateTitle(id, provider, firstMessage, connectionId);
          break;
        } catch (error) {
          // A computer names two new chats at a time; chats started together wait their turn.
          if (attempt >= 40 || !String(error).includes('Title generation is already busy'))
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
        if (
          session !== workspaceSession ||
          workspace.conversations.find((c) => c.id === id)?.titleStatus !== 'pending'
        )
          return;
      }
      if (session !== workspaceSession) return;
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
      saveSoon(conversation.id);
      void refreshUsage(conversation.settings, true);
    } catch {
      if (session !== workspaceSession) return;
      const conversation = workspace.conversations.find((c) => c.id === id);
      if (conversation?.titleStatus === 'pending') {
        conversation.titleStatus = 'fallback';
        saveSoon(conversation.id);
      }
    }
  }
  async function stop() {
    const conversationId = activeId;
    const ownedRun = conversationId ? runs[conversationId] : undefined;
    const id = ownedRun ?? observedReply?.runId;
    if (!conversationId || !id || stopping[conversationId]) return;
    if (!ownedRun) {
      try {
        await cancelRun(id, observedReply?.settings?.connectionId);
      } catch (e) {
        notice = String(e);
      }
      return;
    }
    stopping[conversationId] = true;
    try {
      await cancelRun(id, observedReply?.settings?.connectionId);
    } catch (e) {
      notice = String(e);
      if (runs[conversationId] === ownedRun) delete stopping[conversationId];
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
      const modal = document.querySelector(
        deletion ? '[role="alertdialog"]' : '[aria-modal="true"]',
      );
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
      if (!deleting) deletion = null;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      if (!deletion) newChat();
    }
  }
</script>

<svelte:head
  ><title>{desktop() ? 'Agent Studio' : 'Agent Studio Viewer'}</title><meta
    name="description"
    content="Your AI agents, together in one local workspace."
  /></svelte:head
>
<svelte:window
  bind:innerWidth={viewportWidth}
  onkeydown={(event) => {
    if (!desktop() && !paired) return;
    // Native modal dialogs own their keyboard navigation, including inside the drawer.
    if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
    if (mobile && sidebarOpen && !deletion) {
      if (event.key === 'Escape') {
        event.preventDefault();
        void toggleSidebar(false);
        return;
      }
      if (event.key === 'Tab') {
        const elements = [
          ...(sidebarElement?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input, [tabindex="0"]',
          ) ?? []),
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

{#if !desktop() && !paired}
  <WorkspaceLogin
    checking={(!loaded || relayRestorePending) && !storageError && !syncError}
    ready={loaded}
    {online}
    error={storageError || syncError}
    retry={() => {
      if (storageError) window.location.reload();
      else void restoreRelayConnection();
    }}
    login={(key) => pair(window.location.origin, key)}
  />
{:else}
<div
  class="app-shell"
  class:drawer-dragging={drawerDrag !== undefined}
  class:drawer-settling={drawerSettling}
  style:--sidebar-width={sidebarWidth ? `${sidebarWidth}px` : undefined}
  style:--drawer-progress={drawerDrag}
>
  {#if mobile}<button
      class="sidebar-backdrop"
      class:mobile-open={sidebarOpen}
      aria-label="Close conversation menu"
      inert={!sidebarOpen}
      onclick={() => toggleSidebar(false)}
    ></button>{/if}
  <aside
    class="sidebar"
    class:mobile-open={mobile && sidebarOpen}
    id="conversation-sidebar"
    bind:this={sidebarElement}
    inert={mobile && (!sidebarOpen || !!deletion)}
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
      <BrandMark />
      <span>agent<span class="brand-light">studio</span></span>
      {#if !desktop()}<span class="viewer-label">Viewer</span>{/if}
    </button>
    <div class="sidebar-section">
      <span class="sidebar-section-label"
        >Conversations
        <span role="status" aria-live="polite" aria-label={`${pendingChats} pending chats`}>
          {#if pendingChats > 0}<span
              class="pending-chat-count"
              title="Pending chats: active conversations that are not working">{pendingChats}</span
            >{/if}
        </span>
      </span><button
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
          {#each group.sections as section}
            {@const sectionKey = `${group.id}/${section.id}`}
            <div
              class={section.kind === 'computer' ? 'conversation-computer' : 'conversation-session'}
              aria-label={section.kind === 'computer'
                ? `${section.name} ${group.name.toLowerCase()} chats`
                : section.detail}
            >
              {#if section.kind === 'computer'}<div class="computer-group-row">
                  <button
                    class="computer-group-toggle"
                    title={section.name}
                    aria-expanded={!collapsedGroups[sectionKey]}
                    onclick={() => (collapsedGroups[sectionKey] = !collapsedGroups[sectionKey])}
                    ><Laptop size={13} /><span>{section.name}</span
                    >{#if !computerOnline(section.id)}<small class="computer-offline">Offline</small
                      >{/if}<ChevronRight
                      size={12}
                      class={!collapsedGroups[sectionKey] ? 'expanded-chevron' : ''}
                    /></button
                  >
                  <button
                    class="computer-new-chat"
                    title={`New conversation on ${section.name}`}
                    aria-label={`New conversation on ${section.name}`}
                    disabled={!loaded ||
                      selectingLocation ||
                      !computers.some((c) => c.id === section.id)}
                    onclick={() => newChat(undefined, undefined, undefined, section.id)}
                    ><Plus size={14} /></button
                  >
                </div>
              {:else}<div class="session-group-row">
                  <button
                    class="session-group-toggle"
                    title={section.detail}
                    aria-expanded={!collapsedGroups[sectionKey]}
                    onclick={() => (collapsedGroups[sectionKey] = !collapsedGroups[sectionKey])}
                    >{#if section.kind === 'session'}<RotateCcwClock
                        size={13}
                        aria-hidden="true"
                      />{:else}<CalendarDays size={13} aria-hidden="true" />{/if}<span
                      >{section.name}</span
                    ><ChevronRight
                      size={12}
                      class={!collapsedGroups[sectionKey] ? 'expanded-chevron' : ''}
                    /></button
                  >
                </div>{/if}
              {#if !collapsedGroups[sectionKey]}{#each section.folders as folder}
                  {@const folderKey = `${sectionKey}/${folder.id}`}
                  <div class="conversation-folder" aria-label={folder.detail}>
                    <div class="folder-group-row">
                      <button
                        class="folder-group-toggle"
                        title={folder.detail}
                        aria-expanded={!collapsedGroups[folderKey]}
                        onclick={() => (collapsedGroups[folderKey] = !collapsedGroups[folderKey])}
                        >{#if folder.location?.path}<Folder size={14} />{:else}<MessageCircle
                            size={14}
                          />{/if}<span>{folder.name}</span
                        >{#if section.kind !== 'computer' && section.computers > 1}<small
                            class="folder-computer">{folder.computerName}</small
                          >{/if}<ChevronRight
                          size={12}
                          class={!collapsedGroups[folderKey] ? 'expanded-chevron' : ''}
                        /></button
                      >
                      <button
                        class="folder-new-chat"
                        title={folder.location?.path
                          ? `New conversation in ${folder.name}`
                          : 'New standalone conversation'}
                        aria-label={folder.location?.path
                          ? `New conversation in ${folder.name} on ${folder.computerName}`
                          : `New standalone conversation on ${folder.computerName}`}
                        disabled={!loaded || selectingLocation || !folder.location}
                        onclick={() => newChat(undefined, undefined, folder.location)}
                        ><Plus size={14} /></button
                      >
                    </div>
                    {#if !collapsedGroups[folderKey]}<div class="folder-conversations">
                        {#each folder.scratches as s (s.id)}{@const current =
                            !activeId && scratchId === s.id && view === 'chat'}<button
                            class="scratch-item"
                            class:current
                            aria-current={current ? 'page' : undefined}
                            aria-haspopup="menu"
                            aria-label={`Unsent draft: ${s.title}`}
                            oncontextmenu={(event) => openConversationMenu(event, s.id, true)}
                            onkeydown={(event) => {
                              if (
                                event.key === 'ContextMenu' ||
                                (event.shiftKey && event.key === 'F10')
                              )
                                openConversationMenu(event, s.id, true);
                            }}
                            onpointerdown={(event) => startTouchMenu(event, s.id, true)}
                            onpointermove={moveTouchMenu}
                            onpointerup={cancelTouchMenu}
                            onpointercancel={cancelTouchMenu}
                            onclick={(event) => {
                              if (longPressedConversation === s.id) {
                                event.preventDefault();
                                longPressedConversation = undefined;
                              } else openScratch(s);
                            }}
                            title={`Unsent draft · ${s.title}`}
                            ><PenLine size={13} aria-hidden="true" /><span>{s.title}</span></button
                          >{/each}
                        {#each folder.conversations as c}{@const runningReply = c.messages.find(
                            (m) => m.status === 'running',
                          )}
                          <div class="conversation-row">
                            <button
                              class="conversation-item"
                              class:current={activeId === c.id && view === 'chat'}
                              aria-current={activeId === c.id && view === 'chat'
                                ? 'page'
                                : undefined}
                              aria-haspopup="menu"
                              oncontextmenu={(event) => openConversationMenu(event, c.id)}
                              onkeydown={(event) => {
                                if (
                                  event.key === 'ContextMenu' ||
                                  (event.shiftKey && event.key === 'F10')
                                )
                                  openConversationMenu(event, c.id);
                              }}
                              onpointerdown={(event) => startTouchMenu(event, c.id)}
                              onpointermove={moveTouchMenu}
                              onpointerup={cancelTouchMenu}
                              onpointercancel={cancelTouchMenu}
                              onclick={(event) => {
                                if (longPressedConversation === c.id) {
                                  event.preventDefault();
                                  longPressedConversation = undefined;
                                } else openConversation(c);
                              }}
                              title={c.title}
                              ><span>{c.title}</span
                              >{#if runningReply && awaitingAnswer(runningReply)}<MessageCircleQuestionMark
                                  size={14}
                                  class="conversation-waiting"
                                  aria-hidden="true"
                                />{:else if runningReply}<LoaderCircle
                                  size={14}
                                  class="spinning conversation-running"
                                  aria-hidden="true"
                                />{/if}</button
                            >{#if !c.archived && !conversationRunning(c)}<button
                                class="conversation-archive"
                                title="Move to history"
                                aria-label={`Move ${c.title} to history`}
                                onclick={(event) => archiveRow(event, c)}
                                ><Archive size={14} aria-hidden="true" /></button
                              >{/if}
                          </div>{/each}
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
      {#if appUpdate?.phase === 'ready' || appUpdate?.phase === 'installing'}<button
          class="update-button"
          disabled={restartingForUpdate || !!restartBlocked(appUpdate)}
          title={restartBlocked(appUpdate) ??
            `Version ${appUpdate.version} is ready. Restart Agent Studio to finish updating.`}
          onclick={restartFromSidebar}
          ><RefreshCw size={14} aria-hidden="true" /><span
            >{restartingForUpdate || appUpdate.phase === 'installing'
              ? 'Restarting…'
              : 'Restart to update'}</span
          ></button
        >{/if}
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
      <button
        class="icon-button settings-button"
        class:active={view === 'settings'}
        aria-label="Settings"
        aria-pressed={view === 'settings'}
        title={view === 'settings' ? 'Back to conversation' : 'Settings'}
        onclick={() => {
          view = view === 'settings' ? 'chat' : 'settings';
          sidebarOpen = false;
        }}><Settings size={17} aria-hidden="true" /></button
      >
      {#if !desktop()}<BrowserStatus showConnection={false} compactInstall />{/if}
    </div>
    <SidebarResize onresize={(width) => (sidebarWidth = width)} />
  </aside>

  <main class="main-area" inert={mobile && sidebarOpen}>
    <WindowTitlebar
      title={viewTitle}
      onerror={(message) => (notice = message)}
      onmenu={() => toggleSidebar(true)}
      beforeclose={saveDraftsNow}
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
        showInstallButton={false}
      />{/if}

    {#if view === 'chat'}
      <div
        class="chat-workspace"
        class:has-artifact-panel={selectedArtifact && artifactMode === 'panel'}
      >
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
                    >PNG, JPEG or WebP · Up to {maxImagesPerMessage} images · {maxImageLabel} each</span
                  >{/if}
              </div>
            </div>
          {/if}
          <div class="chat-toolbar" aria-label="Conversation settings">
            <div class="chat-configuration">
              <div class="chat-setting computer-setting">
                <ChoicePicker
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
                  disabled={!loaded || activeRunning || selectingLocation || !!active}
                  onchange={chooseComputer}
                >
                  {#snippet icon()}<Laptop size={16} />{/snippet}
                </ChoicePicker>
                {#if selectedComputerOffline}<span class="setting-badge">Offline</span>{/if}
              </div>
              <div class="chat-setting folder-setting">
                <ChoicePicker
                  label="Folder"
                  title={selectedLocation
                    ? selectedLocation.path || 'Standalone chat without a project folder'
                    : undefined}
                  value={selectedLocation
                    ? selectedLocation.path
                      ? locationKey(selectedLocation)
                      : 'standalone'
                    : 'browse'}
                  options={[
                    ...(standaloneChoice
                      ? [{
                          id: 'standalone',
                          name: 'Standalone',
                          title: 'Standalone chat without a project folder',
                        }]
                      : []),
                    ...savedLocations.filter((l) => l.path).map((l) => ({
                      id: locationKey(l),
                      name: folderName(l.path),
                      detail:
                        workspace.fleet.environments.find((e) => e.id === l.environmentId)?.name ??
                        'Environment',
                      title: l.path,
                    })),
                    ...(selectedLocation?.path &&
                    !savedLocations.some((l) => locationKey(l) === locationKey(selectedLocation))
                      ? [
                          {
                            id: locationKey(selectedLocation),
                            name: selectedLocation.path
                              ? folderName(selectedLocation.path)
                              : 'Standalone',
                            title:
                              selectedLocation.path || 'Standalone chat without a project folder',
                          },
                        ]
                      : []),
                    { id: 'browse', name: 'Browse folders…' },
                  ]}
                  disabled={!loaded ||
                    !selectedComputer ||
                    activeRunning ||
                    selectingLocation ||
                    !!active}
                  onchange={(id) => {
                    if (active) return;
                    if (id === 'standalone' && standaloneChoice) {
                      void chooseLocation(standaloneChoice, true).catch((e) => (notice = String(e)));
                      return;
                    }
                    const location = savedLocations.find((l) => locationKey(l) === id);
                    if (location) void chooseLocation(location).catch((e) => (notice = String(e)));
                    else folderBrowserOpen = true;
                  }}
                >
                  {#snippet icon()}
                    {#if selectedLocation && !selectedLocation.path}<MessageCircle
                        size={16}
                      />{:else}<Folder size={16} />{/if}
                  {/snippet}
                </ChoicePicker>
              </div>
              <div class="chat-setting agent-setting">
                <ChoicePicker
                  label="Agent"
                  title={`${
                    active
                      ? switchableConnections.length
                        ? 'The agent, computer, and folder are fixed for this conversation. Choosing another account applies to the next message and starts a new native session for it from the saved messages. '
                        : 'Fixed for this conversation. Start a new conversation to change it, or connect another account of this agent to switch accounts between replies. '
                      : ''
                  }${selectedSettings.planMode ? 'Plan mode: explore and propose changes before implementation. Claude asks for plan-mode approval; Codex returns a proposed plan.' : 'Full access: file access, editing, commands, and configured CLI tools are enabled. Tool calls run without approval prompts, except explicit plan-mode decisions.'}`}
                  value={selectedAgentOption}
                  options={agentOptions}
                  fallbackToFirst={false}
                  placeholder={agentOptions.length ? 'Select agent' : 'No agents'}
                  disabled={!loaded ||
                    activeRunning ||
                    selectingLocation ||
                    (desktop() && !selectedLocation && !active) ||
                    (!!active && !switchableConnections.length)}
                  onchange={chooseAgent}
                >
                  {#snippet icon()}<Bot size={16} />{/snippet}
                </ChoicePicker>
              </div>
              <div class="chat-setting model-setting">
                <ChoicePicker
                  bind:this={modelPicker}
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
              <div class="chat-setting reasoning-setting">
                <ChoicePicker
                  bind:this={reasoningPicker}
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
            {#key activeId}<ToolbarActions>
              {#if active && !active.archived}<button
                  class="icon-button"
                  disabled={activeRunning}
                  onclick={archiveOpenChat}
                  title="Move to history"
                  aria-label="Move to history"><Archive size={16} /></button
                >{/if}
              {#if active}<button
                  class="icon-button"
                  disabled={forking || imagesLoading || forkPoint(active) < 0}
                  onclick={() => active && void forkChat(active.id)}
                  title="Fork conversation"
                  aria-label="Fork conversation"><GitFork size={16} /></button
                >{/if}
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
              <button
                class="icon-button"
                onclick={() => (editorOpen = true)}
                disabled={!loaded || activeRunning}
                title="Chat instructions"
                aria-label="Chat instructions"><SlidersHorizontal size={16} /></button
              >
            </ToolbarActions>{/key}
          </div>
          {#if nextReplyChanged}
            <p class="next-reply-settings" role="status">
              Next message: {selectedModelName(selectedSettings.model, availableModels)} · {reasoningName(
                selectedSettings.reasoning,
              )} reasoning
            </p>
          {:else if accountSwitchPending}
            <p class="next-reply-settings" role="status">
              Next message: {accountName(workspace.fleet, selectedSettings.connectionId) ??
                'Another'} account · starts a new native session from this chat's saved messages
            </p>
          {/if}
          <div
            class="chat-scroll"
            bind:this={chatScroll}
            onscroll={readingPosition}
          >
            <div
              class="message-column"
              class:empty={!active?.messages.length}
              bind:this={chatColumn}
            >
              {#if active?.messages.length}
                {#each active.messages as m, i (m.id)}<MessageView
                    message={m}
                    background={messageBackgroundWork(m, hostBackground[active.id])}
                    {chatChanges}
                    folder={active.location?.path}
                    timeTotal={timeTotals.get(m.id)}
                    switchNotice={switchNotices.get(m.id)}
                    agent={active.settings}
                    canRetry={i === active.messages.length - 1 &&
                      (m.status === 'error' || m.status === 'cancelled') &&
                      !activeRunning}
                    retry={() => void send(true)}
                    retryDisabled={!canSend}
                    rewind={m.role === 'user' ? () => openRewind(m.id) : undefined}
                    undoEdits={m.runId && m.fileChanges?.edits.length
                      ? () => openUndoFiles(m.runId)
                      : undefined}
                    historyDisabled={activeRunning || historyBusy || !!activeQueue.length}
                    fork={m.role === 'assistant' && m.status !== 'running'
                      ? () => active && void forkChat(active.id, m.id)
                      : undefined}
                    forkDisabled={forking || imagesLoading}
                    {openArtifact}
                  />{/each}
              {:else}<div class="chat-empty">
                  <span
                    class="large-provider"
                    style:--provider-color={providers[selectedAgent.provider].color}
                    >{providers[selectedAgent.provider].mark}</span
                  ><span class="eyebrow"
                    >A conversation with {selectedAgent.name}</span
                  >
                  <h1>What’s on your mind?</h1>
                  <p>Bring a question, an idea, or the thing you can’t quite untangle.</p>
                </div>{/if}
            </div>
            <div class="chat-virtual-space" aria-hidden="true" bind:this={chatSpace}></div>
          </div>
          <div class="composer-area" bind:this={composerArea}>
            {#if active?.rewind}<div class="setup-hint neutral" role="status">
                <Rewind size={15} aria-hidden="true" /><span
                  >Conversation rewound. Send a new message to continue from here.</span
                ><button
                  class="text-button"
                  disabled={historyBusy || activeRunning}
                  onclick={() => void changeHistory().catch((e) => (historyError = String(e)))}
                  >Undo rewind</button
                >
              </div>{/if}
            {#if historyError}<p class="attachment-notice" role="alert">{historyError}</p>{/if}
            {#if selectedComputerOffline}<div class="setup-hint">
                <Laptop size={15} />{selectedComputer?.name} is offline. Open Agent Studio on {selectedComputer?.wsl
                  ? selectedComputer.hostName
                  : selectedComputer?.name} and connect it to sync.
              </div>
            {:else if locationPending || (!selectedLocation && !active)}<div class="setup-hint">
                <Laptop size={15} />{selectedComputer
                  ? 'This computer has no available execution environment.'
                  : 'Choose a computer to select an agent and start chatting.'}
              </div>
            {:else if !selectedStatus && desktop()}<div class="setup-hint">
                {#if selectedRemote}<Laptop size={15} />Computer offline or relay disconnected.
                {:else if selectedSettings.connectionId && !selectedConnection}<Plug
                    size={15}
                  />This CLI connection is no longer available. Choose another connection.
                {:else}<RefreshCw size={15} class="spinning" />Checking this computer’s CLIs…{/if}
              </div>
            {:else if !selectedStatus?.installed && desktop()}<div class="setup-hint">
                <Plug size={15} />{providers[selectedAgent.provider].name} needs to be set up.<button
                  class="text-button"
                  onclick={() => (view = 'connections')}
                  >Open Connections<ArrowRight size={13} /></button
                >
              </div>
            {:else if selectedStatus?.installed && selectedStatus.auth !== 'ready'}<div
                class="setup-hint"
                role="status"
              >
                <Plug size={15} />
                {#if selectedStatus.auth === 'login'}Connect to {providers[selectedAgent.provider]
                    .name} before sending a message.
                {:else}We couldn't verify your {providers[selectedAgent.provider].name} connection. Open
                  Connections to check it before sending.{/if}
                <button class="text-button" onclick={() => (view = 'connections')}
                  >Open Connections<ArrowRight size={13} /></button
                >
              </div>{/if}
            <form
              class="composer"
              aria-label="Message composer"
              onsubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              {#if activeQueue.length}<ul
                  class="queued-messages"
                  role="list"
                  aria-label="Queued messages"
                >
                  {#each activeQueue as item (item.id)}<li class="queued-message" role="listitem">
                      <span class="queued-badge">{activeRunning ? 'After this reply' : 'Queued'}</span>
                      <span class="queued-text" title={item.text}>{queuedPreview(item)}</span>
                      <button
                        type="button"
                        class="queued-remove"
                        aria-label="Return queued message to the composer"
                        title="Return to the composer"
                        onclick={() => {
                          if (activeId) returnQueuedToDraft(activeId, item.id);
                        }}><X size={13} /></button
                      >
                    </li>{/each}
                </ul>{/if}
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
                title="Enter to send · Shift + Enter for a new line · / commands · @ files · $ apps in Codex"
                placeholder={activeRunning
                  ? `Message ${selectedAgent.name} after this reply… Type / for commands`
                  : `Message ${selectedAgent.name}… Type / for commands`}
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
                  if (composerCommands?.keydown(e)) return;
                  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !mobile) {
                    e.preventDefault();
                    void send();
                  }
                }}></textarea>
              <ComposerCommands
                conversationId={active?.id}
                forked={active?.forked}
                bind:this={composerCommands}
                bind:references={draftMentions}
                bind:staleTokens={staleMentionTokens}
                bind:referenceSelection={mentionSelection}
                input={composerInput}
                bind:prompt
                settings={selectedSettings}
                location={selectedLocation?.path ? selectedLocation : undefined}
                available={selectedConnectionAvailable &&
                  !!selectedStatus?.installed &&
                  selectedStatus.auth === 'ready'}
                busy={activeRunning}
                scope={activeId ?? draftKey.scratch(scratchId)}
                oncommand={(name) => {
                  if (name === 'model') void tick().then(() => modelPicker?.showPicker());
                  else if (name === 'reasoning')
                    void tick().then(() => reasoningPicker?.showPicker());
                  else if (name === 'instructions' || name === 'fast') {
                    focusFast = name === 'fast';
                    editorOpen = true;
                  } else if (name.startsWith('fast:') && selectedSettings.provider === 'claude') {
                    changeSettings({
                      ...selectedSettings,
                      fastMode: name === 'fast:default' ? undefined : name === 'fast:on',
                    });
                    notice = name === 'fast:on'
                      ? 'Fast mode requested for the next reply. Supported Opus models use higher per-token pricing and usage credits on subscription plans; account availability applies.'
                      : name === 'fast:off'
                        ? 'Fast mode is off for the next reply.'
                        : 'The next reply will use the Claude CLI profile’s Fast mode default.';
                  } else if (name === 'context') contextOpen = true;
                  else if (name === 'usage') usageExpanded = true;
                  else if (name === 'rewind') openRewind();
                  else if (name === 'undo') openUndoFiles();
                  else if (name === 'connections') view = 'connections';
                  else if (name === 'settings') view = 'settings';
                  else if (name === 'new') {
                    const remaining = composerContent(),
                      from = composerDraftKey;
                    newChat(
                      selectedSettings.provider,
                      selectedSettings.connectionId,
                      selectedLocation,
                      selectedComputerId,
                    );
                    // The rest of the command moves into the new conversation's draft.
                    if (composerDraftKey !== from) carryDraft(from, remaining);
                  }
                }}
              />
              {#if imagesLoading}<p class="attachment-notice" role="status">Reading images…</p>{/if}
              {#if attachmentError}<p class="attachment-notice" role="alert">{attachmentError}</p>
              {:else if attachedImages.length && !imagesSupported}<p
                  class="attachment-notice"
                  role="alert"
                >
                  Choose Codex or Claude to send these images, or remove them to use Gemini.
                </p>{/if}
              <div class="composer-bottom">
                <div class="composer-tools">
                  <PlanModePicker settings={selectedSettings} disabled={!loaded || activeRunning} change={changeSettings} />
                  <button
                    type="button"
                    class="attach-button"
                    aria-label="Attach images"
                    title={imagesSupported
                      ? `Attach images · PNG, JPEG, WebP · ${maxImageLabel} each · up to ${maxImagesPerMessage}`
                      : 'Image attachments are available with Codex and Claude'}
                    disabled={!imagesSupported ||
                      imagesLoading ||
                      attachedImages.length >= maxImagesPerMessage}
                    onclick={() => imageInput?.click()}><Paperclip size={17} /></button
                  >
                  <button
                    type="button"
                    class="template-button"
                    disabled={!loaded}
                    title="Create and fill reusable input templates"
                    onclick={() => (templatesOpen = true)}><FileText size={16} />Templates</button
                  >
                </div>
                {#if activeRunning}
                  {#if steeringSupported}<button type="button" class="steer-button" disabled={!canSteer} onclick={steer}
                    title={attachedImages.length || hasComposerMentions || prompt.trimStart().startsWith('/') ? 'Queue images, mentions, commands, and skills for the next reply' : 'Send text to the active reply'}
                    >{activeSteering ? 'Sending…' : 'Steer now'}</button>{/if}
                  <button
                    class="stop-button"
                    type="button"
                    onclick={stop}
                    disabled={activeStopping}
                    ><CircleStop size={16} />{activeStopping
                      ? 'Stopping…'
                      : 'Stop response'}</button
                  ><button
                    class="send-button"
                    type="submit"
                    disabled={!canQueue || (!prompt.trim() && !attachedImages.length)}
                    aria-label="Queue message"
                    title="Send after the current reply"><ArrowUp size={19} /></button
                  >{:else}<button
                    class="send-button"
                    type="submit"
                    disabled={!canSend || (!prompt.trim() && !attachedImages.length)}
                    aria-label="Send message"><ArrowUp size={19} /></button
                  >{/if}
              </div>
            </form>
            <UsagePanel
              {canCompact}
              compact={() => void send(false, undefined, '/compact')}
              changeAutoCompact={(autoCompactTokens) => changeSettings({ ...selectedSettings, autoCompactTokens })}
              compactionSettingsDisabled={activeRunning}
              bind:expanded={usageExpanded}
              conversation={active}
              settings={selectedSettings}
              model={currentModel}
              snapshot={selectedUsage}
              loading={!!usageLoading[selectedUsageKey]}
              error={usageErrors[selectedUsageKey] ?? ''}
              preview={!desktop() && !paired}
              accountName={workspace.fleet.accounts.find(a => a.id === workspace.fleet.connections.find(c => c.id === selectedSettings.connectionId)?.accountId)?.name}
              accountUnavailable={!canQueryConnection(selectedSettings.connectionId, selectedSettings.provider)}
            />
          </div>
        </section>
        {#if selectedArtifact}{#key selectedArtifact.id}<ArtifactViewer
              artifact={selectedArtifact}
              mode={artifactMode}
              changeMode={(mode) => (artifactMode = mode)}
              close={() => (selectedArtifact = null)}
            />{/key}{/if}
      </div>
    {:else if view === 'connections'}
      {#key workspaceSession}
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
          reconnecting={relayRestorePending && !!syncError}
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
          running={localRunning}
        />
      {/key}
    {:else if view === 'settings'}
      {#key workspaceSession}
        <SettingsPage
          {paired}
          {workspaceSession}
          {exportWorkspace}
          {appUpdate}
          {restartToUpdate}
          claudeInstructions={workspace.claudeInstructions}
          {saveClaudeInstructions}
        />
      {/key}
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
    initialLocation={selectedLocation}
    recent={savedLocations}
    browse={listFolders}
    choose={(location) => chooseLocation(location, true)}
    close={() => (folderBrowserOpen = false)}
  />
{/if}
{#if contextOpen}<ModelContext
    running={activeRunning}
    conversationId={active?.id}
    forked={active?.forked}
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
    outputSchema={selectedSettings.outputSchema}
    maxThinkingTokens={selectedSettings.maxThinkingTokens}
    fastMode={selectedSettings.fastMode}
    fallbackModel={selectedSettings.fallbackModel}
    {focusFast}
    provider={selectedSettings.provider}
    close={() => {
      editorOpen = false;
      focusFast = false;
    }}
    save={(instructions, outputSchema, maxThinkingTokens, fastMode, fallbackModel) => {
      changeSettings({
        ...selectedSettings, instructions, outputSchema, maxThinkingTokens, fastMode, fallbackModel,
      });
      editorOpen = false;
      focusFast = false;
    }}
  />{/if}
{#if templatesOpen && view === 'chat'}
  <InputTemplates
    templates={workspace.inputTemplates ?? []}
    draft={prompt}
    close={closeTemplates}
    save={(template, previous) => updateInputTemplate(template, previous)}
    remove={(template) => updateInputTemplate(undefined, template)}
    insert={(text) => {
      prompt = appendTemplateInput(prompt, text);
      closeTemplates();
      void tick().then(() => composerInput?.setSelectionRange(prompt.length, prompt.length));
    }}
  />
{/if}
{#if conversationMenu && menuConversation}
  {#key conversationMenu}
    <ConversationContextMenu
      x={conversationMenu.x}
      y={conversationMenu.y}
      name={menuConversation.title}
      trigger={conversationMenu.trigger}
      close={closeConversationMenu}
      remove={requestConversationDeletion}
      fork={() => menuConversation && void forkChat(menuConversation.id)}
      forkDisabled={forking || imagesLoading || forkPoint(menuConversation) < 0}
    />
  {/key}
{:else if conversationMenu && menuScratch}
  {#key conversationMenu}
    <ConversationContextMenu
      x={conversationMenu.x}
      y={conversationMenu.y}
      name={`Unsent draft: ${menuScratch.title}`}
      trigger={conversationMenu.trigger}
      close={closeConversationMenu}
      remove={requestScratchDiscard}
      removeLabel="Discard draft"
    />
  {/key}
{/if}
{#if historyAction && active?.id === historyAction.conversationId}
  {@const action = historyAction}
  {#key `${workspaceSession}:${active.id}:${historyAction.kind}:${historyAction.runId ?? ''}`}
    {#if historyAction.kind === 'rewind'}
      <RewindDialog
        conversation={active}
        messageId={historyAction.messageId}
        close={() => {
          if (historyAction === action) historyAction = undefined;
        }}
        apply={(id) => changeHistory(id)}
      />
    {:else if historyAction.runId}
      {@const conversationId = active.id}
      {@const runId = historyAction.runId}
      <UndoFilesDialog
        {conversationId}
        {runId}
        connectionId={active.settings.connectionId}
        close={() => {
          if (historyAction === action) historyAction = undefined;
        }}
        prepare={() => prepareUndo(conversationId, action.session)}
        applied={() => markFilesUndone(conversationId, runId, action.session)}
      />
    {/if}
  {/key}
{/if}
{#if deletion}<div class="modal-backdrop confirmation-backdrop" role="presentation">
    <div
      class="modal small-modal"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-title"
      tabindex="-1"
      use:focusDeletionDialog
    >
      {#if deletion.type === 'draft'}<h2 id="delete-title">Discard draft?</h2>
        <p>
          “{deletion.name}” was never sent. Its text will be removed from this device. This cannot
          be undone.
        </p>
      {:else}<h2 id="delete-title">Delete {deletion.type}?</h2>
        <p>
          “{deletion.name}” will be removed from this workspace. This cannot be undone.
        </p>{/if}
      {#if deletingConversation && conversationRunning(deletingConversation)}<p>
          The running response will be stopped before this conversation is deleted.
        </p>{/if}
      {#if deletionError}<p role="alert">{deletionError}</p>{/if}
      <footer>
        <button class="secondary" disabled={deleting} onclick={() => (deletion = null)}
          >Cancel</button
        ><button
          class="danger"
          disabled={(deletion.type === 'conversation' && !deletingConversation) || deleting}
          onclick={remove}
          >{deleting
            ? 'Deleting…'
            : deletion.type === 'draft'
              ? 'Discard draft'
              : `Delete ${deletion.type}`}</button
        >
      </footer>
    </div>
  </div>{/if}
{/if}
