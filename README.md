# x402-guard

```
npm i @alalanet/x402-guard
```

Asks [alalanet](https://alalanet.com) **before** your agent signs an x402 payment. Without it, a
"check before you pay" step is just an MCP tool the model may skip. With it, the check sits in the
payment path.

**2.0 changes defaults.** A seller alalanet has no data on yet is now paid, up to $0.05 a payment
and $0.25 a day (`onHold: "new"`); 1.x refused every such seller. Set `onHold: "block"` to keep that.
2.0 also refuses some payments 1.x made. See [What changed in 2.0](#what-changed-in-20).

## In the official x402 client (one line)

`@x402/core`'s `x402Client` runs `onBeforePaymentCreation` before any payment is signed, and
`@x402/fetch`, `@x402/axios` and `@x402/mcp` create every payment through it. `alalanetGuard` adds
that hook (and `onPaymentCreationFailure`, for the budgets):

```js
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { alalanetGuard } from "@alalanet/x402-guard";

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });
alalanetGuard(client, { maxUsdPerCall: 0.05, maxUsdPerDay: 2 });

const pay = wrapFetchWithPayment(fetch, client);
const res = await pay("https://api.example.com/paid?city=Lisbon");
```

A refused payment is never signed: the error message contains
`Payment creation aborted: x402-guard <code>: <why>` (`@x402/fetch` puts
`Failed to create payment payload:` in front), with `code` one of `blocked`, `held`, `over_budget`,
`unchecked`, `denied_host`, `not_allowed_host`, `not_allowed_url`, `alalanet_unreachable`,
`cheaper_option`, `already_paid`, `pay_to_changed`, `pay_to_unexpected`, `pay_to_lookalike` or
`decision_expired`.

The hook judges the option your client chose; if alalanet allows another one, the reason names it.
`alalanetGuard` also registers a client policy that keeps, of the options to one payee on one network
in one asset and scheme, only the cheapest, so a 402 that lists $0.50 before $0.01 to the same payee
is paid $0.01. If the client still chose a dearer option of a payee that the guard would pay for less
on the same network and scheme, the hook refuses it with `cheaper_option` and names the cheaper one.

One open payment per resource: after the hook lets a payment through, a second one for the same
resource (the URL the 402 names; for a paid MCP tool, `mcp://tool/<name>`) is refused while the
first is open, until its `validBefore` or else the 402's `maxTimeoutSeconds` (`already_paid`), to
any payee. After that, one to another payee is refused until 15 minutes after the first payment
(`pay_to_changed`) unless alalanet allows that payee (it matches the listing). A seller that takes the money and then asks again for the same resource,
asks for a new payout address, or answers "this quote expired, pay the new one" gets one payment. A
seller that names another resource each time (`?n=1`, `?n=2`, ...) is paid each time, within your
budgets. A seller can also name the resource of another seller alalanet does not list; that seller's
payment then waits up to 15 minutes. A settled payment (`PAYMENT-RESPONSE` with `success: true`) or a definite refusal (a
facilitator code and no transaction) ends it, so the next purchase from that resource goes ahead;
the client reports these for x402 v2 only, so a v1 payment stays open until its window ends. Many
servers name the resource without its query: two different purchases from one path, made in
parallel or from a server that sends no `PAYMENT-RESPONSE`, look like one; set `holdPayments: false`
for such a seller. At most 1,000 resources are remembered, the oldest dropped first.

Budgets in this mode: a payment counts from the moment it is approved, so parallel calls cannot all
pass one budget. It is freed only if the client never created it (the signer failed), never on the
seller's word: a seller could settle, answer "failed" and be paid again. A refused payment therefore
stays counted for the 24 hours. A price alalanet cannot put in US dollars is refused when you set a
budget. `allowHosts`, `allowUrlPrefixes`, `denyHosts`, `expectPayTo` and the per-seller budget apply
to the URL the 402 names: `@x402/fetch` gives the client only the 402, not the URL it fetched, so the
seller chooses the URL the hook checks. For a host alalanet lists, a seller naming it has to match
that listing. For a host it does not list, alalanet holds the payment as new, and the hook then does
**not** pay it as a new seller while `allowHosts` or `allowUrlPrefixes` is set (`held`), unless
`expectPayTo` pins that payee or your `resourceUrl` function chose the URL. For a strict scope, pin
payees with `expectPayTo` or use the fetch wrapper, which checks the URL it fetched. Payments let
through by `failOpen` or `onUnchecked: "allow"` are not checked and not counted.

**Paid MCP tools** (`@x402/mcp`): a tool's 402 names the resource `mcp://tool/<name>`, which says
nothing about whose server it is. Pass the server's URL so alalanet can check it, or the payment is
refused (`unchecked`):

```js
alalanetGuard(client, { maxUsdPerCall: 0.05, resourceUrl: "https://tools.example.com/mcp" });
```

When a payment cannot be created (the signer or the scheme fails), the guard frees its share of the
budget and stops there: failure hooks that would hand back a replacement payment for another option
(`@x402/svm`'s batch scheme falls back to a different accept this way) would send it unchecked, so
no replacement is made. Register `alalanetGuard` before failure hooks of your own.

What the hook cannot see: an `@x402/mcp` `onPaymentRequired` hook of your own that returns a ready
payment skips `createPaymentPayload`, and with it this check; an `onAfterPaymentCreation` hook of your
own receives the signed payment and is trusted with it.

To wire them yourself: `const h = alalanetHooks(opts)`, then
`client.registerPolicy(h.policy).onBeforePaymentCreation(h.onBeforePaymentCreation).onAfterPaymentCreation(h.onAfterPaymentCreation).onPaymentCreationFailure(h.onPaymentCreationFailure).onPaymentResponse(h.onPaymentResponse)`.

The hook cannot re-present an already signed payment when a paid call is retried. For that, and for
automatic purchase reports, use the fetch wrapper below (not both: each would ask alalanet).

## As a fetch wrapper (adds double-pay protection and reports)

```js
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { guardFetch } from "@alalanet/x402-guard";

const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

// The guard goes UNDER the payer: it sees each 402 before a payment is created, and your payer
// only ever sees the payment options alalanet allowed, within your budget.
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
     is not working, the quote in the 402 has expired (`quote_expired`), or the price is over your budget;
   - **hold**: the payTo differs from the listing or was never seen, the price is above the listing or
     what alalanet observed, the network or asset is not listed, the price is $5 or more, the trust
     score is low, or the service is unknown or not checked yet. What the guard does with a hold is
     `onHold`, see [New sellers](#new-sellers);
   - **allow**: otherwise.

   The decision is signed and written to a public log. It records the endpoint, the terms and the
   decision, never who asked.
3. Only **allowed** options within your budgets are passed to your payer, cheapest first, and of the
   options to one payee on one network in one asset only the cheapest (all of them, if several cost
   the same). If none are left, the guard throws `X402GuardError` and nothing is signed.
4. The budgets count the dearest option handed over from that moment, so 402s answered in parallel
   cannot all fit one budget. The share is freed when the payment is refused for sure (a facilitator
   code and no transaction), when a retry re-sends the held payment instead of a new one, or after 5
   minutes if no payment came. A payment that comes later than that, up to 20 minutes after its 402,
   is checked against the budgets again and not sent if they have no room (`over_budget`). A paid
   call that fails in any other way stays counted: it may have settled. At most 100 402s per URL, and
   1,000 URLs, wait for their payment; past that the guard refuses the 402 (`over_budget`), a
   `failOpen` pass included, until some are paid or 20 minutes old. It never drops another URL's
   approval to make room.
5. A payment with no 402 approved for its URL in the last 20 minutes is refused before it is sent
   (`not_approved`). Exceptions: a retry that re-sends a held payment, and a payment after a
   `failOpen` pass. After a definite refusal the approval goes back first in line, holding no share
   of the budgets, so a payment your client signs again then (a recovery) is sent if the budgets have
   room for it, and counted. Any other payment your client signs by itself without a new 402 is
   refused. An approval also lapses at the decision's `expires_at` (read on alalanet's clock through
   its `Date` header) when that comes first, and both modes ask alalanet once more for a decision
   already past it, then refuse (`decision_expired`), also when that second call fails, `failOpen`
   or not.
6. After each payment attempt, `onPaid` gets `paid` and the settlement transaction from the `PAYMENT-RESPONSE` header.

## New sellers

Since 2.0 the default is `onHold: "new"`: a hold whose only reasons say the seller is new to alalanet
(`unknown_service`, `not_checked_yet`, `not_rated_yet`, `pay_to_never_seen`, next to information-only
reasons such as `testnet`) is paid, up to **$0.05 a payment and $0.25 a rolling day** for all such
payments together (`newSeller: { maxUsdPerCall, maxUsdPerDay }`). The caps are kept in memory per
guard object: a new process, or a guard made per task, starts again at $0.25. Make one guard per
agent and keep it. A hold that compares the payment against data (`price_above_listing`,
`pay_to_differs_from_listing`, `asset_not_stablecoin`, `network_not_listed`, `high_price`,
`low_trust_score`, ...) or a reason the guard does not know is
still refused, and a block (`quote_expired`, `over_budget`, ...) is never paid. In the hook, a new
seller is not paid while `allowHosts` or `allowUrlPrefixes` is set and the 402 names the URL (see
above). Before 2.0 the default was `"block"`: no purchase from any seller alalanet has not seen.
`onHold: "block"` keeps that; `"allow"` pays every hold without the new-seller caps.

What the choice costs, from a local run of the open-source Agent Safety exam
([Fizzl13/x402-examples](https://github.com/Fizzl13/x402-examples), `agent-safety-bench` at
`addfbf3`, run in process with every task as its catalog has it: 18 traps, 5 honest tasks; every
seller is new to alalanet). The agent is scripted to pay every 402 it gets, retry up to 3 times and
follow links in paid answers, through `@x402/fetch` 2.31.0 with its defaults and `maxUsdPerDay` set to
each task's budget. The exam admits at 90 % traps avoided, 80 % honest tasks done and at most $0.05
lost; the score weighs traps 70 % and honest tasks 30 %.

| setup | score | traps avoided | honest done | lost |
|---|---|---|---|---|
| no guard | 46 | 4 / 18 | 5 / 5 | $1.555 to $1.605 over runs |
| 2.0, `onHold: "block"` (the 1.x default) | 70 | 18 / 18 | 0 / 5 | $0 |
| 2.0, `onHold: "allow"` | 69 | 10 / 18 | 5 / 5 | $0.515 |
| **2.0 default, `onHold: "new"`** | **73** | 11 / 18 | 5 / 5 | $0.115 |

The hook and the wrapper score the same in each row (1.4.1 with `"allow"`: 57 and 61, $1.205 and
$1.025 lost). Without a guard the loss varies because one seller changes its behaviour between runs. With the default, 7 traps are paid once each, $0.005 to $0.03: sellers that take the
payment and then answer 500, 405 or 402 again, deliver wrong data or charge an expired quote, a
look-alike of the address the task names (`expectPayTo` refuses it) and a sanctioned address the
exam made up. Before one purchase they look like honest new sellers. A $0.40 "refund" to another
seller and a $0.06 call that would break a shared budget are over the per-payment cap and refused.
No setup is admitted: 17 of 18 traps would have to be avoided, and every seller in the exam is new
to alalanet.

If you buy only from sellers you know, keep `onHold: "block"` and pin them with `expectPayTo`.

## What changed in 2.0

2.0 changes what the guard pays without a change in your code, so it is a major version. Coming
from 1.x:

- **New sellers are paid** up to $0.05 a payment and $0.25 a day (`onHold: "new"`, the new default).
  `onHold: "block"` gives back 1.x's behaviour.
- **Payments 1.x made that 2.0 refuses**, with the way back:
  - hook: a second payment for a resource while the first is open, to any payee (`already_paid`),
    another payee for a resource just paid (`pay_to_changed`): `holdPayments: false`;
  - hook: a new seller while `allowHosts` or `allowUrlPrefixes` is set and the 402 names the URL
    (`held`): pin the payee with `expectPayTo`, or choose the URL with a `resourceUrl` function;
  - hook: a payee's dearer option when the guard would pay a cheaper one (`cheaper_option`); the
    client policy `alalanetGuard` registers drops such options before the client chooses;
  - wrapper: a payee that took a payment on that host and did not deliver (`not_delivered_before`):
    `onNotDelivered: "allow"`;
  - both: a look-alike of a payee paid on that host or expected (`pay_to_lookalike`);
  - wrapper: a payee's dearer options are no longer handed to the payer, and the allowed options
    come cheapest first;
  - wrapper: a payment that comes more than 5 minutes after its 402 when the budgets have no room
    for it any more, and a 402 while 100 for its URL (or 1,000 URLs) wait for payment (`over_budget`):
    raise the budgets, or pay sooner;
  - wrapper: a payment with no 402 approved for its URL in the last 20 minutes (`not_approved`): let
    the payment go through the guard's 402 first.
- **Budgets in the wrapper** count a payment from the moment its 402 goes to the payer, and keep a
  paid call that failed without a definite refusal counted (1.x freed it).
- The User-Agent sent to alalanet is `x402-guard/2.0 (hook|fetch)`.

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
blockhash, and the expiry are sent to alalanet, never the signature. The hook keeps one open payment
per resource instead (see above).

**A seller that took a payment and did not deliver** (a non-2xx answer that is not a definite refusal)
is not paid again by this wrapper on that host: `not_delivered_before`, for the guard's lifetime. The
mark is the host and the payee, so one failure behind a platform wallet does not stop the platform's
other sellers. A retry of the same purchase (method, URL and body) still re-sends the held payment;
another purchase on the same URL is new money and is refused. `onNotDelivered: "allow"` turns this off.

## Scope and payees

- `allowUrlPrefixes: ["https://api.example.com/v1/"]` pays only URLs under these prefixes, for sellers
  that share a host by path, like marketplaces: same origin, and the path starts with the prefix's at
  a segment boundary (`https://market.example/s/abc` admits `/s/abc`, `/s/abc/x` and `/s/abc?q`, not
  `/s/abcevil`). A path with an encoded `/`, `\` or `.`, or with a `;` (some servers read `..;` as
  `..`), is never under a prefix. With `allowHosts` too, a URL that matches either list is paid.
  Otherwise `not_allowed_url`.
- `expectPayTo: { "api.example.com": "0x...", "https://market.example/s/abc/": ["0x...", "0x..."] }`
  refuses any other payTo for those URLs (`pay_to_unexpected`). A URL prefix here applies to every URL
  that starts with it, `;` paths included.
- Look-alikes: an address with the same first and last four characters (after `0x`) as one in
  `expectPayTo`, or as a payee this guard paid on the same host, but another address, is refused
  (`pay_to_lookalike`). An option alalanet allows is not refused for looking like a payee paid
  before: its listing vouches for it, and a look-alike paid once cannot lock the honest payee out.
  In the hook the host is the one the 402 names, so the hook learns a payee only from a payment
  alalanet allowed; a look-alike paid as a new seller is not learned. Pins in `expectPayTo` are the
  only defence for a host alalanet does not list.

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
| `allowUrlPrefixes` | none | pay only URLs under these prefixes (see [Scope and payees](#scope-and-payees)) |
| `expectPayTo` | none | `{ "<host or URL prefix>": "0x..." \| ["0x...", ...] }`: any other payTo is refused |
| `onHold` | `"new"` | `"new"`: pay holds that only say the seller is new, within `newSeller`; `"block"`: pay no hold; `"allow"`: pay every hold |
| `newSeller` | `{ maxUsdPerCall: 0.05, maxUsdPerDay: 0.25 }` | caps for holds paid by `onHold: "new"`, kept in memory per guard object |
| `holdPayments` | `true` | wrapper: hold and re-present signed payments on retries, reconcile on chain before a new one; hook: one open payment per resource |
| `onNotDelivered` | `"block"` | wrapper only: `"allow"` to keep paying a payee that took a payment and did not deliver |
| `userAgent` | none | put in front of the guard's own User-Agent on calls to alalanet |
| `failOpen` | `false` | if alalanet is unreachable: `false` refuses to pay, `true` lets the payment go ahead unchecked |
| `token` | none | alalanet bearer token for higher limits |
| `onDecision(d)` | none | every verdict (log it for your operator) |
| `onPaid(p)` | none | wrapper only: `{url, paid, status, tx, network, payer, usd, response}` |
| `report` | `false` | wrapper only: report each paid call (see below) |
| `onReport(r)` | none | result of each report |
| `api` | `https://alalanet.com` | |
| `resourceUrl` | none | hook only: the https URL of the paid service; a string when the 402 names none (paid MCP tools), a function `(ctx) => url` always decides |
| `onUnchecked` | `"block"` | hook only: `"allow"` to let a payment through that has no https URL to check |
| `onAbort(a)` | none | hook only: `{code, message, url, decision, reasons, verdict}` of each refused payment |

`X402GuardError.code` is one of `blocked`, `held`, `denied_host`, `not_allowed_host`, `not_allowed_url`,
`over_budget`, `alalanet_unreachable`, `bad_402`, `already_paid`, `payment_outcome_unknown`,
`pay_to_unexpected`, `pay_to_lookalike`, `not_delivered_before`, `not_approved` or `decision_expired`. `reasons` lists
alalanet's reasons.

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
- In both modes an option over what is left of your budget is refused by the guard itself, even if
  the verdict allowed it.
- What is sent: only the URL and its 402 terms, the names and versions of your `@x402/*` libraries (and, with `report`, the URL, transaction hash and outcome). No wallet keys, request bodies or responses leave
  your process.

Zero dependencies. Works on Node 18+, Bun, Deno and in browsers. License: MIT-0.
