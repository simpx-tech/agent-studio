/** A place in a sound or its length, as a player shows it: 0:42, 3:15, 1:02:03. */
export function mediaTime(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const rest = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/**
 * Where a key moves a player's position, or undefined for a key it leaves alone: the arrows five
 * seconds back or on, Page Up and Page Down a tenth of the sound, Home and End to either end.
 */
export function seekKey(key: string, time: number, duration: number): number | undefined {
  const step =
    key === 'ArrowLeft' || key === 'ArrowDown'
      ? -5
      : key === 'ArrowRight' || key === 'ArrowUp'
        ? 5
        : key === 'PageDown'
          ? -duration / 10
          : key === 'PageUp'
            ? duration / 10
            : undefined;
  if (key === 'Home') return 0;
  if (key === 'End') return duration;
  return step === undefined ? undefined : Math.min(duration, Math.max(0, time + step));
}
