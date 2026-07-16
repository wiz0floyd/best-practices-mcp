import { z } from "zod";

const configSchema = z.discriminatedUnion("authMode", [
  z.object({
    authMode: z.literal("bearer"),
    instanceUrl: z.string().url(),
    bearerToken: z.string().min(1),
  }),
  z.object({
    authMode: z.literal("basic"),
    instanceUrl: z.string().url(),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  z.object({
    authMode: z.literal("cookie"),
    instanceUrl: z.string().url(),
    sessionCookie: z.string().min(1),
    userToken: z.string().optional(),
  }),
]);

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authMode = env.SN_AUTH_MODE;
  const instanceUrl = env.SN_INSTANCE_URL ?? "https://mynow.servicenow.com";

  if (authMode !== "bearer" && authMode !== "basic" && authMode !== "cookie") {
    throw new Error(
      `SN_AUTH_MODE must be one of "bearer", "basic", or "cookie" (got: ${authMode ?? "unset"}).`
    );
  }

  const raw =
    authMode === "bearer"
      ? { authMode, instanceUrl, bearerToken: env.SN_BEARER_TOKEN ?? "" }
      : authMode === "basic"
        ? { authMode, instanceUrl, username: env.SN_USERNAME ?? "", password: env.SN_PASSWORD ?? "" }
        : {
            authMode,
            instanceUrl,
            sessionCookie: env.SN_SESSION_COOKIE ?? "",
            userToken: env.SN_USER_TOKEN,
          };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(
      `Invalid ServiceNow config for SN_AUTH_MODE=${authMode}. Missing/invalid: ${missing}. ` +
        `See .env.example for the required env vars per auth mode.`
    );
  }

  return result.data;
}
