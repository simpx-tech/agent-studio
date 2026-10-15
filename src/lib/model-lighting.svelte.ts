// The light every 3D model in the window is drawn with, remembered on this device. Studio is
// the default; the views drawn for other devices keep it whatever is chosen here.
import { isLighting, type Lighting } from './model-scene';

const storageKey = 'agent-studio.model-lighting';

function saved(): Lighting {
  try {
    const value = typeof localStorage === 'undefined' ? null : localStorage.getItem(storageKey);
    if (isLighting(value)) return value;
  } catch {
    // Storage can be unavailable in private windows; Studio still applies.
  }
  return 'studio';
}

export const modelLighting = $state<{ value: Lighting }>({ value: saved() });

export function setModelLighting(value: Lighting) {
  modelLighting.value = value;
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    // The choice still applies for this session.
  }
}
