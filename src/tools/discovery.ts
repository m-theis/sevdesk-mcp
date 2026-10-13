import {
  type Operation,
  briefOperation,
  catalog,
  describeOperation,
  findOperation,
  searchOperations,
} from "../catalog.js";
import { SevdeskClient } from "../client.js";
import { ReadOnlyError } from "../config.js";
import {
  CONFIRM_FINALIZE_SCHEMA,
  SafeModeError,
  finalizeIntent,
  isBlockedInSafeMode,
  requireFinalizeConfirmation,
  safeModeBlockReason,
} from "../lib/safe-mode.js";
import { bool, isDryRun, obj, optNumber, optString, requireString, str, type ToolContext, type ToolDef } from "../lib/tool.js";

/**
 * Three tools that together expose the *entire* sevDesk API.
 *
 * Registering 151 individual tools would swamp the client's tool list and most
 * of them would never be used. Discovery + a validated generic caller gives
 * complete coverage at a fraction of the context cost.
 */

const listOperations: ToolDef = {
  name: "sevdesk_list_operations",
  title: "List sevDesk API operations",
  description:
    `Search the sevDesk API catalogue (${catalog.operationCount} operations, ` +
    `API ${catalog.apiVersion}) for the operationId of anything not covered by a ` +
    `dedicated tool. Available tags: ${catalog.tags.join(", ")}.`,
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      query: str("Free-text search over operationId, path, tags and summary, e.g. 'voucher pdf'."),
      tag: str("Restrict to one resource tag, e.g. 'Voucher' or 'Invoice'.", {
        enum: catalog.tags,
      }),
      kind: str("Filter by effect: read (GET), write (POST/PUT/DELETE), or all.", {
        enum: ["read", "write", "all"],
      }),
      limit: { type: "integer", description: "Maximum results (default 60).", minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const kindRaw = optString(args, "kind");
    const kind = kindRaw === "read" || kindRaw === "write" ? kindRaw : "all";
    const ops = searchOperations({
      query: optString(args, "query"),
      tag: optString(args, "tag"),
      kind,
      limit: optNumber(args, "limit") ?? 60,
      exclude: hiddenInSafeMode(ctx),
    });
    if (ops.length === 0) {
      return {
        matches: 0,
        hint:
          `No operation matched. Known tags: ${catalog.tags.join(", ")}` +
          (ctx.config.safeMode
            ? ". Safe mode is on: CheckAccount*, DELETE and invoice cancel/email/book, voucher book/enshrine operations are not listed."
            : ""),
      };
    }
    return {
      matches: ops.length,
      operations: ops.map(briefOperation),
    };
  },
};

