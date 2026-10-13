/**
 * Safe mode: blocked operations are hidden from both catalogues (MCP tool
 * list and sevdesk_call operation list), refused on call, and refused once
 * more inside the HTTP client. Finalizing an invoice always needs
 * confirm_finalize: true.
 */
import { describe, expect, it } from "vitest";

import { catalog } from "../src/catalog.js";
import { SevdeskClient } from "../src/client.js";
import { loadConfig, type Config } from "../src/config.js";
import type { VatProfile } from "../src/lib/profile.js";
import {
  FinalizeConfirmationError,
  SafeModeError,
  finalizeIntent,
  isBlockedInSafeMode,
} from "../src/lib/safe-mode.js";
import type { ToolContext } from "../src/lib/tool.js";
import { listTools, tools, unavailableReason } from "../src/server.js";
import { auditTools } from "../src/tools/audit.js";
import { discoveryTools } from "../src/tools/discovery.js";
import { resourceTools } from "../src/tools/resources.js";

type Row = Record<string, unknown>;

const listOperations = discoveryTools.find((t) => t.name === "sevdesk_list_operations")!;
const describeOperation = discoveryTools.find((t) => t.name === "sevdesk_describe_operation")!;
const call = discoveryTools.find((t) => t.name === "sevdesk_call")!;
const createInvoice = resourceTools.find((t) => t.name === "sevdesk_create_invoice")!;
const markInvoiceSent = resourceTools.find((t) => t.name === "sevdesk_mark_invoice_sent")!;
const listTransactions = resourceTools.find((t) => t.name === "sevdesk_list_transactions")!;
const reconcile = auditTools.find((t) => t.name === "sevdesk_reconcile_transactions")!;

const BLOCKED_OPERATION_IDS = [
  "getCheckAccounts",
  "getCheckAccountById",
  "getBalanceAtDate",
  "createClearingAccount",
  "updateCheckAccount",
  "deleteCheckAccount",
  "getTransactions",
  "getCheckAccountTransactionById",
  "createTransaction",
  "updateCheckAccountTransaction",
  "checkAccountTransactionEnshrine",
  "deleteCheckAccountTransaction",
  "cancelInvoice",
  "sendInvoiceViaEMail",
  "bookInvoice",
  "bookVoucher",
  "voucherEnshrine",
  "deleteContact",
  "deleteOrder",
  "deleteTag",
  "deletecreditNote",
  "deleteCommunicationWay",
];

const ALLOWED_OPERATION_IDS = [
  "createInvoiceByFactory",
  "getInvoices",
  "invoiceSendBy",
  "invoiceRender",
  "invoiceResetToDraft",
  "voucherFactorySaveVoucher",
  "updateVoucher",
  "createContact",
  "updateContact",
  "getContacts",
];

function stubProfile(): VatProfile {
  return { regime: "regular", source: "env", evidence: "test stub", ledger: null };
}

/** A tool context around a recording fake client and a real loadConfig. */
function ctxWith(opts: {
  env?: Record<string, string>;
  respond?: (req: { method: string; path: string; body?: unknown; query?: Row }) => { status: number; data: unknown };
}) {
  const sent: Array<{ method: string; path: string; body?: unknown; query?: Row }> = [];
  const client = {
    async request(req: { method: string; path: string; body?: unknown; query?: Row }) {
      sent.push(req);
      return opts.respond?.(req) ?? { status: 200, data: { objects: [] } };
    },
    async getAll(path: string) {
      sent.push({ method: "GET", path });
      return [];
    },
  };
  const config = loadConfig({ SEVDESK_API_TOKEN: "t", ...opts.env });
  const ctx = { client, config, getProfile: async () => stubProfile() } as unknown as ToolContext;
  return { ctx, sent, config };
}

const SAFE = {};
const UNSAFE = { SEVDESK_SAFE_MODE: "false" };

