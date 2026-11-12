// The kinds of limit each account's usage bars showed after its last reading on this device, so
// that the bars of a list of accounts, such as the Agent picker's, wait for their readings in the
// places those readings fill, and the list keeps its width while it loads (requested 2026-11-12).
// Remembered in this device's storage by connection: a hint for the layout alone, never a
// reading, never synced, and forgotten for connections the workspace no longer holds.
import { providerIds, type ProviderId } from './domain';
import { limitSlots, type LimitSlot } from './usage';

const storageKey = 'agent-studio.shown-limits';

type Shown = { provider: ProviderId; limits: LimitSlot[] };

export function shownLimits(
  storage: () => Pick<Storage, 'getItem' | 'setItem'> | undefined = () =>
    typeof localStorage === 'undefined' ? undefined : localStorage,
) {
  let shown: Record<string, Shown> | undefined;
  function load() {
    if (shown) return shown;
    shown = {};
    try {
      const saved: unknown = JSON.parse(storage()?.getItem(storageKey) ?? '{}');
      if (saved && typeof saved === 'object')
        for (const [id, entry] of Object.entries(saved)) {
          const { provider, limits } = (entry ?? {}) as Partial<Record<keyof Shown, unknown>>;
          if (providerIds.includes(provider as ProviderId) && Array.isArray(limits))
            shown[id] = {
              provider: provider as ProviderId,
              limits: limitSlots.filter((slot) => limits.includes(slot)),
            };
        }
    } catch {
      // Storage can be unavailable, as in a private window; bars then wait as they always did.
    }
    return shown;
  }
  return {
    /**
     * The kinds of limit an account's bars are expected to show: those they showed after its
     * last reading here, else those the agent's other accounts showed, else unknown.
     */
    expected(provider: ProviderId, connectionId: string): LimitSlot[] | undefined {
      const all = load();
      const own = all[connectionId];
      if (own) return own.provider === provider ? own.limits : undefined;
      const others = Object.values(all).filter((entry) => entry.provider === provider);
      return others.length
        ? limitSlots.filter((slot) => others.some((entry) => entry.limits.includes(slot)))
        : undefined;
    },
    /** Remembers the kinds of limit an account's bars showed after a reading of all its limits,
     * forgetting connections the workspace no longer holds (`known`). */
    remember(
      provider: ProviderId,
      connectionId: string,
      limits: readonly LimitSlot[],
      known?: ReadonlySet<string>,
    ) {
      const all = load();
      const previous = all[connectionId];
      const gone = known
        ? Object.keys(all).filter((id) => id !== connectionId && !known.has(id))
        : [];
      if (
        previous?.provider === provider &&
        previous.limits.length === limits.length &&
        previous.limits.every((slot, index) => slot === limits[index]) &&
        !gone.length
      )
        return;
      all[connectionId] = { provider, limits: limitSlots.filter((slot) => limits.includes(slot)) };
      for (const id of gone) delete all[id];
      try {
        storage()?.setItem(storageKey, JSON.stringify(all));
      } catch {
        // The bars still keep their places for the rest of this session.
      }
    },
  };
}

const device = shownLimits();
export const expectedLimits = device.expected;
export const rememberShownLimits = device.remember;
