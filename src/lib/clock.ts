import { createSubscriber } from 'svelte/reactivity';

// One clock for every live elapsed time. A running reply's sidebar row and its footer read the
// same tick, so they never show different seconds, and a single timer runs only while
// something on screen reads it.
let ticking = false;
let latest = 0;
const subscribe = createSubscriber((update) => {
  ticking = true;
  latest = Date.now();
  const timer = setInterval(() => {
    latest = Date.now();
    update();
  }, 1000);
  return () => {
    clearInterval(timer);
    ticking = false;
  };
});

export const clock = {
  /** The time of the latest tick; templates and effects that read it update every second. */
  get now() {
    subscribe();
    return ticking ? latest : Date.now();
  },
};