describe("config", () => {
  it("defaults safe mode to ON", () => {
    expect(loadConfig({ SEVDESK_API_TOKEN: "t" }).safeMode).toBe(true);
  });
  it.each(["false", "0", "no", "off", "FALSE"])("SEVDESK_SAFE_MODE=%s switches it off", (v) => {
    expect(loadConfig({ SEVDESK_API_TOKEN: "t", SEVDESK_SAFE_MODE: v }).safeMode).toBe(false);
  });
  it.each(["true", "1", "yes", "", "maybe"])("SEVDESK_SAFE_MODE=%s keeps it on", (v) => {
    expect(loadConfig({ SEVDESK_API_TOKEN: "t", SEVDESK_SAFE_MODE: v }).safeMode).toBe(true);
  });
});

describe("policy", () => {
  const byId = new Map(catalog.operations.map((o) => [o.operationId, o]));

  it.each(BLOCKED_OPERATION_IDS)("blocks %s", (id) => {
    const op = byId.get(id);
    expect(op, `operation ${id} missing from catalogue`).toBeDefined();
    expect(isBlockedInSafeMode(op!)).toBe(true);
  });

  it.each(ALLOWED_OPERATION_IDS)("allows %s", (id) => {
    const op = byId.get(id);
    expect(op, `operation ${id} missing from catalogue`).toBeDefined();
    expect(isBlockedInSafeMode(op!)).toBe(false);
  });

  it("blocks every DELETE and every CheckAccount* operation in the catalogue", () => {
    for (const op of catalog.operations) {
      if (op.method === "DELETE" || op.path.startsWith("/CheckAccount")) {
        expect(isBlockedInSafeMode(op), op.operationId).toBe(true);
      }
    }
  });

  it("matches concrete paths as well as catalogue templates", () => {
    expect(isBlockedInSafeMode({ method: "PUT", path: "/Voucher/4711/enshrine" })).toBe(true);
    expect(isBlockedInSafeMode({ method: "POST", path: "/Invoice/12/cancelInvoice" })).toBe(true);
    expect(isBlockedInSafeMode({ method: "GET", path: "/CheckAccountTransaction?limit=5" })).toBe(true);
    expect(isBlockedInSafeMode({ method: "delete", path: "/Contact/1" })).toBe(true);
    expect(isBlockedInSafeMode({ method: "PUT", path: "/Voucher/4711" })).toBe(false);
    expect(isBlockedInSafeMode({ method: "PUT", path: "/Invoice/12/sendBy" })).toBe(false);
  });
});

describe("MCP tool list", () => {
  const blockedTools = tools.filter((t) => t.blockedInSafeMode).map((t) => t.name);

  it("marks exactly the bank-transaction tools as blocked", () => {
    expect(blockedTools.sort()).toEqual(
      ["sevdesk_list_transactions", "sevdesk_reconcile_transactions"].sort(),
    );
  });

  it("hides them in safe mode and refuses a direct call", () => {
    const { ctx } = ctxWith({ env: SAFE });
    const names = listTools(ctx).map((t) => t.name);
    expect(names).not.toContain("sevdesk_list_transactions");
    expect(names).not.toContain("sevdesk_reconcile_transactions");
    expect(names).toContain("sevdesk_create_invoice");
    expect(names).toContain("sevdesk_call");
    expect(unavailableReason(listTransactions, ctx)).toMatch(/safe mode/);
    expect(unavailableReason(reconcile, ctx)).toMatch(/safe mode/);
    expect(unavailableReason(createInvoice, ctx)).toBeUndefined();
  });

  it("lists them again with SEVDESK_SAFE_MODE=false", () => {
    const { ctx } = ctxWith({ env: UNSAFE });
    const names = listTools(ctx).map((t) => t.name);
    expect(names).toContain("sevdesk_list_transactions");
    expect(names).toContain("sevdesk_reconcile_transactions");
    expect(unavailableReason(listTransactions, ctx)).toBeUndefined();
  });

  it("keeps the read-only rule intact alongside safe mode", () => {
    const { ctx } = ctxWith({ env: { SEVDESK_READ_ONLY: "true" } });
    const names = listTools(ctx).map((t) => t.name);
    expect(names).not.toContain("sevdesk_create_invoice");
    expect(names).not.toContain("sevdesk_list_transactions");
    expect(names).toContain("sevdesk_call");
  });
});

