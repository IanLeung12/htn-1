/**
 * Side-effect-free re-export so index.html and sim.html can both import
 * `startApp` from a stable path without triggering module-level work.
 */
export { startApp, default } from './main';
export type { AppHandle, AppOptions, StartApp, XRFeatureReport } from './contract';
