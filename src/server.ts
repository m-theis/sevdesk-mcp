import { Server } from "@modelcontextprotocol/server";

import type { ToolContext, ToolDef } from "./lib/tool.js";
import { auditTools } from "./tools/audit.js";
import { discoveryTools } from "./tools/discovery.js";
import { resourceTools } from "./tools/resources.js";

export const VERSION = "0.4.0";

/** Every tool the server exposes, in listing order. */
export const tools: ToolDef[] = [...resourceTools, ...auditTools, ...discoveryTools];

/**
 * Why a tool is unavailable under the current config, or `undefined` when it
 * is callable. One rule for both the listing filter and the dispatch gate, so
 * a stale tool list can never reach a handler the listing would have hidden.
 */
export function unavailableReason(tool: ToolDef, ctx: ToolContext): string | undefined {
  if (ctx.config.safeMode && tool.blockedInSafeMode) {
    return (
      `Refused: '${tool.name}' is not available in safe mode. Safe mode is on by default ` +
      `and can only be switched off with SEVDESK_SAFE_MODE=false in the server's environment.`
    );
  }
  if (ctx.config.readOnly && tool.mutating && !tool.listInReadOnly) {
    return `Refused: '${tool.name}' modifies data in sevDesk, but the server runs with SEVDESK_READ_ONLY=true.`;
  }
  return undefined;
}

/** The tool list as advertised to the client for this configuration. */
export function listTools(ctx: ToolContext) {
  return tools
    .filter((t) => unavailableReason(t, ctx) === undefined)
    .map((t) => ({
      name: t.name,
      title: t.title,
      description:
        t.description +
        (t.mutating && !ctx.config.readOnly ? " ⚠️ This tool can change data in sevDesk." : ""),
      inputSchema: t.inputSchema,
      // Standard MCP hints so clients can shape confirmation UX. Writes are
      // never destructive here: they create drafts or flip reversible flags.
      annotations: {
        readOnlyHint: !t.mutating,
        destructiveHint: false,
        openWorldHint: true,
      },
    }));
}

/**
 * Assemble the MCP server: tool listing and dispatch. Transport-agnostic —
 * the stdio entry point (index.ts) connects it to stdin/stdout, and a hosted
 * variant can connect the same server to an HTTP transport.
 */
export function buildServer(ctx: ToolContext): Server {
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "sevdesk-mcp", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        `sevDesk accounting (German SMB bookkeeping) for AI agents. ` +
        `Mode: ${ctx.config.readOnly ? "READ-ONLY — write tools are hidden" : ctx.config.dryRun ? "DRY-RUN — writes preview instead of sending" : "read/write — writes create drafts only"}. ` +
        (ctx.config.safeMode
          ? `Safe mode is ON: bank accounts/transactions, DELETE operations, invoice cancel/email/bookAmount ` +
            `and voucher book/enshrine are hidden and refused. `
          : `Safe mode is OFF. `) +
        `Finalizing an invoice (draft 100 → open 200) always requires confirm_finalize: true after the user agreed. ` +
        `Start with sevdesk_ping: it verifies the token and reports the account's ` +
        `bookkeeping generation and detected VAT regime (regular vs §19 Kleinunternehmer) ` +
        `with evidence — tax defaults and audit advice follow that regime. ` +
        `Prefer the curated sevdesk_* tools; for anything else use sevdesk_call (reads) or sevdesk_call_write (writes) after ` +
        `sevdesk_list_operations / sevdesk_describe_operation. Every write accepts ` +
        `dryRun:true for a preview. Dates are yyyy-mm-dd; amounts EUR unless stated.`,
      // The tool list is fixed for the lifetime of the process (read-only and
      // safe-mode filtering depend only on startup config), so 2026-era
      // clients may cache it. Private: the listing varies with this
      // deployment's config.
      cacheHints: { "tools/list": { ttlMs: 3_600_000, cacheScope: "private" } },
    },
  );

  server.setRequestHandler("tools/list", async () => ({ tools: listTools(ctx) }));

  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const tool = byName.get(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
      };
    }

    // Same rule as the listing filter — a hidden tool is also refused here.
    // The HTTP client refuses blocked paths and writes independently as the
    // last line.
    const refusal = unavailableReason(tool, ctx);
    if (refusal) {
      return { isError: true, content: [{ type: "text" as const, text: refusal }] };
    }

    try {
      const result = await tool.handler((rawArgs ?? {}) as Record<string, unknown>, ctx);
      const text =
        typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      };
    }
  });

  return server;
}
