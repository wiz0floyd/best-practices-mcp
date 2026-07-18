/**
 * Tracks the in-process, fire-and-forget headed login started by the servicenow_login MCP tool
 * (src/tools/login.ts). The tool call itself must return immediately — a human can take minutes
 * to complete SSO/MFA in the popped-up browser window — so the capture runs un-awaited and this
 * module is the only way anything later (servicenow_login_status) can see how it turned out.
 *
 * This in-memory state is advisory, not authoritative: it resets on server restart, and a session
 * captured the old way (`npm run login`, a separate process) never touches it at all. The one
 * fact that's always true regardless of how a session was captured is the auth state file on
 * disk, so servicenow_login_status reports that as the ground truth and layers this in only to
 * answer "is a capture running right now".
 */
import { existsSync, statSync } from "node:fs";
import type { Config } from "../config.js";
import { captureServiceNowSession } from "./login.js";

export type BackgroundLoginStatus = "idle" | "running" | "success" | "error";

interface BackgroundLoginState {
  status: BackgroundLoginStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

let state: BackgroundLoginState = { status: "idle" };

export function startBackgroundLogin(config: Config): BackgroundLoginState {
  if (state.status === "running") {
    return state;
  }

  state = { status: "running", startedAt: new Date().toISOString() };

  // Deliberately un-awaited (the caller — the MCP tool handler — must return right away), but
  // still fully handled: an unhandled rejection here (SSO timeout, browser launch failure, the
  // human closing the window) would otherwise crash the whole MCP server process.
  captureServiceNowSession(config)
    .then(() => {
      state = { ...state, status: "success", finishedAt: new Date().toISOString() };
    })
    .catch((err) => {
      state = {
        ...state,
        status: "error",
        finishedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      };
    });

  return state;
}

export interface LoginStatusReport {
  backgroundCapture: BackgroundLoginState;
  session: {
    path: string;
    exists: boolean;
    ageMinutes?: number;
  };
}

export function getLoginStatus(config: Config): LoginStatusReport {
  const exists = existsSync(config.authStatePath);
  return {
    backgroundCapture: state,
    session: {
      path: config.authStatePath,
      exists,
      ageMinutes: exists
        ? Math.round((Date.now() - statSync(config.authStatePath).mtimeMs) / 60_000)
        : undefined,
    },
  };
}
