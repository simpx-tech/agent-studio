/**
 * What changed on this device since the last save and since the last sync.
 *
 * A conversation is named by its id, and `undefined` stands for every conversation: that is what
 * a change nobody named means, so a new call site stays conservative by default. The replicated
 * settings (computers, accounts, templates, workflows, Claude instructions, app sessions) are
 * tracked apart from the conversations, so changing one never makes a save or a sync visit every
 * conversation. Data received from the relay is saved but never marked for sync: publishing it
 * back would echo it, and a merge would take anything it lacks for a change made here.
 *
 * A change can also name the one message it touched, which a running reply's events do. Copies
 * of a conversation then read that message alone again (`touched`, src/lib/chat-snapshots.ts);
 * a change that names none makes them read every message.
 */
export type ChangeSet = {
  /** The conversations to publish, or `undefined` for all of them. */
  chats: Set<string> | undefined;
  /** Whether the replicated settings changed here. */
  meta: boolean;
  /**
   * Conversations in which only a running call's elapsed time moved on. Nobody waits for that,
   * so a sync publishes them now and then rather than with every poll.
   */
  quiet?: Set<string>;
};

export function createChangeMarks(
  /** Told each conversation, and message when one is named, that changed or arrived. */
  touched: (chatId?: string, messageId?: string) => void = () => {},
) {
  // Nothing is known about an unsaved or unsynced state at the start, so everything counts.
  let unsaved: Set<string> | undefined;
  let index = true;
  let unsynced: ChangeSet & { quiet: Set<string> } = {
    chats: undefined,
    meta: true,
    quiet: new Set(),
  };
  // What the sync under way took and has neither published nor handed back yet, which still
  // counts as changed here (`pending`).
  let publishing: ChangeSet | undefined;
  return {
    /**
     * A conversation changed here, or every conversation when none is named. `messageId` names
     * the only message of it that changed.
     */
    chat(id?: string, messageId?: string) {
      touched(id, messageId);
      if (id === undefined) {
        unsaved = undefined;
        unsynced = { chats: undefined, meta: true, quiet: new Set() };
        return;
      }
      unsaved?.add(id);
      unsynced.chats?.add(id);
    },
    /**
     * Only the elapsed time of a call this message is running moved on: saved with the next save,
     * and published once something else changes in the conversation or a while has passed.
     */
    quiet(id: string, messageId: string) {
      touched(id, messageId);
      unsaved?.add(id);
      unsynced.quiet.add(id);
    },
    /** The replicated settings changed here: saved with the index and published. */
    meta() {
      index = true;
      unsynced.meta = true;
    },
    /** State this device keeps to itself, such as remembered choices: saved, never published. */
    local() {
      index = true;
    },
    /** Arrived from the relay: saved here, never published back. */
    received(id?: string, messageId?: string) {
      touched(id, messageId);
      index = true;
      if (id === undefined) unsaved = undefined;
      else unsaved?.add(id);
    },
    /** Whether a save has anything to write. */
    unsaved(): boolean {
      return index || !unsaved || unsaved.size > 0;
    },
    /** Takes the conversations the next save must send; `undefined` asks for all of them. */
    takeUnsaved(): Set<string> | undefined {
      const pending = unsaved;
      unsaved = new Set();
      index = false;
      return pending;
    },
    /** A save that failed must never leave its conversations looking saved. */
    failedSave() {
      unsaved = undefined;
      index = true;
    },
    /**
     * Takes what the next sync must publish. Changes made while it runs wait for the one after,
     * and a sync that does not publish them hands them back with `restoreUnsynced`.
     */
    takeUnsynced(): ChangeSet {
      const pending = unsynced;
      unsynced = { chats: new Set(), meta: false, quiet: new Set() };
      // A conversation that changed otherwise is published for that.
      if (pending.chats === undefined) pending.quiet.clear();
      else for (const id of pending.chats) pending.quiet.delete(id);
      const { quiet, ...changes } = pending;
      publishing = {
        chats: changes.chats && new Set([...changes.chats, ...quiet]),
        meta: changes.meta,
      };
      return quiet.size ? { ...changes, quiet } : changes;
    },
    restoreUnsynced(changes: ChangeSet) {
      if (changes.meta) unsynced.meta = true;
      if (changes.chats === undefined || unsynced.chats === undefined) unsynced.chats = undefined;
      else for (const id of changes.chats) unsynced.chats.add(id);
      for (const id of changes.quiet ?? []) unsynced.quiet.add(id);
    },
    /**
     * The sync that took the last changes ended: the relay holds what it published, and what it
     * did not went back with `restoreUnsynced`. Returns whether it had taken anything, which leaves
     * fewer conversations pending.
     */
    settleUnsynced(): boolean {
      const taken = publishing;
      publishing = undefined;
      return !!taken && (taken.meta || taken.chats === undefined || taken.chats.size > 0);
    },
    /**
     * The conversations changed here that the relay may not hold yet, and whether the replicated
     * settings did: what waits for a sync and what a sync under way has not published. `chats` is
     * `undefined` while that is not known, as at the start, when every conversation counts.
     */
    pending(): { chats: Set<string> | undefined; meta: boolean } {
      const chats =
        unsynced.chats === undefined || (publishing && publishing.chats === undefined)
          ? undefined
          : new Set([...unsynced.chats, ...unsynced.quiet, ...(publishing?.chats ?? [])]);
      return { chats, meta: unsynced.meta || !!publishing?.meta };
    },
    /**
     * Starts from what an earlier session of this device left changed and unpublished, saved
     * with its copy (the Viewer), instead of counting every conversation as changed.
     */
    resume(saved: { chats: string[]; meta: boolean }) {
      unsynced = { chats: new Set(saved.chats), meta: saved.meta, quiet: new Set() };
      publishing = undefined;
    },
  };
}
export type ChangeMarks = ReturnType<typeof createChangeMarks>;
