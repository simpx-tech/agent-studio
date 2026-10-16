import type { Page } from '@playwright/test';

// Lets a test send the host's background work events as `hostBackground(event)`; a window
// that loads asks for the lists stored under `test-background-work`.
export async function mockHostBackground(page: Page) {
  await page.addInitScript(() => {
    const state = window as any,
      native = state.__TAURI_INTERNALS__;
    const invoke = native.invoke,
      transform = native.transformCallback;
    const callbacks = new Map<number, (value: unknown) => void>();
    let listener = 0;
    native.transformCallback = (fn: (value: unknown) => void) => {
      const id = transform(fn);
      callbacks.set(id, fn);
      return id;
    };
    native.invoke = async (command: string, args: any) => {
      if (command === 'plugin:event|listen' && args.event === 'studio-background-work')
        listener = args.handler;
      if (command === 'background_work')
        return JSON.parse(localStorage.getItem('test-background-work') ?? '[]');
      return invoke(command, args);
    };
    state.hostBackground = (payload: unknown) =>
      callbacks.get(listener)!({ event: 'studio-background-work', id: 1, payload });
  });
}
