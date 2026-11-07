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
   - **block**: the payTo is unknown, on the OFAC list or frozen by the stablecoin issuer, the service
     is not working, or the price is over your budget;
   - **hold**: the payTo differs from the listing or was never seen, the price is above the listing or
     what alalanet observed, the network or asset is not listed, the price is high, the trust score is
     low, or the service is unknown or not checked yet. By default the guard treats hold like block;
     set `onHold: "allow"` to pay options on hold;
   - **allow**: otherwise.

   The decision is signed and written to a public log. It records the endpoint, the terms and the
   decision, never who asked.
3. Only **allowed** options are passed to your payer. If none are allowed, the guard throws
   `X402GuardError` and nothing is signed.
4. After each payment attempt, `onPaid` gets `paid` and the settlement transaction from the `PAYMENT-RESPONSE` header.
   The daily budget counts what was paid.

## Never pay twice

A paid call can time out, or get a 5xx or an unclear answer, after the facilitator has already
settled it. If the retry signs a fresh payment, you pay twice. Released x402 clients do this (x402
[#3438](https://github.com/x402-foundation/x402/issues/3438),
[#4094](https://github.com/x402-foundation/x402/pull/4094)). The guard prevents it with any
`@x402/fetch` version:

- **Holds the signed payment per purchase** (method + URL + body). On a retry it sends the **same**
  payment again, not the newly signed one. This is safe: an EIP-3009 authorization settles at most
  once, and a Solana transaction with the same blockhash lands at most once.
- **When the payment's validity window has closed**, it asks alalanet before a new payment may go
  out. alalanet answers with `GET /v1/payment-status`, read on chain: EVM by `from` + `nonce` +
  `validBefore`, Solana by payer + blockhash.
  - **Paid already:** the guard throws `already_paid` with the tx. Ask the seller to deliver for that
    payment.
  - **Expired unused:** the new payment goes out.
  - **Anything unclear:** the guard throws `payment_outcome_unknown` and signs nothing.
- **A definite refusal ends the hold.** That means a facilitator error code such as
  `insufficient_funds` with no transaction. `settlement_pending` and "nonce already used" do not end
  it.

Reproduce it with [examples/double-pay.mjs](examples/double-pay.mjs): a local seller settles the
first paid call but answers 502, and the caller retries. With `@x402/fetch` 2.30.0 alone the seller
receives 2 distinct authorizations, so you pay twice. With the guard it receives 1, sent twice.

This is on by default (`holdPayments: false` turns it off). Only the payer address, the nonce or
blockhash, and the expiry are sent to alalanet, never the signature.

## Options

| option | default | |
|---|---|---|
| `maxUsdPerCall` | none | options above it are blocked |
| `maxUsdPerDay` | none | rolling 24 h budget kept in memory |
| `maxUsdPerHostPerDay` | none | rolling 24 h budget per seller host |
| `client` | detected | your x402 library and version, e.g. `"@x402/fetch@2.23.0"`; by default read from the installed `@x402/*` packages (Node) |
| `detectClient` | `true` | `false` to skip reading installed versions |
| `onAdvisory(list)` | `console.warn` | called once if your payment library has known flaws |
| `allowHosts` / `denyHosts` | none | `"api.example.com"` or `"*.example.com"` |
| `onHold` | `"block"` | `"allow"` to pay options on hold |
| `holdPayments` | `true` | hold and re-present signed payments on retries; reconcile on chain before a new one |
| `failOpen` | `false` | if alalanet is unreachable: `false` refuses to pay, `true` passes the 402 through |
| `token` | none | alalanet bearer token for higher limits |
| `onDecision(d)` | none | every verdict (log it for your operator) |
| `onPaid(p)` | none | `{url, paid, status, tx, network, payer, usd, response}` |
| `report` | `false` | report each paid call (see below) |
| `onReport(r)` | none | result of each report |
| `api` | `https://alalanet.com` | |

`X402GuardError.code` is one of `blocked`, `held`, `denied_host`, `not_allowed_host`,
`over_budget`, `alalanet_unreachable`, `bad_402`, `already_paid` or `payment_outcome_unknown`. `reasons` lists alalanet's reasons.

## Known flaws in your payment library

Fixes for the x402 payment SDKs shipped without security advisories, so `npm audit` shows the
vulnerable versions as clean ([CSA, 2026-10-25](https://labs.cloudsecurityalliance.org/research/csa-research-note-x402-agent-payment-sdk-flaws-20261025-csa/)).
For example, `@x402/fetch` and `@x402/axios` before 2.23.0 enforced no spending limit: a hostile API
could ask for the whole wallet balance. The guard tells alalanet which `@x402/*` versions you run and
warns once if one is affected. The list is public: `GET https://alalanet.com/v1/advisories`.
The library versions are not signed or logged and do not change the decision.

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
- What is sent: only the URL and its 402 terms, the names and versions of your `@x402/*` libraries (and, with `report`, the URL, transaction hash and outcome). No wallet keys, request bodies or responses leave
  your process.

Zero dependencies. Works on Node 18+, Bun, Deno and in browsers. License: MIT-0.
