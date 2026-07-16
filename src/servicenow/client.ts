import type { Config } from "../config.js";
import { createAuthStrategy, type AuthStrategy } from "./auth.js";

export class ServiceNowClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "ServiceNowClientError";
  }
}

export class ServiceNowClient {
  private readonly auth: AuthStrategy;

  constructor(private readonly config: Config) {
    this.auth = createAuthStrategy(config);
  }

  async getJson(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.config.instanceUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...this.auth.getAuthHeaders(),
      },
    });

    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.includes("application/json")) {
      throw new ServiceNowClientError(
        `Expected JSON but got "${contentType || "unknown content-type"}" (HTTP ${response.status}). ` +
          `This usually means the ${this.config.authMode} credentials were rejected and an SSO login page ` +
          `was returned instead of search results. Verify credentials with scripts/probe.ts.`,
        response.status
      );
    }

    if (!response.ok) {
      const body = await response.text();
      throw new ServiceNowClientError(
        `ServiceNow request failed with HTTP ${response.status}: ${body.slice(0, 500)}`,
        response.status
      );
    }

    return response.json();
  }
}
