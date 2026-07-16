import type { Config } from "../config.js";

export interface AuthStrategy {
  readonly mode: "bearer" | "basic" | "cookie";
  getAuthHeaders(): Record<string, string>;
}

class BearerAuthStrategy implements AuthStrategy {
  readonly mode = "bearer" as const;
  constructor(private readonly token: string) {}
  getAuthHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }
}

class BasicAuthStrategy implements AuthStrategy {
  readonly mode = "basic" as const;
  constructor(
    private readonly username: string,
    private readonly password: string
  ) {}
  getAuthHeaders(): Record<string, string> {
    const encoded = Buffer.from(`${this.username}:${this.password}`).toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }
}

class CookieAuthStrategy implements AuthStrategy {
  readonly mode = "cookie" as const;
  constructor(
    private readonly sessionCookie: string,
    private readonly userToken?: string
  ) {}
  getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = { Cookie: this.sessionCookie };
    if (this.userToken) {
      headers["X-UserToken"] = this.userToken;
    }
    return headers;
  }
}

export function createAuthStrategy(config: Config): AuthStrategy {
  switch (config.authMode) {
    case "bearer":
      return new BearerAuthStrategy(config.bearerToken);
    case "basic":
      return new BasicAuthStrategy(config.username, config.password);
    case "cookie":
      return new CookieAuthStrategy(config.sessionCookie, config.userToken);
  }
}