describe("operation catalogue (sevdesk_list_operations / describe / call)", () => {
  it("does not list blocked operations in safe mode", async () => {
    const { ctx } = ctxWith({ env: SAFE });
    const all = (await listOperations.handler({ limit: 200 }, ctx)) as { matches: number; operations: string[] };
    const text = all.operations.join("\n");
    for (const id of BLOCKED_OPERATION_IDS) expect(text).not.toMatch(new RegExp(`\\b${id}\\b`));
    for (const id of ALLOWED_OPERATION_IDS) expect(text).toMatch(new RegExp(`\\b${id}\\b`));

    const bank = (await listOperations.handler({ tag: "CheckAccountTransaction" }, ctx)) as { matches: number; hint?: string };
    expect(bank.matches).toBe(0);
    expect(bank.hint).toMatch(/safe mode/i);

    const deletes = (await listOperations.handler({ query: "delete", limit: 200 }, ctx)) as { operations?: string[] };
    expect((deletes.operations ?? []).filter((l) => / DELETE /.test(l))).toEqual([]);
  });

  it("lists them with safe mode off", async () => {
    const { ctx } = ctxWith({ env: UNSAFE });
    const bank = (await listOperations.handler({ tag: "CheckAccountTransaction" }, ctx)) as { matches: number };
    expect(bank.matches).toBeGreaterThan(0);
    const all = (await listOperations.handler({ limit: 200 }, ctx)) as { matches: number };
    expect(all.matches).toBe(catalog.operationCount);
  });

  it.each(BLOCKED_OPERATION_IDS)("refuses to describe or call %s in safe mode", async (id) => {
    const { ctx, sent } = ctxWith({ env: SAFE });
    await expect(describeOperation.handler({ operationId: id }, ctx)).rejects.toBeInstanceOf(SafeModeError);
    await expect(
      call.handler({ operationId: id, params: { [anyPathParam(id)]: "1" } }, ctx),
    ).rejects.toBeInstanceOf(SafeModeError);
    // Not even as a dry run.
    await expect(
      call.handler({ operationId: id, params: { [anyPathParam(id)]: "1" }, dryRun: true }, ctx),
    ).rejects.toBeInstanceOf(SafeModeError);
    expect(sent).toEqual([]);
  });

  it("describes and calls a blocked operation once safe mode is off", async () => {
    const { ctx, sent } = ctxWith({ env: UNSAFE });
    await expect(describeOperation.handler({ operationId: "getCheckAccounts" }, ctx)).resolves.toMatch(/CheckAccount/);
    await call.handler({ operationId: "getCheckAccounts" }, ctx);
    expect(sent.map((s) => s.path)).toEqual(["/CheckAccount"]);
  });

  it("still serves allowed operations in safe mode", async () => {
    const { ctx, sent } = ctxWith({ env: SAFE });
    await call.handler({ operationId: "getInvoices" }, ctx);
    expect(sent.map((s) => s.path)).toEqual(["/Invoice"]);
  });
});

/** Path-parameter name of an operation, or a harmless key when it has none. */
function anyPathParam(operationId: string): string {
  const op = catalog.operations.find((o) => o.operationId === operationId)!;
  return op.params.find((p) => p.in === "path")?.name ?? "_";
}

