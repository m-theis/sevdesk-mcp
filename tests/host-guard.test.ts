/**
 * Outbound host allowlist: the token must never leave towards anything but
 * https://my.sevdesk.de. Checked at three layers — the guard itself, the
 * config loader (startup) and the HTTP client (per request).
 */
import { describe, expect, it } from "vitest";

import { SevdeskClient } from "../src/client.js";
import { loadConfig, type Config } from "../src/config.js";
import { ALLOWED_HOST, HostNotAllowedError, assertAllowedUrl } from "../src/lib/host-guard.js";

const FOREIGN_URLS = [
  "http://my.sevdesk.de/api/v1", // plain http
  "https://my.sevdesk.de:8443/api/v1", // non-default port
  "https://api.sevdesk.de/api/v1", // sibling host
  "https://sevdesk.de/api/v1", // apex
  "https://my.sevdesk.de.evil.example/api/v1", // suffix spoof
  "https://evil.example/my.sevdesk.de/api/v1", // host in path
  "https://my.sevdesk.de@evil.example/api/v1", // host in userinfo
  "https://user:pw@my.sevdesk.de/api/v1", // credentials in URL
  "https://127.0.0.1/api/v1",
  "https://localhost/api/v1",
  "ftp://my.sevdesk.de/api/v1",
  "my.sevdesk.de/api/v1", // relative
  "",
];

describe("assertAllowedUrl", () => {
  it("accepts the default sevDesk endpoint and other paths on the same host", () => {
    expect(assertAllowedUrl("https://my.sevdesk.de/api/v1").hostname).toBe(ALLOWED_HOST);
    expect(assertAllowedUrl("https://my.sevdesk.de/api/v1/Invoice?limit=1").pathname).toBe(
      "/api/v1/Invoice",
    );
    expect(assertAllowedUrl("https://MY.SEVDESK.DE/api/v2").hostname).toBe(ALLOWED_HOST);
    expect(assertAllowedUrl("https://my.sevdesk.de:443/api/v1").port).toBe("");
  });

  it.each(FOREIGN_URLS)("rejects %s", (url) => {
    expect(() => assertAllowedUrl(url)).toThrow(HostNotAllowedError);
  });

  it("does not echo query strings or credentials in the error message", () => {
    const err = (() => {
      try {
        assertAllowedUrl("https://user:secret@evil.example/x?token=abc");
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(HostNotAllowedError);
    expect(err!.message).not.toContain("secret");
    expect(err!.message).not.toContain("token=abc");
  });
});

describe("loadConfig", () => {
  it("defaults to https://my.sevdesk.de/api/v1", () => {
    expect(loadConfig({ SEVDESK_API_TOKEN: "t" }).baseUrl).toBe("https://my.sevdesk.de/api/v1");
  });

  it("allows a different path on the allowed host", () => {
    expect(loadConfig({ SEVDESK_API_TOKEN: "t", SEVDESK_BASE_URL: "https://my.sevdesk.de/api/v2/" }).baseUrl).toBe(
      "https://my.sevdesk.de/api/v2",
    );
  });

  it.each(FOREIGN_URLS.filter(Boolean))("refuses to start with SEVDESK_BASE_URL=%s", (url) => {
    expect(() => loadConfig({ SEVDESK_API_TOKEN: "t", SEVDESK_BASE_URL: url })).toThrow(
      /SEVDESK_BASE_URL.*not allowed/,
    );
  });

  it("cannot be relaxed through the environment", () => {
    // No such switch exists; this pins the requirement so one is never added.
    const relaxers = {
      SEVDESK_ALLOW_ANY_HOST: "true",
      SEVDESK_ALLOWED_HOSTS: "evil.example",
      SEVDESK_HOST_GUARD: "off",
      SEVDESK_INSECURE: "1",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    };
    expect(() =>
      loadConfig({ SEVDESK_API_TOKEN: "t", SEVDESK_BASE_URL: "https://evil.example/api/v1", ...relaxers }),
    ).toThrow(/not allowed/);
  });
});

describe("SevdeskClient", () => {
  /** Build a client around a hand-made Config so the loader's check is bypassed. */
  function clientWith(baseUrl: string) {
    const calls: string[] = [];
    const fetchFn = (async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const config: Config = {
      ...loadConfig({ SEVDESK_API_TOKEN: "t", SEVDESK_RATE_LIMIT: "0" }),
      baseUrl,
    };
    return { client: new SevdeskClient(config, { fetchFn }), calls };
  }

  it("sends to the allowed host", async () => {
    const { client, calls } = clientWith("https://my.sevdesk.de/api/v1");
    await client.request({ method: "GET", path: "/Voucher", query: { limit: 1 } });
    expect(calls).toEqual(["https://my.sevdesk.de/api/v1/Voucher?limit=1"]);
  });

  it.each(FOREIGN_URLS.filter(Boolean))(
    "never calls fetch when the config was tampered to %s",
    async (baseUrl) => {
      const { client, calls } = clientWith(baseUrl);
      await expect(client.request({ method: "GET", path: "/Voucher" })).rejects.toBeInstanceOf(
        HostNotAllowedError,
      );
      await expect(
        client.request({ method: "POST", path: "/Invoice/Factory/saveInvoice", body: {} }),
      ).rejects.toBeInstanceOf(HostNotAllowedError);
      expect(calls).toEqual([]);
    },
  );

  it("blocks before the read-only gate would matter and before any retry", async () => {
    const { client, calls } = clientWith("https://evil.example/api/v1");
    await expect(client.getAll("/Voucher")).rejects.toBeInstanceOf(HostNotAllowedError);
    expect(calls).toEqual([]);
  });
});
