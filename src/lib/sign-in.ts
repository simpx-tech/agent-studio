import { z } from 'zod';

/**
 * A sign-in the desktop host runs without a terminal: the selected profile's CLI waits hidden
 * while its sign-in page is open in the browser (`src-tauri/src/sign_in.rs`). Its page and any
 * pasted code stay on this computer, in memory: never saved, synced or relayed.
 */
export const signInViewSchema = z.object({
  id: z.string().min(1).max(80),
  provider: z.enum(['claude', 'codex', 'gemini']),
  connectionId: z.string().max(80).optional(),
  phase: z.enum(['waiting', 'connected', 'failed', 'cancelled', 'expired']),
  /** The sign-in page, to open again while the sign-in waits. */
  url: z.string().max(8192).optional(),
  /** Whether the page can end with a code to paste in the app (Claude). */
  code: z.boolean(),
  /** Whether the page that opened always ends with that code (Claude in WSL). */
  codeExpected: z.boolean().optional(),
  /** What to do now, or why the sign-in ended. */
  message: z.string().max(600),
});
export type SignInView = z.infer<typeof signInViewSchema>;

/** Sign-ins are shown by the connection they sign in to, or by the provider for its own login. */
export const signInKey = (view: { provider: string; connectionId?: string }) =>
  view.connectionId ?? view.provider;

/**
 * What a window does with a sign-in's update: shows it (waiting, or ended with a reason), checks
 * the account it connected, clears it, or ignores an older sign-in of an account that started
 * another since. A sign-in that ended gives way to the next one.
 */
export type SignInUpdate = 'show' | 'ended' | 'connected' | 'clear' | 'ignore';
export function signInUpdate(shown: SignInView | undefined, view: SignInView): SignInUpdate {
  if (shown && shown.id !== view.id && shown.phase === 'waiting') return 'ignore';
  switch (view.phase) {
    case 'waiting':
      return 'show';
    case 'connected':
      return 'connected';
    case 'cancelled':
      // A sign-in another one replaced says so; one the user cancelled just goes.
      return view.message ? 'ended' : 'clear';
    default:
      return 'ended';
  }
}
