<script lang="ts">
  import { tick } from 'svelte';
  import {
    ChevronRight,
    Folder,
    FolderOpen,
    FolderPlus,
    Laptop,
    LayoutDashboard,
    LoaderCircle,
    PencilLine,
    Ungroup,
  } from '@lucide/svelte';
  import ScreenTreeMenu from './ScreenTreeMenu.svelte';
  import {
    insideGroup,
    screenDestinations,
    shownGroup,
    shownParent,
    type RegroupRequest,
    type ScreenGroupNode,
    type ScreenMenuAction,
    type ScreenTreeSection,
  } from '$lib/screen-groups';
  import { pressToFile, type ScreenDragItem, type ScreenDropTarget } from '$lib/screen-drag';
  import {
    screenFolderName,
    type ScreenGroup,
    type ScreenGroups,
    type ScreenSummary,
  } from '$lib/screens';

  // The Screens tab's tree (requested 2026-11-24): under each computer, its groups, each holding
  // its own groups and screens, and the screens in no group. A computer's or a group's
  // New group, a screen's or a group's menu (right click, Shift+F10, or a held touch) and a drag
  // with the mouse or a pen move screens and groups into groups; the computer that keeps them
  // keeps the groups (src-tauri/src/screens/groups.rs).
  let {
    sections,
    groups,
    screens,
    collapsed = $bindable(),
    searching,
    current,
    open,
    regroup,
    fail,
  }: {
    sections: ScreenTreeSection[];
    /** Every computer's groups. */
    groups: ScreenGroup[];
    /** Every computer's screens. */
    screens: ScreenSummary[];
    collapsed: Record<string, boolean>;
    searching: boolean;
    /** The screen on screen, if one is. */
    current?: string;
    open: (screen: ScreenSummary) => void;
    regroup: (environmentId: string, request: RegroupRequest) => Promise<ScreenGroups>;
    /** Shows why a move did not happen. */
    fail: (message: string) => void;
  } = $props();

  let tree: HTMLDivElement;
  const computerKey = (section: string) => `screens/${section}`;
  const groupKey = (section: string, group: string) => `screens/${section}/${group}`;
  const message = (e: unknown) =>
    (e instanceof Error ? e.message : String(e)).replace(/^Error: /, '');
  const usable = (section: ScreenTreeSection) => section.groupable && section.online;

  /** Shows a group, with the groups it is in and its computer, so what moves there shows. */
  function reveal(section: string, group: string | undefined) {
    collapsed[computerKey(section)] = false;
    const known = new Map(groups.map((known) => [known.id, known]));
    const seen = new Set<string>();
    for (let next = group; next && !seen.has(next); next = known.get(next)?.parent) {
      seen.add(next);
      collapsed[groupKey(section, next)] = false;
    }
  }
  async function focusItem(key: string) {
    await tick();
    const item = tree?.querySelector<HTMLElement>(`[data-screen-drag="${key}"]`);
    item?.focus({ preventScroll: true });
    item?.scrollIntoView({ block: 'nearest' });
  }

  // Naming a new group, or renaming one, in place.
  type Editing =
    | {
        mode: 'new';
        section: string;
        environmentId: string;
        parent?: string;
        /** A screen that goes into the new group. */
        screen?: string;
        back?: HTMLElement;
      }
    | {
        mode: 'rename';
        section: string;
        environmentId: string;
        group: string;
        name: string;
        back?: HTMLElement;
      };
  let editing = $state<Editing>();
  let editName = $state('');
  let editError = $state('');
  let busy = $state(false);
  let input = $state<HTMLInputElement>();

  async function edit(next: Editing) {
    closeMenu();
    editing = next;
    editName = next.mode === 'rename' ? next.name : '';
    editError = '';
    if (next.mode === 'new') reveal(next.section, next.parent);
    await tick();
    input?.focus();
    input?.select();
  }
  function stopEditing(restoreFocus = false) {
    const back = editing?.back;
    editing = undefined;
    editError = '';
    if (restoreFocus && back?.isConnected) back.focus({ preventScroll: true });
  }
  /** Saves the name; leaving the field, which put focus elsewhere already, leaves it there. */
  async function commit(left = false) {
    const target = editing;
    if (!target || busy) return;
    const name = editName.trim();
    if (!name) return stopEditing(!left);
    if (target.mode === 'rename' && name === target.name) {
      stopEditing();
      return focusItem(`group:${target.group}`);
    }
    busy = true;
    editError = '';
    try {
      if (target.mode === 'rename') {
        await regroup(target.environmentId, { op: 'renameGroup', group: target.group, name });
        if (editing === target) stopEditing();
        await focusItem(`group:${target.group}`);
        return;
      }
      const answer = await regroup(target.environmentId, {
        op: 'createGroup',
        environmentId: target.environmentId,
        name,
        ...(target.parent ? { parent: target.parent } : {}),
      });
      if (editing === target) stopEditing();
      const made = answer.group;
      if (!made) return;
      reveal(target.section, made.id);
      if (target.screen) {
        try {
          await regroup(target.environmentId, {
            op: 'moveScreen',
            id: target.screen,
            group: made.id,
          });
        } catch (e) {
          fail(message(e));
        }
      }
      await focusItem(`group:${made.id}`);
    } catch (e) {
      if (editing === target) {
        editError = message(e);
        busy = false;
        await tick();
        input?.focus();
      }
    } finally {
      busy = false;
    }
  }

  // A screen's or a group's menu.
  let menu = $state<{
    x: number;
    y: number;
    trigger: HTMLElement;
    section: ScreenTreeSection;
    screen?: ScreenSummary;
    group?: ScreenGroup;
  }>();
  function closeMenu(restoreFocus = false) {
    const trigger = menu?.trigger;
    menu = undefined;
    if (restoreFocus) void tick().then(() => trigger?.focus({ preventScroll: true }));
  }
  type Subject = { screen?: ScreenSummary; group?: ScreenGroup };
  function showMenu(
    trigger: HTMLElement,
    x: number,
    y: number,
    section: ScreenTreeSection,
    subject: Subject,
  ) {
    if (!usable(section) || !trigger.isConnected) return;
    menu = { x, y, trigger, section, ...subject };
  }
  function openMenu(
    event: MouseEvent | KeyboardEvent,
    section: ScreenTreeSection,
    subject: Subject,
  ) {
    event.preventDefault();
    cancelTouch();
    const trigger = event.currentTarget as HTMLElement;
    if ('pointerType' in event && event.pointerType === 'touch') held = trigger;
    const bounds = trigger.getBoundingClientRect();
    const pointer = 'clientX' in event && (event.clientX !== 0 || event.clientY !== 0);
    showMenu(
      trigger,
      pointer ? event.clientX : bounds.left + 12,
      pointer ? event.clientY : bounds.bottom,
      section,
      subject,
    );
  }
  function menuKey(event: KeyboardEvent, section: ScreenTreeSection, subject: Subject) {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
      openMenu(event, section, subject);
  }
  const menuActions = $derived.by((): ScreenMenuAction[] => {
    if (!menu) return [];
    const { section, screen, group } = menu;
    if (screen)
      return [
        {
          label: 'New group with this screen',
          icon: FolderPlus,
          run: () =>
            void edit({
              mode: 'new',
              section: section.id,
              environmentId: screen.environmentId,
              parent: shownGroup(groups, screen),
              screen: screen.id,
              back: menu?.trigger,
            }),
        },
      ];
    if (!group) return [];
    return [
      {
        label: 'New group inside',
        icon: FolderPlus,
        run: () =>
          void edit({
            mode: 'new',
            section: section.id,
            environmentId: group.environmentId,
            parent: group.id,
            back: menu?.trigger,
          }),
      },
      {
        label: 'Rename',
        icon: PencilLine,
        run: () =>
          void edit({
            mode: 'rename',
            section: section.id,
            environmentId: group.environmentId,
            group: group.id,
            name: group.name,
            back: menu?.trigger,
          }),
      },
      {
        label: 'Ungroup',
        icon: Ungroup,
        run: () => {
          closeMenu();
          void ungroup(section, group);
        },
      },
    ];
  });

  async function ungroup(section: ScreenTreeSection, group: ScreenGroup) {
    const parent = shownParent(groups, group);
    try {
      await regroup(group.environmentId, { op: 'deleteGroup', group: group.id });
      reveal(section.id, parent);
      if (parent) await focusItem(`group:${parent}`);
      else {
        await tick();
        tree
          ?.querySelector<HTMLElement>(
            `[data-screen-computer="${section.id}"] .computer-group-toggle`,
          )
          ?.focus({ preventScroll: true });
      }
    } catch (e) {
      fail(message(e));
    }
  }
  /** Moves a screen or a group into a group, or to the top of its computer when none. */
  async function move(
    section: string,
    item: { kind: 'screen' | 'group'; id: string },
    into: string | undefined,
    focus: boolean,
  ) {
    const environment =
      item.kind === 'screen'
        ? screens.find((screen) => screen.id === item.id)?.environmentId
        : groups.find((group) => group.id === item.id)?.environmentId;
    if (!environment) return;
    reveal(section, into);
    try {
      await regroup(
        environment,
        item.kind === 'screen'
          ? { op: 'moveScreen', id: item.id, ...(into ? { group: into } : {}) }
          : { op: 'moveGroup', group: item.id, ...(into ? { parent: into } : {}) },
      );
    } catch (e) {
      fail(message(e));
    }
    if (focus) await focusItem(`${item.kind}:${item.id}`);
  }

  // A drag with the mouse or a pen lands a screen or a group in the group under the pointer.
  function accepts(item: ScreenDragItem, target: ScreenDropTarget) {
    const section = sections.find((known) => known.id === item.computer);
    if (!section || !usable(section)) return false;
    const into = target.group ? groups.find((group) => group.id === target.group) : undefined;
    if (target.group && !into) return false;
    if (item.kind === 'screen') {
      const screen = screens.find((known) => known.id === item.id);
      if (!screen || (into && into.environmentId !== screen.environmentId)) return false;
      return target.group !== shownGroup(groups, screen);
    }
    const group = groups.find((known) => known.id === item.id);
    if (!group) return false;
    if (
      into &&
      (into.environmentId !== group.environmentId || insideGroup(groups, into.id, group.id))
    )
      return false;
    return target.group !== shownParent(groups, group);
  }
  function drop(item: ScreenDragItem, target: ScreenDropTarget) {
    void move(item.computer, item, target.group, false);
  }

  // A held touch opens the menu; touches never drag, so lists scroll.
  let touchTimer: ReturnType<typeof setTimeout> | undefined;
  let touchOrigin: { x: number; y: number } | undefined;
  let held: EventTarget | undefined;
  function cancelTouch() {
    clearTimeout(touchTimer);
    touchOrigin = undefined;
  }
  function press(event: PointerEvent, section: ScreenTreeSection, subject: Subject) {
    cancelTouch();
    held = undefined;
    if (!usable(section)) return;
    if (event.pointerType !== 'touch') return pressToFile(event, accepts, drop);
    const trigger = event.currentTarget as HTMLElement;
    const x = event.clientX;
    const y = event.clientY;
    touchOrigin = { x, y };
    touchTimer = setTimeout(() => {
      touchOrigin = undefined;
      held = trigger;
      showMenu(trigger, x, y, section, subject);
    }, 500);
  }
  function touchMoved(event: PointerEvent) {
    if (touchOrigin && Math.hypot(event.clientX - touchOrigin.x, event.clientY - touchOrigin.y) > 8)
      cancelTouch();
  }
  /** The tap that ends a held touch opens and folds nothing. */
  function heldTap(event: MouseEvent) {
    if (held !== event.currentTarget) return false;
    held = undefined;
    event.preventDefault();
    return true;
  }
