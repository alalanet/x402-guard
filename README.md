# x402-guard

```
npm i @alalanet/x402-guard
```

A `fetch` wrapper that asks [alalanet](https://alalanet.com) **before** your agent signs an x402
payment. Your payer only ever sees the payment options alalanet allowed, within your budget.

Without it, a "check before you pay" step is just an MCP tool the model may skip. With it, the
check sits in the payment path.

```js
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { guardFetch } from "@alalanet/x402-guard";

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

// The guard goes UNDER the payer: it sees each 402 before a payment is created.
const pay = wrapFetchWithPayment(
  guardFetch(fetch, { maxUsdPerCall: 0.05, maxUsdPerDay: 2 }),
  client,
);

const res = await pay("https://api.example.com/paid?city=Lisbon");
```

## What happens on a 402

1. The guard sends the endpoint URL and its 402 terms to `POST https://alalanet.com/v1/preflight`.
2. alalanet judges each payment option:
   - **block**: payTo differs from the listing, payTo is on the OFAC list, the service is down, or the
     price is over your budget;
   - **hold**: the price is above the listing, the network or asset is not listed, the trust score is
     low, or the service is unknown;
   - **allow**: otherwise.

   The decision is signed and written to a public log. It records the endpoint, the terms and the
   decision, never who asked.
3. Only **allowed** options are passed to your payer. If none are allowed, the guard throws
   `X402GuardError` and nothing is signed.
4. After each payment attempt, `onPaid` gets `paid` and the settlement transaction from the `PAYMENT-RESPONSE` header.
   The daily budget counts what was paid.

## Options

| option | default | |
|---|---|---|
| `maxUsdPerCall` | none | options above it are blocked |
| `maxUsdPerDay` | none | rolling 24 h budget kept in memory |
| `allowHosts` / `denyHosts` | none | `"api.example.com"` or `"*.example.com"` |
| `onHold` | `"block"` | `"allow"` to pay options on hold |
| `failOpen` | `false` | if alalanet is unreachable: `false` refuses to pay, `true` passes the 402 through |
| `token` | none | alalanet bearer token for higher limits |
| `onDecision(d)` | none | every verdict (log it for your operator) |
| `onPaid(p)` | none | `{url, paid, status, tx, network, payer, usd, response}` |
| `report` | `false` | report each paid call (see below) |
| `onReport(r)` | none | result of each report |
| `api` | `https://alalanet.com` | |

`X402GuardError.code` is one of `blocked`, `held`, `denied_host`, `not_allowed_host`,
`over_budget`, `alalanet_unreachable` or `bad_402`. `reasons` lists alalanet's reasons.

## Tell other agents whether the seller delivered

Turn on `report: true` and the guard reports every paid call to `POST https://alalanet.com/v1/purchases`
with its settlement transaction: `delivered` for a 2xx answer, `not_delivered` otherwise. Pass a
function instead to judge the content yourself (`"wrong_content"`, `"partial"`, or `null` to skip).
No key needed: alalanet checks on chain that the transaction paid that seller, so only real buyers
count, one report per payment. Deliveries raise the seller's Trust Score; failures trigger an
immediate recheck. Reports never block or slow your call.

```js
guardFetch(fetch, { maxUsdPerCall: 0.05, report: (p) => (p.response.ok ? "delivered" : "not_delivered") })
```

## Limits and privacy

- Free: 100 decisions a day per IP, without an account.
- What is sent: only the URL and its 402 terms (and, with `report`, the URL, transaction hash and outcome). No wallet keys, request bodies or responses leave
  your process.

Zero dependencies. Works on Node 18+, Bun, Deno and in browsers. License: MIT-0.
