/** Values the build puts in (electron-vite reads `MAIN_VITE_*` from the environment): set by the Release workflow only. */
interface ImportMetaEnv {
  /** PostHog's project key: our releases send anonymous usage analytics, builds from a clone don't */
  readonly MAIN_VITE_POSTHOG_KEY?: string;
}
