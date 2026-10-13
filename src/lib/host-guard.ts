/**
 * Outbound host allowlist — the one place that decides where a request may go.
 *
 * sevDesk API tokens have no scopes: whoever receives the `Authorization`
 * header can do everything the account owner can. The only way this server
 * could leak the token is by sending it somewhere other than sevDesk, and the
 * only knob that could make it do so is the base URL. So the rule is
 * deliberately rigid: every request must target `https://my.sevdesk.de`,
 * exactly, on the default port, with no credentials in the URL.
 *
 * There is intentionally no environment variable, config flag or constructor
 * option that relaxes this. Changing the host means changing this file.
 */

export const ALLOWED_PROTOCOL = "https:";
export const ALLOWED_HOST = "my.sevdesk.de";

export class HostNotAllowedError extends Error {
  constructor(readonly url: string, reason: string) {
    super(
      `Refused: outbound request to '${redact(url)}' blocked — ${reason}. ` +
        `This server only talks to ${ALLOWED_PROTOCOL}//${ALLOWED_HOST}.`,
    );
    this.name = "HostNotAllowedError";
  }
}

/** Strip query and credentials before a URL lands in an error message. */
function redact(raw: string): string {
  try {
    const u = new URL(raw);
    u.search = "";
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return raw.slice(0, 120);
  }
}

/**
 * Validate an absolute URL against the allowlist. Returns the parsed URL on
 * success and throws {@link HostNotAllowedError} otherwise. Hostname matching
 * is exact and case-insensitive (URL parsing lowercases it), so
 * `my.sevdesk.de.evil.example` or `evil.example/my.sevdesk.de` never pass.
 */
export function assertAllowedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HostNotAllowedError(raw, "not an absolute URL");
  }
  if (url.protocol !== ALLOWED_PROTOCOL) {
    throw new HostNotAllowedError(raw, `protocol '${url.protocol}' is not ${ALLOWED_PROTOCOL}`);
  }
  if (url.hostname !== ALLOWED_HOST) {
    throw new HostNotAllowedError(raw, `host '${url.hostname}' is not ${ALLOWED_HOST}`);
  }
  if (url.port !== "") {
    throw new HostNotAllowedError(raw, `non-default port '${url.port}'`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new HostNotAllowedError(raw, "credentials in the URL");
  }
  return url;
}