describe("HTTP client (last line)", () => {
  function clientWith(env: Record<string, string>) {
    const calls: string[] = [];
    const fetchFn = (async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const config: Config = loadConfig({ SEVDESK_API_TOKEN: "t", SEVDESK_RATE_LIMIT: "0", ...env });
    return { client: new SevdeskClient(config, { fetchFn }), calls };
  }

  it.each([
    ["GET", "/CheckAccountTransaction"],
    ["GET", "/CheckAccount/5/getBalanceAtDate"],
    ["POST", "/Invoice/9/cancelInvoice"],
    ["POST", "/Invoice/9/sendViaEmail"],
    ["PUT", "/Invoice/9/bookAmount"],
    ["PUT", "/Voucher/9/bookAmount"],
    ["PUT", "/Voucher/9/enshrine"],
    ["DELETE", "/Contact/3"],
    ["DELETE", "/Tag/3"],
  ])("refuses %s %s before fetch in safe mode", async (method, path) => {
    const { client, calls } = clientWith(SAFE);
    await expect(client.request({ method, path })).rejects.toBeInstanceOf(SafeModeError);
    expect(calls).toEqual([]);
  });

  it("lets the same requests through with safe mode off", async () => {
    const { client, calls } = clientWith(UNSAFE);
    await client.request({ method: "GET", path: "/CheckAccountTransaction" });
    await client.request({ method: "DELETE", path: "/Tag/3" });
    expect(calls).toHaveLength(2);
  });

  it("does not touch ordinary requests in safe mode", async () => {
    const { client, calls } = clientWith(SAFE);
    await client.request({ method: "GET", path: "/Invoice" });
    await client.request({ method: "POST", path: "/Invoice/Factory/saveInvoice", body: {} });
    await client.request({ method: "PUT", path: "/Invoice/9/sendBy", body: {} });
    expect(calls).toHaveLength(3);
  });
});

describe("invoice finalization needs confirm_finalize: true", () => {
  const invoiceArgs = {
    contactId: "77",
    positions: [{ name: "Consulting", quantity: 2, price: 100, taxRate: 19 }],
  };
  const saved = (req: { path: string }) =>
    req.path === "/Invoice/Factory/saveInvoice"
      ? { status: 201, data: { objects: { invoice: { id: "900", invoiceNumber: null } } } }
      : { status: 200, data: { objects: [] } };

  it("sevdesk_create_invoice creates drafts (status 100) by default", async () => {
    const { ctx, sent } = ctxWith({ respond: saved });
    const out = (await createInvoice.handler(invoiceArgs, ctx)) as { status: string };
    expect((sent[0]!.body as { invoice: Row }).invoice.status).toBe("100");
    expect(out.status).toMatch(/draft/);
  });

  it("sevdesk_create_invoice refuses status 200 without confirmation", async () => {
    const { ctx, sent } = ctxWith({ respond: saved });
    await expect(createInvoice.handler({ ...invoiceArgs, status: "200" }, ctx)).rejects.toBeInstanceOf(
      FinalizeConfirmationError,
    );
    await expect(
      createInvoice.handler({ ...invoiceArgs, status: "200", confirm_finalize: "true" }, ctx),
    ).rejects.toBeInstanceOf(FinalizeConfirmationError);
    await expect(
      createInvoice.handler({ ...invoiceArgs, status: "200", confirm_finalize: false }, ctx),
    ).rejects.toBeInstanceOf(FinalizeConfirmationError);
    expect(sent).toEqual([]);
  });

  it("sevdesk_create_invoice finalizes with confirm_finalize: true", async () => {
    const { ctx, sent } = ctxWith({ respond: saved });
    const out = (await createInvoice.handler({ ...invoiceArgs, status: "200", confirm_finalize: true }, ctx)) as {
      status: string;
    };
    expect((sent[0]!.body as { invoice: Row }).invoice.status).toBe("200");
    expect(out.status).toMatch(/open/);
  });

  it("sevdesk_create_invoice rejects other statuses outright", async () => {
    const { ctx } = ctxWith({ respond: saved });
    await expect(createInvoice.handler({ ...invoiceArgs, status: "1000", confirm_finalize: true }, ctx)).rejects.toThrow(
      /not allowed/,
    );
  });

  it("the confirmation is required even with safe mode off", async () => {
    const { ctx } = ctxWith({ env: UNSAFE, respond: saved });
    await expect(createInvoice.handler({ ...invoiceArgs, status: "200" }, ctx)).rejects.toBeInstanceOf(
      FinalizeConfirmationError,
    );
  });

  it("sevdesk_mark_invoice_sent refuses to finalize a draft without confirmation", async () => {
    const draft = (req: { path: string }) =>
      req.path === "/Invoice/900"
        ? { status: 200, data: { objects: [{ id: "900", status: "100", enshrined: null, sendType: "VPDF" }] } }
        : { status: 200, data: {} };
    const { ctx, sent } = ctxWith({ respond: draft });
    await expect(markInvoiceSent.handler({ invoiceId: "900" }, ctx)).rejects.toBeInstanceOf(
      FinalizeConfirmationError,
    );
    expect(sent.filter((s) => s.method === "PUT")).toEqual([]);

    const ok = (await markInvoiceSent.handler({ invoiceId: "900", confirm_finalize: true }, ctx)) as { verified: boolean };
    expect(ok.verified).toBe(true);
  });

  it("sevdesk_mark_invoice_sent needs no confirmation for an already open invoice", async () => {
    const open = (req: { path: string }) =>
      req.path === "/Invoice/900"
        ? { status: 200, data: { objects: [{ id: "900", status: "200", enshrined: null, sendType: "VPR" }] } }
        : { status: 200, data: {} };
    const { ctx, sent } = ctxWith({ respond: open });
    await markInvoiceSent.handler({ invoiceId: "900", sendType: "VPR" }, ctx);
    expect(sent.filter((s) => s.method === "PUT")).toHaveLength(1);
  });

  it("sevdesk_call recognises finalizing payloads", () => {
    const factory = catalog.operations.find((o) => o.operationId === "createInvoiceByFactory")!;
    const sendBy = catalog.operations.find((o) => o.operationId === "invoiceSendBy")!;
    const email = catalog.operations.find((o) => o.operationId === "sendInvoiceViaEMail")!;
    expect(finalizeIntent(factory, { invoice: { status: "100" } })).toBeUndefined();
    expect(finalizeIntent(factory, { invoice: {} })).toBeUndefined();
    expect(finalizeIntent(factory, { invoice: { status: "200" } })).toMatch(/200/);
    expect(finalizeIntent(factory, { invoice: { status: 200 } })).toMatch(/200/);
    expect(finalizeIntent(factory, { invoice: { status: "1000" } })).toMatch(/1000/);
    expect(finalizeIntent(sendBy, { sendType: "VPDF", sendDraft: false })).toMatch(/finalizes/);
    expect(finalizeIntent(sendBy, { sendType: "VPDF", sendDraft: true })).toBeUndefined();
    expect(finalizeIntent(email, {})).toMatch(/finalizes/);
  });

  it("sevdesk_call refuses finalizing calls without confirmation and sends them with it", async () => {
    const { ctx, sent } = ctxWith({ respond: saved });
    const body = { invoice: { status: "200", contact: { id: 1 } }, invoicePosSave: [] };
    await expect(
      call.handler({ operationId: "createInvoiceByFactory", body }, ctx),
    ).rejects.toBeInstanceOf(FinalizeConfirmationError);
    await expect(
      call.handler({ operationId: "invoiceSendBy", params: { invoiceId: "9" }, body: { sendType: "VPDF", sendDraft: false } }, ctx),
    ).rejects.toBeInstanceOf(FinalizeConfirmationError);
    expect(sent).toEqual([]);

    // A draft payload needs nothing extra.
    await call.handler({ operationId: "createInvoiceByFactory", body: { invoice: { status: "100" } } }, ctx);
    // A dry run previews and points at the requirement.
    const preview = (await call.handler({ operationId: "createInvoiceByFactory", body, dryRun: true }, ctx)) as { note: string };
    expect(preview.note).toMatch(/confirm_finalize/);
    // The confirmed call goes through.
    await call.handler({ operationId: "createInvoiceByFactory", body, confirm_finalize: true }, ctx);
    expect(sent.map((s) => s.path)).toEqual(["/Invoice/Factory/saveInvoice", "/Invoice/Factory/saveInvoice"]);
  });
});
