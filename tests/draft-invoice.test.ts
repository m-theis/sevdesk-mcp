/**
 * sevdesk_draft_invoice: the strict one-call invoice draft. Every field a
 * correct invoice needs is mandatory, the result is always a draft, and the
 * answer carries sums and the service period.
 */
import { describe, expect, it } from "vitest";

import type { VatProfile } from "../src/lib/profile.js";
import type { ToolContext } from "../src/lib/tool.js";
import { resourceTools } from "../src/tools/resources.js";

type Row = Record<string, unknown>;
const draftInvoice = resourceTools.find((t) => t.name === "sevdesk_draft_invoice")!;

function stubProfile(): VatProfile {
  return { regime: "regular", source: "env", evidence: "test stub", ledger: null };
}

function ctxWith(
  opts: { dryRun?: boolean; unityFails?: boolean; created?: Row; users?: Row[] | "fail" } = {},
) {
  const sent: Array<{ method: string; path: string; body?: unknown }> = [];
  const client = {
    async getAll(path: string): Promise<Row[]> {
      if (path === "/SevUser") {
        if (opts.users === "fail") throw new Error("sevDesk API 500 on GET /SevUser");
        return opts.users ?? [{ id: "1340649", fullname: "Moritz Theis" }];
      }
      if (path === "/Unity") {
        if (opts.unityFails) throw new Error("sevDesk API 404 on GET /Unity");
        return [
          { id: "1", name: "Stück", translationCode: "UNITY_PIECE" },
          { id: "9", name: "Std", translationCode: "UNITY_HOUR" },
          { id: "7", name: "Pauschal", translationCode: "UNITY_FLAT" },
        ];
      }
      return [];
    },
    async request(req: { method: string; path: string; body?: unknown }) {
      sent.push(req);
      if (req.path === "/Invoice/Factory/saveInvoice") {
        return {
          status: 201,
          data: { objects: { invoice: opts.created ?? { id: "4711", invoiceNumber: null, sumNet: "300", sumGross: "357" } } },
        };
      }
      return { status: 200, data: {} };
    },
  };
  const ctx = {
    client,
    config: { readOnly: false, dryRun: opts.dryRun ?? false, safeMode: true, allowedReceiptDirs: [] },
    getProfile: async () => stubProfile(),
  } as unknown as ToolContext;
  return { ctx, sent };
}

const valid = {
  contactId: "77",
  invoiceDate: "2026-10-13",
  deliveryDate: "2026-09-01",
  deliveryDateUntil: "2026-09-30",
  taxRule: "1",
  positions: [
    { name: "Beratung", text: "Workshop-Vorbereitung", quantity: 2, unity: "Std", price: 100, taxRate: 19 },
    { name: "Pauschale", text: "", quantity: 1, unity: 7, price: 100, taxRate: 19 },
  ],
};

