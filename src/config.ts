/** Runtime configuration, read once at startup from the environment. */

import { ALLOWED_HOST, ALLOWED_PROTOCOL, assertAllowedUrl } from "./lib/host-guard.js";

export interface Config {
  apiToken: string;
  baseUrl: string;
  /** When true, every mutating operation is refused before it reaches the API. */
  readOnly: boolean;
  /** When true, mutating operations describe what they would send instead of sending it. */
  dryRun: boolean;
  /**
   * Safe mode (default ON): bank accounts, DELETE endpoints and the
   * cancel/email/book/enshrine operations are hidden and refused. Only
   * SEVDESK_SAFE_MODE=false switches it off. See lib/safe-mode.ts.
   */
  safeMode: boolean;
  /**
   * VAT regime the account lives under. `auto` (the default) infers it
   * from the ledger at first use; explicit values win outright.
   */
  vatRegime: "regular" | "kleinunternehmer" | "auto";
  /** Where vatRegime came from — `legacy-env` marks the deprecated boolean. */
  vatRegimeSource: "env" | "legacy-env" | "default";
  requestTimeoutMs: number;
  maxRetries: number;
  /**
   * Client-side request pacing in requests/second (token bucket), so bursty
   * fan-outs don't collide with sevDesk's throttle. 0 disables pacing.
   */
  rateLimitPerSec: number;
  /** Log method/path/status to stderr — never query strings, bodies or the token. */
  debug: boolean;
  /** Directories the audit tools are allowed to read receipt files from. */
  allowedReceiptDirs: string[];
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Fail-safe flag: only an explicit "false"-like value switches it OFF. An
 * empty string, a typo or any other value keeps the protection on.
 */
function explicitlyOff(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Like {@link int} but fractional and with an explicit 0 meaning "disabled". */
function rate(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const DEFAULT_BASE_URL = "https://my.sevdesk.de/api/v1";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiToken = env.SEVDESK_API_TOKEN?.trim();
  if (!apiToken) {
    throw new Error(
      "SEVDESK_API_TOKEN is not set.\n" +
        "Create a token in sevDesk under Settings -> Users -> your user -> API, " +
        "then put it in the `env` block of your MCP client configuration.",
    );
  }

  // SEVDESK_VAT_REGIME wins; the deprecated boolean applies only when it
  // is unset. A typo must fail loudly, not silently become `auto`.
  let vatRegime: Config["vatRegime"] = "auto";
  let vatRegimeSource: Config["vatRegimeSource"] = "default";
  const rawRegime = env.SEVDESK_VAT_REGIME?.trim().toLowerCase();
  if (rawRegime) {
    if (rawRegime === "regular" || rawRegime === "kleinunternehmer" || rawRegime === "auto") {
      vatRegime = rawRegime;
      vatRegimeSource = rawRegime === "auto" ? "default" : "env";
    } else {
      throw new Error(
        `SEVDESK_VAT_REGIME='${env.SEVDESK_VAT_REGIME}' is not valid. ` +
          `Use 'regular', 'kleinunternehmer' or 'auto'.`,
      );
    }
  } else if (bool(env.SEVDESK_KLEINUNTERNEHMER, false)) {
    vatRegime = "kleinunternehmer";
    vatRegimeSource = "legacy-env";
  }

  // The base URL may vary in path (API version), never in host: the token is
  // sent as a header to whatever this points at. Fail loudly at startup; the
  // HTTP client re-checks every request as the last line.
  const baseUrl = (env.SEVDESK_BASE_URL ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  try {
    assertAllowedUrl(baseUrl);
  } catch (err) {
    throw new Error(
      `SEVDESK_BASE_URL='${env.SEVDESK_BASE_URL}' is not allowed: ` +
        (err instanceof Error ? err.message : String(err)) +
        ` Only ${ALLOWED_PROTOCOL}//${ALLOWED_HOST} is permitted (default ${DEFAULT_BASE_URL}).`,
    );
  }

  return {
    apiToken,
    baseUrl,
    readOnly: bool(env.SEVDESK_READ_ONLY, false),
    dryRun: bool(env.SEVDESK_DRY_RUN, false),
    safeMode: !explicitlyOff(env.SEVDESK_SAFE_MODE),
    vatRegime,
    vatRegimeSource,
    requestTimeoutMs: int(env.SEVDESK_TIMEOUT_MS, 30_000),
    maxRetries: int(env.SEVDESK_MAX_RETRIES, 3),
    rateLimitPerSec: rate(env.SEVDESK_RATE_LIMIT, 4),
    debug: bool(env.SEVDESK_DEBUG, false),
    allowedReceiptDirs: (env.SEVDESK_RECEIPT_DIRS ?? "")
      .split(":")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export class ReadOnlyError extends Error {
  constructor(what: string) {
    super(
      `Refused: '${what}' would modify data in sevDesk, but the server runs with ` +
        `SEVDESK_READ_ONLY=true. Unset that variable to allow writes.`,
    );
    this.name = "ReadOnlyError";
  }
}