</script>

{#snippet nameField(label: string)}
  <div class="screen-group-editor">
    <input
      bind:this={input}
      bind:value={editName}
      aria-label={label}
      placeholder="Group name"
      autocomplete="off"
      spellcheck="false"
      readonly={busy}
      aria-invalid={editError ? 'true' : undefined}
      aria-describedby={editError ? 'screen-group-error' : undefined}
      onkeydown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          stopEditing(true);
        }
      }}
      onblur={() => {
        if (editing && !busy) void commit(true);
      }}
    />
    {#if editError}<p id="screen-group-error" class="screen-group-error" role="alert">
        {editError}
      </p>{/if}
  </div>
{/snippet}

{#snippet screenRow(screen: ScreenSummary, section: ScreenTreeSection)}
  {@const isCurrent = current === screen.id}
  {@const running = screen.running ?? 0}
  <div class="conversation-row" data-screen-lift>
    <button
      class="conversation-item screen-item"
      class:current={isCurrent}
      aria-current={isCurrent ? 'page' : undefined}
      aria-haspopup={usable(section) ? 'menu' : undefined}
      title={[
        screen.title,
        screen.description,
        screenFolderName(screen),
        ...(running ? [`${running} running`] : []),
      ]
        .filter(Boolean)
        .join(' · ')}
      aria-label={running ? `${screen.title}, ${running} running` : undefined}
      data-screen-drag={`screen:${screen.id}`}
      onpointerdown={(event) => press(event, section, { screen })}
      onpointermove={touchMoved}
      onpointerup={cancelTouch}
      onpointercancel={cancelTouch}
      oncontextmenu={(event) => openMenu(event, section, { screen })}
      onkeydown={(event) => menuKey(event, section, { screen })}
      onclick={(event) => {
        if (!heldTap(event)) open(screen);
      }}
      ><LayoutDashboard size={13} aria-hidden="true" /><span>{screen.title}</span>{#if running}<span
          class="screen-jobs"
          aria-hidden="true"><LoaderCircle size={12} class="spinning" /></span
        >{/if}</button
    >
  </div>
{/snippet}

{#snippet groupNode(node: ScreenGroupNode, section: ScreenTreeSection)}
  {@const key = groupKey(section.id, node.group.id)}
  {@const expanded = searching || !collapsed[key]}
  {@const renaming = editing?.mode === 'rename' && editing.group === node.group.id}
  <div
    class="screen-group"
    role="group"
    aria-label={node.group.name}
    data-screen-drop={node.group.id}
    data-screen-lift
  >
    <div class="folder-group-row screen-group-row">
      {#if renaming}{@render nameField(`Rename ${node.group.name}`)}{:else}<button
          class="folder-group-toggle screen-group-toggle"
          title={node.path.join(' › ')}
          aria-expanded={expanded}
          aria-haspopup={usable(section) ? 'menu' : undefined}
          data-screen-drag={`group:${node.group.id}`}
          onpointerdown={(event) => press(event, section, { group: node.group })}
          onpointermove={touchMoved}
          onpointerup={cancelTouch}
          onpointercancel={cancelTouch}
          oncontextmenu={(event) => openMenu(event, section, { group: node.group })}
          onkeydown={(event) => menuKey(event, section, { group: node.group })}
          onclick={(event) => {
            if (!heldTap(event)) collapsed[key] = !collapsed[key];
          }}
          >{#if expanded}<FolderOpen size={13} aria-hidden="true" />{:else}<Folder
              size={13}
              aria-hidden="true"
            />{/if}<span>{node.group.name}</span><ChevronRight
            size={12}
            class={expanded ? 'expanded-chevron' : ''}
          /></button
        >{#if usable(section)}<button
            class="folder-new-chat"
            title={`New group in ${node.group.name}`}
            aria-label={`New group in ${node.group.name}`}
            onclick={(event) =>
              void edit({
                mode: 'new',
                section: section.id,
                environmentId: node.group.environmentId,
                parent: node.group.id,
                back: event.currentTarget,
              })}><FolderPlus size={14} aria-hidden="true" /></button
          >{/if}{/if}
    </div>
    {#if expanded}
      <div class="screen-group-items">
        {#if editing?.mode === 'new' && editing.section === section.id && editing.parent === node.group.id}{@render nameField(
            `New group in ${node.group.name}`,
          )}{/if}
        {#each node.groups as child (child.group.id)}{@render groupNode(child, section)}{/each}
        {#if node.screens.length}<div class="folder-conversations screen-list">
            {#each node.screens as screen (screen.id)}{@render screenRow(screen, section)}{/each}
          </div>{/if}
      </div>
    {/if}
  </div>
{/snippet}

<div class="screen-tree" bind:this={tree}>
  {#each sections as section (section.id)}
    {@const key = computerKey(section.id)}
    {@const expanded = searching || !collapsed[key]}
    <div
      class="conversation-computer"
      role="group"
      aria-label={`${section.name} screens`}
      data-screen-computer={section.id}
      data-screen-drop=""
    >
      <div class="computer-group-row">
        <button
          class="computer-group-toggle"
          title={section.name}
          aria-expanded={expanded}
          onclick={() => (collapsed[key] = !collapsed[key])}
          ><Laptop size={13} /><span>{section.name}</span>{#if !section.online}<small
              class="computer-offline">Offline</small
            >{/if}<ChevronRight size={12} class={expanded ? 'expanded-chevron' : ''} /></button
        >{#if section.groupable && section.environmentId}<button
            class="computer-new-chat"
            title={`New group on ${section.name}`}
            aria-label={`New group on ${section.name}`}
            disabled={!section.online}
            onclick={(event) =>
              section.environmentId &&
              void edit({
                mode: 'new',
                section: section.id,
                environmentId: section.environmentId,
                back: event.currentTarget,
              })}><FolderPlus size={14} aria-hidden="true" /></button
          >{/if}
      </div>
      {#if expanded}
        {#if editing?.mode === 'new' && editing.section === section.id && !editing.parent}{@render nameField(
            `New group on ${section.name}`,
          )}{/if}
        {#each section.groups as node (node.group.id)}{@render groupNode(node, section)}{/each}
        {#if section.screens.length}<div class="folder-conversations screen-list">
            {#each section.screens as screen (screen.id)}{@render screenRow(screen, section)}{/each}
          </div>{/if}
      {/if}
    </div>
  {/each}
</div>

{#if menu}
  {@const subject = menu.screen ?? menu.group}
  {#key menu}
    <ScreenTreeMenu
      x={menu.x}
      y={menu.y}
      name={menu.screen?.title ?? menu.group?.name ?? ''}
      trigger={menu.trigger}
      close={closeMenu}
      actions={menuActions}
      moveFirst={!!menu.screen}
      destinations={subject
        ? screenDestinations(groups, subject.environmentId, menu.section.name, menu.group?.id)
        : []}
      current={menu.screen
        ? shownGroup(groups, menu.screen)
        : menu.group
          ? shownParent(groups, menu.group)
          : undefined}
      choose={(into) => {
        const target = menu;
        closeMenu();
        if (!target) return;
        void move(
          target.section.id,
          target.screen
            ? { kind: 'screen', id: target.screen.id }
            : { kind: 'group', id: target.group!.id },
          into,
          true,
        );
      }}
    />
  {/key}
{/if}

<style>
  /* A group lines its icon and name up with the screens beside it, and what it holds sits a
     step in. */
  .screen-group-toggle {
    padding-left: 10px;
    gap: 6px;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .screen-group + .screen-group {
    margin-top: 1px;
  }
  .screen-group-items {
    margin-left: 16px;
  }
  .screen-group-items > .folder-conversations {
    margin-bottom: 2px;
  }
  .screen-group-editor {
    flex: 1;
    min-width: 0;
    padding: 1px 0;
  }
  .screen-group-editor input {
    width: 100%;
    min-height: 28px;
    padding: 4px 9px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    background: var(--surface-sunken);
    color: var(--text);
    font: inherit;
    font-size: var(--text-base);
  }
  .screen-group-editor input:focus {
    border-color: var(--accent-border);
    outline: 2px solid var(--focus-ring);
    outline-offset: 0;
  }
  .screen-group-editor input[aria-invalid='true'] {
    border-color: var(--danger-border);
  }
  .screen-group-error {
    margin: 3px 2px 4px;
    color: var(--danger);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }
  /* A screen or a group moved by hand rides above the list on the overlay surface, and the place
     it would land shows in the accent (src/lib/screen-drag.ts). Only transforms move it. */
  .screen-tree :global(.screen-lifted) {
    position: relative;
    z-index: 2;
    pointer-events: none;
    border-radius: var(--radius-sm);
    background: var(--surface-overlay);
    box-shadow:
      0 0 0 1px var(--border-strong),
      var(--shadow-md);
  }
  .screen-tree :global(.screen-returning) {
    transition: transform var(--duration-fast) var(--ease-out);
  }
  .screen-tree :global(.screen-drop-target) {
    border-radius: var(--radius-sm);
    box-shadow: inset 0 0 0 1px var(--accent-border);
    background: var(--accent-soft);
  }
</style>
