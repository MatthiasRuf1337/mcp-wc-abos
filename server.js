#!/usr/bin/env node
/**
 * MCP-Server: Abos & Bestellungen abrufen (WooCommerce REST API)
 *
 * Read-only Zugriff auf shop.bundeslaenderinnen.at gemäß
 * DEV-ANLEITUNG-Abos-Bestellungen-abrufen.md.
 *
 * Konfiguration über Umgebungsvariablen:
 *   WC_URL              Basis-URL des Shops (Default: https://shop.bundeslaenderinnen.at)
 *   WC_CONSUMER_KEY     ck_xxx
 *   WC_CONSUMER_SECRET  cs_xxx
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// .env laden (mcp-wc-abos/.env oder webseite/.env) – gesetzte Env-Variablen haben Vorrang
const here = dirname(fileURLToPath(import.meta.url));
for (const envPath of [join(here, ".env"), join(here, "..", ".env")]) {
  try {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
    break;
  } catch {
    // Datei nicht vorhanden → nächsten Pfad probieren
  }
}

const BASE_URL = (
  process.env.WC_URL ||
  process.env.WC_STORE_URL ||
  "https://shop.bundeslaenderinnen.at"
).replace(/\/+$/, "");
const CK = process.env.WC_CONSUMER_KEY;
const CS = process.env.WC_CONSUMER_SECRET;

if (!CK || !CS) {
  console.error("Fehler: WC_CONSUMER_KEY und WC_CONSUMER_SECRET müssen gesetzt sein.");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(`${CK}:${CS}`).toString("base64");

/** GET gegen /wp-json/wc/v3/<path>, gibt { data, total, totalPages } zurück. */
async function wcGet(path, params = {}) {
  const url = new URL(`${BASE_URL}/wp-json/wc/v3/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { Authorization: AUTH, Accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText} bei ${url.pathname}: ${body.slice(0, 500)}`);
  }
  return {
    data: await res.json(),
    total: res.headers.get("X-WP-Total"),
    totalPages: res.headers.get("X-WP-TotalPages"),
  };
}

/** _links-Ballast entfernen, Rest unverändert lassen. */
function strip(obj) {
  if (Array.isArray(obj)) return obj.map(strip);
  if (obj && typeof obj === "object") {
    const { _links, ...rest } = obj;
    return rest;
  }
  return obj;
}

function asResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function listResult({ data, total, totalPages }, page) {
  return asResult({
    page: page ?? 1,
    total: total ? Number(total) : data.length,
    total_pages: totalPages ? Number(totalPages) : 1,
    items: strip(data),
  });
}

/** "YYYY-MM-DD" zu vollem ISO8601 ergänzen (before = Tagesende), sonst unverändert. */
function isoDate(v, endOfDay = false) {
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v + (endOfDay ? "T23:59:59" : "T00:00:00");
  return v;
}

const server = new McpServer({ name: "wc-abos", version: "1.2.0" });

const paginierung = {
  per_page: z.number().int().min(1).max(100).optional().describe("Treffer pro Seite (max. 100, Default 100)"),
  page: z.number().int().min(1).optional().describe("Seitennummer für Paginierung"),
  customer: z.number().int().optional().describe("Nur Einträge eines Kunden (WordPress-User-ID, siehe find_customer)"),
  search: z.string().optional().describe("Freitextsuche (z.B. Name oder E-Mail)"),
  after: z.string().optional().describe("Nur Einträge erstellt nach diesem Datum (YYYY-MM-DD oder ISO8601)"),
  before: z.string().optional().describe("Nur Einträge erstellt vor diesem Datum (YYYY-MM-DD oder ISO8601)"),
  modified_after: z.string().optional().describe("Nur Einträge geändert nach diesem Datum (YYYY-MM-DD oder ISO8601)"),
  modified_before: z.string().optional().describe("Nur Einträge geändert vor diesem Datum (YYYY-MM-DD oder ISO8601)"),
  orderby: z.enum(["date", "id", "modified"]).optional().describe("Sortierfeld (Default: date)"),
  order: z.enum(["asc", "desc"]).optional().describe("Sortierrichtung (Default: desc = neueste zuerst)"),
};

/** Gemeinsame Listen-Parameter in API-Query-Parameter übersetzen. */
function listParams({ status, per_page, page, customer, search, after, before, modified_after, modified_before, orderby, order }) {
  return {
    status, customer, search, orderby, order, page,
    per_page: per_page ?? 100,
    after: isoDate(after),
    before: isoDate(before, true),
    modified_after: isoDate(modified_after),
    modified_before: isoDate(modified_before, true),
  };
}

