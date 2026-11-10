// What `$state` compiles to, which unit tests use to hold data as the page holds its workspace
// (src/lib/detached.ts). Svelte publishes no types for its internal runtime.
declare module 'svelte/internal/client' {
  export function proxy<T>(value: T): T;
}