const describeOperationTool: ToolDef = {
  name: "sevdesk_describe_operation",
  title: "Describe a sevDesk API operation",
  description:
    "Show the full parameter list, request-body shape and an example call for one " +
    "operationId. Always do this before sevdesk_call on an operation you have not used before.",
  mutating: false,
  inputSchema: {
    type: "object",
    properties: {
      operationId: str("Exact operationId, as returned by sevdesk_list_operations."),
    },
    required: ["operationId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = requireString(args, "operationId");
    const op = findOperation(id);
    if (!op) {
      const near = searchOperations({ query: id, limit: 8, exclude: hiddenInSafeMode(ctx) }).map(
        (o) => o.operationId,
      );
      throw new Error(
        `Unknown operationId '${id}'.` + (near.length ? ` Did you mean: ${near.join(", ")}?` : ""),
      );
    }
    assertAllowedInSafeMode(op, ctx);
    return describeOperation(op);
  },
};

const callOperation: ToolDef = {
  name: "sevdesk_call",
  title: "Call any sevDesk API operation",
  description:
    "Execute any operation from the catalogue. Path parameters are taken from `params` " +
    "by name; remaining `params` entries become query parameters. Nested objects are " +
    "encoded in sevDesk's bracket syntax (a[b]=c). Mutating operations are refused when " +
    "the server runs with SEVDESK_READ_ONLY=true, and are only described (not sent) when " +
    "SEVDESK_DRY_RUN=true or `dryRun` is passed. In safe mode (default) bank-account, DELETE, " +
    "invoice cancel/email/bookAmount and voucher book/enshrine operations are refused. Calls " +
    "that finalize an invoice (status 100 → 200) require confirm_finalize: true.",
  mutating: true, // conservatively declared; the handler checks per operation
  listInReadOnly: true, // covers reads too — writes are refused per call below
  inputSchema: {
    type: "object",
    properties: {
      operationId: str("Exact operationId from sevdesk_list_operations."),
      params: obj("Path and query parameters, keyed by parameter name."),
      body: obj("JSON request body, for POST/PUT operations."),
      dryRun: bool("Describe the request that would be sent instead of sending it."),
      confirm_finalize: CONFIRM_FINALIZE_SCHEMA,
    },
    required: ["operationId"],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const id = requireString(args, "operationId");
    const op = findOperation(id);
    if (!op) {
      const near = searchOperations({ query: id, limit: 8, exclude: hiddenInSafeMode(ctx) }).map(
        (o) => o.operationId,
      );
      throw new Error(
        `Unknown operationId '${id}'.` + (near.length ? ` Did you mean: ${near.join(", ")}?` : ""),
      );
    }
    // Safe mode first — a blocked operation is refused even as a dry run.
    assertAllowedInSafeMode(op, ctx);

    const params = (args.params ?? {}) as Record<string, unknown>;
    const body = args.body;

    if (op.mutating && ctx.config.readOnly) throw new ReadOnlyError(op.operationId);

    // Finalizing an invoice needs the user's explicit go-ahead. A dry run
    // sends nothing, so it may preview without it — and says so.
    const finalizing = finalizeIntent(op, body);
    const dry = isDryRun(args, ctx) && op.mutating;
    if (finalizing && !dry) requireFinalizeConfirmation(args, finalizing);

    const pathParamNames = new Set(
      op.params.filter((p) => p.in === "path").map((p) => p.name),
    );
    const missing = [...pathParamNames].filter(
      (n) => params[n] === undefined || params[n] === null || params[n] === "",
    );
    if (missing.length) {
      throw new Error(
        `Missing path parameter(s) ${missing.join(", ")} for ${op.operationId}. ` +
          `Run sevdesk_describe_operation for the full signature.`,
      );
    }

    const filledPath = SevdeskClient.fillPath(op.path, params);
    const query: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (!pathParamNames.has(k)) query[k] = v;
    }

    if (dry) {
      return {
        dryRun: true,
        wouldSend: {
          method: op.method,
          url: `${ctx.config.baseUrl}${filledPath}`,
          query,
          body: body ?? null,
        },
        note:
          "Nothing was sent. Call again without dryRun to execute." +
          (finalizing ? ` The real call ${finalizing} and requires confirm_finalize: true.` : ""),
      };
    }

    const result = await ctx.client.request({
      method: op.method,
      path: filledPath,
      query: Object.keys(query).length ? query : undefined,
      body,
      mutating: op.mutating,
    });
    return { status: result.status, data: result.data };
  },
};

/** Search filter: in safe mode, blocked operations do not exist for the caller. */
function hiddenInSafeMode(ctx: ToolContext): ((op: Operation) => boolean) | undefined {
  return ctx.config.safeMode ? (op) => isBlockedInSafeMode(op) : undefined;
}

function assertAllowedInSafeMode(op: Operation, ctx: ToolContext): void {
  if (!ctx.config.safeMode) return;
  const reason = safeModeBlockReason(op);
  if (reason) throw new SafeModeError(op.operationId, reason);
}

export const discoveryTools: ToolDef[] = [
  listOperations,
  describeOperationTool,
  callOperation,
];
