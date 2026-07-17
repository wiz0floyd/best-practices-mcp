export const FETCH_TIMEOUT_MS = 30_000;

export interface Config {
  instanceUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    instanceUrl: env.SN_INSTANCE_URL ?? "https://mynow.servicenow.com",
  };
}
