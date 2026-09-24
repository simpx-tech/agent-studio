import { SvelteSet } from 'svelte/reactivity';

/**
 * Tracks which `<details>` disclosures have rendered their contents. Contents render when a
 * disclosure is first expanded and then stay, keeping nested expansion. Collapsed history
 * stays out of the page, which keeps long conversations quick to open and to select text in:
 * a selection walks every element it crosses.
 */
export function revealedDisclosures() {
  const revealed = new SvelteSet<string>();
  return {
    has: (key: string) => revealed.has(key),
    /**
     * A summary click handler. It renders the contents before the disclosure opens, so the
     * reading position held by virtual-space.ts measures them. The toggle event is queued and
     * can arrive after the next frame.
     */
    reveal: (key: string) => () => {
      revealed.add(key);
    },
    /** A toggle handler for any other way of opening. */
    opened: (key: string) => (event: Event) => {
      if ((event.currentTarget as HTMLDetailsElement).open) revealed.add(key);
    },
  };
}
