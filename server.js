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

// .env laden (neben server.js oder eine Ebene höher) – gesetzte Env-Variablen haben Vorrang
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

const server = new McpServer({ name: "wc-abos", version: "1.0.0" });

const paginierung = {
  per_page: z.number().int().min(1).max(100).optional().describe("Treffer pro Seite (max. 100, Default 100)"),
  page: z.number().int().min(1).optional().describe("Seitennummer für Paginierung"),
  customer: z.number().int().optional().describe("Nur Einträge eines Kunden (WordPress-User-ID)"),
  search: z.string().optional().describe("Freitextsuche (z.B. Name oder E-Mail)"),
};

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
      "expired, any), Kunde oder Freitextsuche. Antwort enthält total/total_pages für die Paginierung.",
    inputSchema: {
      status: z
        .enum(["active", "on-hold", "pending-cancel", "cancelled", "expired", "any"])
        .optional()
        .describe("Abo-Status-Filter (Default: any)"),
      ...paginierung,
    },
  },
  async ({ status, per_page, page, customer, search }) =>
    listResult(
      await wcGet("subscriptions", { status, per_page: per_page ?? 100, page, customer, search }),
      page
    )
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
      "cancelled, refunded, failed, any), Kunde oder Freitextsuche.",
    inputSchema: {
      status: z
        .enum(["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed", "any"])
        .optional()
        .describe("Bestell-Status-Filter (Default: any)"),
      ...paginierung,
    },
  },
  async ({ status, per_page, page, customer, search }) =>
    listResult(
      await wcGet("orders", { status, per_page: per_page ?? 100, page, customer, search }),
      page
    )
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`wc-abos MCP-Server läuft (Shop: ${BASE_URL})`);
