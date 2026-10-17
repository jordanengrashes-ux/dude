import RAPIER from '@dimforge/rapier3d-deterministic-compat';

/**
 * Rapier (deterministic build). The deterministic package guarantees bit-identical
 * results across platforms for identical inputs, which the replay and determinism
 * tests rely on.
 */
let ready: Promise<typeof RAPIER> | null = null;

export function loadRapier(): Promise<typeof RAPIER> {
  if (!ready) {
    ready = (async () => {
      const silence = console.warn;
      // Rapier prints a deprecation notice for the init signature; keep test output clean.
      console.warn = (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].includes('deprecated parameters')) return;
        silence(...args);
      };
      try {
        await RAPIER.init();
      } finally {
        console.warn = silence;
      }
      return RAPIER;
    })();
  }
  return ready;
}

export type Rapier = typeof RAPIER;
export { RAPIER };
