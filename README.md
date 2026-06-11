# mcp-wc-abos

MCP-Server für **shop.bundeslaenderinnen.at**: Abos (WooCommerce Subscriptions) und
Bestellungen über die REST API abrufen — **read-only**, der Server kann nichts ändern,
löschen oder anlegen.

## Tools

| Tool | Endpoint |
|---|---|
| `get_subscription` | `GET /wc/v3/subscriptions/{id}` |
| `list_subscriptions` | `GET /wc/v3/subscriptions?status=…&page=…` |
| `get_subscription_orders` | `GET /wc/v3/subscriptions/{id}/orders` |
| `get_order` | `GET /wc/v3/orders/{id}` |
| `list_orders` | `GET /wc/v3/orders?status=…&page=…` |

Listen-Antworten enthalten `total` / `total_pages` (aus den `X-WP-Total*`-Headern).
`_links` wird aus den Antworten entfernt, sonst bleibt das JSON unverändert.

## Installation (Claude Code)

### Variante A — direkt von GitHub (empfohlen)

Kein Klonen nötig, ein Befehl. Keys kommen über `--env`-Flags:

```bash
claude mcp add wc-abos \
  --env WC_CONSUMER_KEY=ck_xxx \
  --env WC_CONSUMER_SECRET=cs_xxx \
  -- npx -y github:MatthiasRuf1337/mcp-wc-abos
```

Danach Claude-Code-Session neu starten. Check: `claude mcp list` → `wc-abos: ✔ Connected`

> **Hinweis:** Der Befehl landet mit den Keys in der Shell-History (`~/.zsh_history`).
> Wer das vermeiden will, nutzt Variante B – dort stehen die Keys nur in der `.env`.
> Generell gilt: pro Person ein eigener Key mit Berechtigung **Lesen**, dann lässt sich
> jeder Key einzeln widerrufen.

### Variante B — geklont (Keys in .env-Datei)

```bash
git clone https://github.com/MatthiasRuf1337/mcp-wc-abos.git
cd mcp-wc-abos
npm install
cp .env.example .env   # und Keys eintragen
claude mcp add wc-abos -- node "$(pwd)/server.js"
```

## Konfiguration (Umgebungsvariablen)

| Variable | Bedeutung |
|---|---|
| `WC_CONSUMER_KEY` | `ck_…` (Pflicht) |
| `WC_CONSUMER_SECRET` | `cs_…` (Pflicht) |
| `WC_URL` / `WC_STORE_URL` | Basis-URL, Default `https://shop.bundeslaenderinnen.at` |

Der Server lädt eine `.env` neben `server.js` (oder eine Ebene höher) automatisch.
Explizit gesetzte Umgebungsvariablen (z.B. via `--env`) haben Vorrang.

> **Wichtig:** Die Keys niemals committen oder in Client-Code einbetten. Für diesen
> Server reicht ein Key mit Berechtigung **Lesen**
> (WooCommerce → Einstellungen → Erweitert → REST-API).

## Manuell testen

```bash
WC_CONSUMER_KEY=ck_xxx WC_CONSUMER_SECRET=cs_xxx node server.js
```