describe("sevdesk_draft_invoice", () => {
  it("is listed as a mutating tool and requires the complete field set", () => {
    expect(draftInvoice.mutating).toBe(true);
    expect(draftInvoice.inputSchema.required).toEqual([
      "contactId",
      "invoiceDate",
      "deliveryDate",
      "deliveryDateUntil",
      "taxRule",
      "positions",
    ]);
    const pos = (draftInvoice.inputSchema.properties.positions as { items: { required: string[] } }).items;
    expect(pos.required).toEqual(["name", "text", "quantity", "unity", "price", "taxRate"]);
  });

  it("creates a draft with period, texts, units and returns sums", async () => {
    const { ctx, sent } = ctxWith();
    const out = (await draftInvoice.handler(
      {
        ...valid,
        header: "Rechnung September",
        headText: "Vielen Dank für Ihren Auftrag.",
        footText: "Zahlbar innerhalb von 14 Tagen.",
        customerInternalNote: "Projekt X",
        paymentTerms: 14,
      },
      ctx,
    )) as Row;

    expect(sent.map((s) => s.path)).toEqual(["/Invoice/Factory/saveInvoice"]);
    const body = sent[0]!.body as {
      invoice: Row;
      invoicePosSave: Row[];
      takeDefaultAddress: boolean;
    };
    expect(body.invoice).toMatchObject({
      status: "100",
      invoiceType: "RE",
      contactPerson: { id: 1340649, objectName: "SevUser" }, // the account's only user
      invoiceDate: "2026-10-13",
      deliveryDate: "2026-09-01",
      deliveryDateUntil: "2026-09-30",
      contact: { id: 77, objectName: "Contact" },
      taxRule: { id: "1", objectName: "TaxRule" },
      header: "Rechnung September",
      headText: "Vielen Dank für Ihren Auftrag.",
      footText: "Zahlbar innerhalb von 14 Tagen.",
      customerInternalNote: "Projekt X",
      timeToPay: 14,
      taxText: "Umsatzsteuer 19%",
    });
    expect(body.invoicePosSave).toHaveLength(2);
    expect(body.invoicePosSave[0]).toMatchObject({
      objectName: "InvoicePos",
      positionNumber: 0,
      name: "Beratung",
      text: "Workshop-Vorbereitung",
      quantity: 2,
      price: 100,
      taxRate: 19,
      unity: { id: 9, objectName: "Unity" }, // "Std" resolved via /Unity
    });
    expect(body.invoicePosSave[1]).toMatchObject({ unity: { id: 7, objectName: "Unity" }, text: "" });
    expect(body.takeDefaultAddress).toBe(true);

    expect(out).toMatchObject({
      invoiceId: "4711",
      invoiceNumber: null,
      sumNet: 300,
      sumTax: 57,
      sumGross: 357,
      currency: "EUR",
      servicePeriod: { deliveryDate: "2026-09-01", deliveryDateUntil: "2026-09-30" },
      positions: 2,
    });
    expect(String(out.status)).toMatch(/draft/);
  });

  it("falls back to its own sums when the API returns none", async () => {
    const { ctx } = ctxWith({ created: { id: "1" } });
    const out = (await draftInvoice.handler(valid, ctx)) as Row;
    expect(out).toMatchObject({ sumNet: 300, sumTax: 57, sumGross: 357 });
  });

  it("previews with expected sums under dryRun and sends nothing", async () => {
    const { ctx, sent } = ctxWith({ dryRun: true });
    const out = (await draftInvoice.handler(valid, ctx)) as { dryRun: boolean; expected: Row };
    expect(out.dryRun).toBe(true);
    expect(out.expected).toMatchObject({ sumNet: 300, sumGross: 357, positions: 2 });
    expect(sent.filter((s) => s.method === "POST")).toEqual([]);
  });

  it.each([
    ["contactId", undefined, /contactId/],
    ["contactId", "abc", /numeric/],
    ["invoiceDate", undefined, /invoiceDate/],
    ["invoiceDate", "13.10.2026", /yyyy-mm-dd/],
    ["deliveryDate", undefined, /deliveryDate/],
    ["deliveryDateUntil", undefined, /deliveryDateUntil/],
    ["deliveryDateUntil", "2026-08-31", /before/],
    ["deliveryDate", "2026-02-30", /valid date/],
    ["taxRule", undefined, /taxRule/],
    ["taxRule", "12", /not a usable invoice revenue rule/],
    ["positions", [], /At least one position/],
  ])("rejects a missing or invalid %s", async (key, value, pattern) => {
    const { ctx, sent } = ctxWith();
    const args: Row = { ...valid, [key]: value };
    if (value === undefined) delete args[key];
    await expect(draftInvoice.handler(args, ctx)).rejects.toThrow(pattern);
    expect(sent).toEqual([]);
  });

  it.each([
    ["name", "", /name/],
    ["text", undefined, /text/],
    ["quantity", 0, /quantity/],
    ["quantity", undefined, /quantity/],
    ["unity", undefined, /unity/],
    ["unity", "Karton", /unknown unity .*Known units/],
    ["price", "100", /price/],
    ["price", undefined, /price/],
    ["taxRate", undefined, /taxRate/],
    ["taxRate", 16, /not allowed with tax rule 1/],
  ])("rejects a position with bad %s", async (key, value, pattern) => {
    const { ctx, sent } = ctxWith();
    const pos: Row = { ...valid.positions[0]!, [key]: value };
    if (value === undefined) delete pos[key];
    await expect(draftInvoice.handler({ ...valid, positions: [pos] }, ctx)).rejects.toThrow(pattern);
    expect(sent).toEqual([]);
  });

  it("still accepts numeric unity ids when /Unity is unavailable, but not names", async () => {
    const { ctx, sent } = ctxWith({ unityFails: true });
    await expect(
      draftInvoice.handler({ ...valid, positions: [{ ...valid.positions[0]!, unity: "Std" }] }, ctx),
    ).rejects.toThrow(/GET \/Unity failed.*numeric Unity id/);
    expect(sent).toEqual([]);
    await draftInvoice.handler({ ...valid, positions: [{ ...valid.positions[0]!, unity: 9 }] }, ctx);
    expect(sent).toHaveLength(1);
  });

  describe("contact person (SevUser)", () => {
    it("uses an explicit contactPersonId without looking users up", async () => {
      const { ctx, sent } = ctxWith({ users: "fail" });
      await draftInvoice.handler({ ...valid, contactPersonId: "42" }, ctx);
      expect((sent[0]!.body as { invoice: Row }).invoice.contactPerson).toEqual({ id: 42, objectName: "SevUser" });
    });

    it("demands a choice when the account has several users, naming them", async () => {
      const { ctx, sent } = ctxWith({
        users: [
          { id: "1", fullname: "Anna Admin" },
          { id: "2", fullname: "Ben Buchhaltung" },
        ],
      });
      await expect(draftInvoice.handler(valid, ctx)).rejects.toThrow(
        /2 users.*contactPersonId.*Anna Admin \(1\), Ben Buchhaltung \(2\)/,
      );
      expect(sent).toEqual([]);
      await draftInvoice.handler({ ...valid, contactPersonId: "2" }, ctx);
      expect((sent[0]!.body as { invoice: Row }).invoice.contactPerson).toEqual({ id: 2, objectName: "SevUser" });
    });

    it("explains itself when /SevUser fails or returns nobody", async () => {
      const failing = ctxWith({ users: "fail" });
      await expect(draftInvoice.handler(valid, failing.ctx)).rejects.toThrow(/GET \/SevUser failed.*contactPersonId/);
      const empty = ctxWith({ users: [] });
      await expect(draftInvoice.handler(valid, empty.ctx)).rejects.toThrow(/no users.*contactPersonId/);
      await expect(draftInvoice.handler({ ...valid, contactPersonId: "x" }, empty.ctx)).rejects.toThrow(/numeric SevUser id/);
    });
  });

  it("writes the §19 tax text for rule 11 and demands 0 % positions", async () => {
    const { ctx, sent } = ctxWith();
    await expect(
      draftInvoice.handler({ ...valid, taxRule: "11" }, ctx),
    ).rejects.toThrow(/taxRate 19 is not allowed with tax rule 11/);
    await draftInvoice.handler(
      { ...valid, taxRule: "11", positions: valid.positions.map((p) => ({ ...p, taxRate: 0 })) },
      ctx,
    );
    const body = sent[0]!.body as { invoice: Row };
    expect(body.invoice.taxText).toMatch(/§ 19 UStG/);
    expect(body.invoice.taxRate).toBe(0);
  });
});
