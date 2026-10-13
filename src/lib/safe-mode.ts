/**
 * Safe mode — the operations an LLM operator may never reach, plus the one
 * step that needs an explicit human confirmation.
 *
 * On by default (`SEVDESK_SAFE_MODE` unset or truthy); only
 * `SEVDESK_SAFE_MODE=false` in the server's environment switches it off.
 * Like the read-only gate, it is enforced three times: tool listing (blocked
 * tools and catalogue operations are not advertised), tool dispatch (a stale
 * or hallucinated call is refused) and the HTTP client (the last line, on
 * the concrete request path).
 *
 * Blocked while safe mode is on:
 *   - everything under /CheckAccount and /CheckAccountTransaction (bank
 *     accounts and bank transactions, reads included);
 *   - every DELETE endpoint (contacts, credit notes, orders, tags, …);
 *   - Invoice cancelInvoice, sendViaEmail and bookAmount;
 *   - Voucher bookAmount (booking) and enshrine (Festschreibung).
 *
 * Independent of safe mode, any call that would finalize an invoice (draft
 * status 100 → open status 200, which assigns the invoice number and makes
 * the document legally binding) must carry `confirm_finalize: true`.
 */

export interface OperationRef {
  method: string;
  /** Catalogue template (`/Invoice/{invoiceId}/bookAmount`) or concrete path. */
  path: string;
}

const BLOCKED_PATHS: ReadonlyArray<{ test: RegExp; reason: string }> = [
  {
    test: /^\/CheckAccount/,
    reason: "bank accounts and bank transactions (CheckAccount*) are not accessible",
  },
  {
    test: /^\/Invoice\/[^/]+\/(cancelInvoice|sendViaEmail|bookAmount)$/,
    reason: "cancelling, emailing or booking payments on invoices is not allowed",
  },
  {
    test: /^\/Voucher\/[^/]+\/(bookAmount|enshrine)$/,
    reason: "booking or enshrining vouchers is not allowed",
  },
];

/** Why an operation is blocked in safe mode, or `undefined` when it is allowed. */
export function safeModeBlockReason(op: OperationRef): string | undefined {
  if (op.method.toUpperCase() === "DELETE") return "DELETE endpoints are not allowed";
  const path = op.path.split("?")[0] ?? "";
  for (const rule of BLOCKED_PATHS) {
    if (rule.test.test(path)) return rule.reason;
  }
  return undefined;
}

export function isBlockedInSafeMode(op: OperationRef): boolean {
  return safeModeBlockReason(op) !== undefined;
}

export class SafeModeError extends Error {
  constructor(what: string, reason: string) {
    super(
      `Refused: '${what}' is not available in safe mode — ${reason}. ` +
        `Safe mode is on by default and can only be switched off with SEVDESK_SAFE_MODE=false ` +
        `in the server's environment, not from a tool call.`,
    );
    this.name = "SafeModeError";
  }
}

/* ------------------------- invoice finalization ------------------------- */

/** sevDesk invoice statuses: 100 = Entwurf (draft), 200 = offen (finalized), 1000 = bezahlt. */
export const INVOICE_DRAFT_STATUS = "100";

/** True for any status that leaves the draft stage (200 open, 750, 1000 paid). */
export function isFinalizedInvoiceStatus(status: unknown): boolean {
  if (status === undefined || status === null || status === "") return false;
  const n = Number(status);
  return Number.isFinite(n) && n >= 200;
}

/**
 * Describe how a catalogue call would finalize an invoice, or `undefined`
 * when it cannot. Used by sevdesk_call, which sees only operationId + body.
 */
export function finalizeIntent(
  op: { operationId: string; method: string; path: string },
  body: unknown,
): string | undefined {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const path = op.path;

  if (op.operationId === "createInvoiceByFactory" || path === "/Invoice/Factory/saveInvoice") {
    const invoice = (b.invoice && typeof b.invoice === "object" ? b.invoice : {}) as Record<string, unknown>;
    if (isFinalizedInvoiceStatus(invoice.status)) {
      return `saves the invoice with status ${String(invoice.status)} instead of as a draft (100)`;
    }
    return undefined;
  }
  if (/^\/Invoice\/[^/]+\/sendBy$/.test(path)) {
    if (b.sendDraft === true) return undefined;
    return "marks the invoice as sent, which finalizes a draft (status 100 → 200)";
  }
  if (/^\/Invoice\/[^/]+\/sendViaEmail$/.test(path)) {
    return "emails the invoice, which finalizes a draft (status 100 → 200)";
  }
  return undefined;
}

export class FinalizeConfirmationError extends Error {
  constructor(intent: string) {
    super(
      `Refused: this call ${intent}. Finalizing an invoice assigns the invoice number and ` +
        `makes the document legally binding — it cannot be undone from here. Ask the user, ` +
        `then repeat the call with confirm_finalize: true.`,
    );
    this.name = "FinalizeConfirmationError";
  }
}

/** Throw unless the caller passed the literal boolean `confirm_finalize: true`. */
export function requireFinalizeConfirmation(args: Record<string, unknown>, intent: string): void {
  if (args.confirm_finalize !== true) throw new FinalizeConfirmationError(intent);
}

/** Schema snippet shared by every tool that can finalize an invoice. */
export const CONFIRM_FINALIZE_SCHEMA = {
  type: "boolean",
  description:
    "Required (literally true) for any call that finalizes an invoice — draft 100 → open 200: " +
    "the invoice number is assigned and the document becomes legally binding. Only pass it " +
    "after the user explicitly confirmed.",
} as const;
