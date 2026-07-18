export const FETCH_TIMEOUT_MS = 30_000;

// Minutes-scale, separate from FETCH_TIMEOUT_MS — a human has to actually complete SSO/MFA by
// hand, not a machine-speed round trip.
export const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface Config {
  instanceUrl: string;
  authStatePath: string;
  downloadDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    instanceUrl: env.SN_INSTANCE_URL ?? "https://mynow.servicenow.com",
    authStatePath: env.SN_AUTH_STATE_PATH ?? ".auth/servicenow-storage-state.json",
    downloadDir: env.SN_DOWNLOAD_DIR ?? ".auth/downloads",
  };
}
