import type { Artifact } from './artifacts';

// What each chat shows beside its conversation, by conversation (requested 2026-10-14): an
// artifact, in the modal or the side panel, and the sub-agent whose conversation the side panel
// shows. A side panel belongs to its chat: another chat, Connections or Settings hides it, and it
// is open again when its chat returns. These stay in the window's memory, never saved or synced.

/** An artifact a chat shows. */
export type ArtifactView = {
  artifact: Artifact;
  mode: 'modal' | 'panel';
  /** Whether it takes focus when it opens: only when the reader opened it in the chat. */
  focus: boolean;
};

/** The sub-agent whose conversation a chat's side panel shows, by the reply that started it. */
export type SubagentView = { messageId: string; agentId: string; focus: boolean };

/**
 * Leaves every chat but the one shown: its modal closes, and its side panel, shown again with
 * its chat, leaves focus where it is.
 */
export function leaveChats(
  artifacts: Record<string, ArtifactView>,
  subagents: Record<string, SubagentView>,
  shown: string | null,
) {
  for (const [id, view] of Object.entries(artifacts)) {
    if (id === shown) continue;
    if (view.mode === 'modal') delete artifacts[id];
    else view.focus = false;
  }
  for (const [id, view] of Object.entries(subagents)) if (id !== shown) view.focus = false;
}

/**
 * The width a docked side panel and the chat beside it share: the workspace's, without the padding
 * and the gap between them that chats shown as cards leave (requested 2026-10-19).
 */
export function panelRoom(workspace: HTMLElement) {
  const style = getComputedStyle(workspace);
  const spaced = (value: string) => parseFloat(value) || 0;
  return (
    workspace.getBoundingClientRect().width -
    spaced(style.paddingLeft) -
    spaced(style.paddingRight) -
    spaced(style.columnGap)
  );
}

/**
 * Shows a panel's dialog beside the chat when docked, and otherwise as a drawer over it, which
 * takes focus as any modal does. Opening it moves focus to `control`; a docked panel shown again
 * with its chat puts focus back where it was, since the browser moves focus into any dialog it
 * shows.
 */
export function showPanel(
  dialog: HTMLDialogElement,
  docked: boolean,
  control: string,
  keepFocus = false,
) {
  const kept = keepFocus && docked ? document.activeElement : null;
  dialog.close();
  if (docked) dialog.show();
  else dialog.showModal();
  if (!kept) dialog.querySelector<HTMLElement>(control)?.focus();
  else if (
    (kept instanceof HTMLElement || kept instanceof SVGElement) &&
    kept !== document.body &&
    kept.isConnected
  )
    kept.focus({ preventScroll: true });
  else if (document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement))
    document.activeElement.blur();
}