server.registerTool(
  "get_subscription",
  {
    title: "Abo abrufen",
    description:
      "Ein einzelnes Abo (WooCommerce Subscription) per ID abrufen. Liefert Status, Beträge, " +
      "billing-/shipping-Adresse, line_items, Laufzeitdaten und meta_data (abonummer, _billing_title, " +
      "_billing_vat_number usw.). Hinweis: shipping hat kein email-Feld; ist shipping.address_1 leer, " +
      "gilt die billing-Adresse als Lieferadresse.",
    inputSchema: { id: z.number().int().describe("Abo-ID (z.B. 121468)") },
  },
  async ({ id }) => asResult(strip((await wcGet(`subscriptions/${id}`)).data))
);

server.registerTool(
  "list_subscriptions",
  {
    title: "Abos auflisten",
    description:
      "Abos auflisten, optional gefiltert nach Status (active, on-hold, pending-cancel, cancelled, " +
      "expired, any), Kunde, Freitextsuche oder Zeitraum (after/before auf das Erstelldatum). " +
      "Antwort enthält total/total_pages für die Paginierung.",
    inputSchema: {
      status: z
        .enum(["active", "on-hold", "pending-cancel", "cancelled", "expired", "any"])
        .optional()
        .describe("Abo-Status-Filter (Default: any)"),
      ...paginierung,
    },
  },
  async (args) => listResult(await wcGet("subscriptions", listParams(args)), args.page)
);

server.registerTool(
  "get_subscription_orders",
  {
    title: "Bestellungen eines Abos",
    description:
      "Alle Bestellungen zu einem Abo abrufen (Erstbestellung + Verlängerungen) über " +
      "/subscriptions/{id}/orders.",
    inputSchema: { id: z.number().int().describe("Abo-ID") },
  },
  async ({ id }) => asResult(strip((await wcGet(`subscriptions/${id}/orders`)).data))
);

server.registerTool(
  "get_order",
  {
    title: "Bestellung abrufen",
    description:
      "Eine einzelne Bestellung per ID abrufen. Verknüpfung zum Abo steht im meta_data-Array: " +
      "_subscription_renewal (Verlängerung) bzw. _subscription_initial_payment (Erstbestellung); " +
      "außerdem abonummer, _invoice_number und is_vat_exempt.",
    inputSchema: { id: z.number().int().describe("Bestell-ID (z.B. 135447)") },
  },
  async ({ id }) => asResult(strip((await wcGet(`orders/${id}`)).data))
);

