// Version string surfaced in the sidebar footer (and anywhere else that
// wants to show it). Sourced from VITE_APP_VERSION which the Docker build
// passes in from the release-please tag; defaults to "dev" so local
// `bun run dev` shows a recognizable placeholder rather than "undefined".

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? "dev";

// Display form: prefix a "v" only when the value parses as semver
// (`2.5.0`, `2.5.0-rc.1`). Keeps "dev" un-prefixed.
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-.+].*)?$/;
export const APP_VERSION_DISPLAY = SEMVER_RE.test(APP_VERSION) ? `v${APP_VERSION}` : APP_VERSION;
