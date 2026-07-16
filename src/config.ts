export interface Config {
  instanceUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    instanceUrl: env.SN_INSTANCE_URL ?? "https://mynow.servicenow.com",
  };
}