server.registerTool(
  "list_orders",
  {
    title: "Bestellungen auflisten",
    description:
      "Bestellungen auflisten, optional gefiltert nach Status (pending, processing, on-hold, completed, " +
      "cancelled, refunded, failed, any), Kunde, Produkt, Freitextsuche oder Zeitraum (after/before " +
      "auf das Bestelldatum).",
    inputSchema: {
      status: z
        .enum(["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "any"])
        .optional()
        .describe("Bestell-Status-Filter (Default: any)"),
      product: z.number().int().optional().describe("Nur Bestellungen mit diesem Produkt (Produkt-ID)"),
      ...paginierung,
    },
  },
  async (args) =>
    listResult(await wcGet("orders", { ...listParams(args), product: args.product }), args.page)
);

server.registerTool(
  "list_subscriptions_ending",
  {
    title: "Auslaufende Abos finden",
    description:
      "Abos finden, deren Enddatum (end_date) oder nächste Zahlung (next_payment_date) in einem " +
      "Zeitraum liegt. Die REST API kann danach nicht filtern – dieses Tool blättert deshalb " +
      "serverseitig durch alle Abos (schlanke Felder, parallele Requests) und filtert selbst. " +
      "Bei 50.000+ Abos dauert ein kompletter Scan 1–3 Minuten. Default-Status: active + " +
      "pending-cancel (gekündigt, läuft aus).",
    inputSchema: {
      from: z.string().describe("Zeitraum-Beginn (YYYY-MM-DD, Pflicht)"),
      to: z.string().describe("Zeitraum-Ende (YYYY-MM-DD, Pflicht)"),
      date_field: z
        .enum(["end_date", "next_payment_date"])
        .optional()
        .describe("Welches Datum zählt: end_date = Abo läuft aus (Default), next_payment_date = nächste Abbuchung"),
      status: z
        .enum(["active+pending-cancel", "active", "on-hold", "pending-cancel", "cancelled", "expired", "any"])
        .optional()
        .describe("Status-Filter für den Scan (Default: active+pending-cancel)"),
      max_pages: z.number().int().min(1).optional().describe("Scan-Limit in Seiten à 100 (Default: alle)"),
      start_page: z.number().int().min(1).optional().describe("Scan ab dieser Seite fortsetzen (für Folge-Aufrufe)"),
    },
  },
  async ({ from, to, date_field = "end_date", status = "active+pending-cancel", max_pages, start_page = 1 }) => {
    const field = date_field === "end_date" ? "end_date_gmt" : "next_payment_date_gmt";
    const fromIso = isoDate(from), toIso = isoDate(to, true);
    const fields = `id,number,status,end_date_gmt,next_payment_date_gmt,start_date_gmt,billing,line_items`;
    const statuses = status === "active+pending-cancel" ? ["active", "pending-cancel"] : [status];
    const CONCURRENCY = 5;
    const matches = [];
    let scanned = 0, pagesScanned = 0, complete = true, nextPage = null;

    for (const st of statuses) {
      const first = await wcGet("subscriptions", { status: st, per_page: 100, page: start_page, _fields: fields });
      const totalPages = Number(first.totalPages || 1);
      const lastPage = max_pages ? Math.min(totalPages, start_page + max_pages - 1) : totalPages;
      const pageNums = [];
      for (let p = start_page + 1; p <= lastPage; p++) pageNums.push(p);
      if (lastPage < totalPages) { complete = false; nextPage = lastPage + 1; }

      const handle = (subs) => {
        scanned += subs.length; pagesScanned++;
        for (const s of subs) {
          const d = (s[field] || "").substring(0, 19);
          if (d && d >= fromIso && d <= toIso) {
            matches.push({
              id: s.id, status: s.status,
              end_date: s.end_date_gmt || null,
              next_payment_date: s.next_payment_date_gmt || null,
              name: `${s.billing?.first_name || ""} ${s.billing?.last_name || ""}`.trim(),
              email: s.billing?.email || "",
              products: (s.line_items || []).map((li) => li.name),
            });
          }
        }
      };
      handle(first.data);
      for (let i = 0; i < pageNums.length; i += CONCURRENCY) {
        const batch = pageNums.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map((p) => wcGet("subscriptions", { status: st, per_page: 100, page: p, _fields: fields }))
        );
        for (const r of results) handle(r.data);
      }
    }

    matches.sort((a, b) => ((a[date_field] || "") < (b[date_field] || "") ? -1 : 1));
    const LIMIT = 500;
    return asResult({
      matched: matches.length,
      scanned, pages_scanned: pagesScanned,
      complete,
      ...(nextPage ? { hint: `Scan unvollständig – mit start_page=${nextPage} fortsetzen.` } : {}),
      ...(matches.length > LIMIT ? { note: `Nur die ersten ${LIMIT} Treffer (sortiert nach ${date_field}).` } : {}),
      items: matches.slice(0, LIMIT),
    });
  }
);

server.registerTool(
  "find_customer",
  {
    title: "Kunde finden",
    description:
      "Kunden per E-Mail oder Freitext (Name) suchen. Liefert die customer_id (WordPress-User-ID), " +
      "die dann bei list_subscriptions/list_orders als customer-Parameter verwendet wird. " +
      "E-Mail-Suche ist exakt, search findet auch Namensteile.",
    inputSchema: {
      email: z.string().optional().describe("Exakte E-Mail-Adresse des Kunden"),
      search: z.string().optional().describe("Freitextsuche, z.B. Nachname"),
    },
  },
  async ({ email, search }) => {
    if (!email && !search) throw new Error("email oder search muss angegeben werden.");
    const { data } = await wcGet("customers", { email, search, per_page: 20 });
    return asResult(
      data.map((c) => ({
        customer_id: c.id,
        email: c.email,
        first_name: c.first_name,
        last_name: c.last_name,
        company: c.billing?.company || "",
        city: c.billing?.city || "",
        postcode: c.billing?.postcode || "",
        country: c.billing?.country || "",
      }))
    );
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`wc-abos MCP-Server läuft (Shop: ${BASE_URL})`);
