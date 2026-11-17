// x402-guard: a fetch wrapper that asks alalanet before an x402 payment is signed.
// Put it UNDER your x402 payer: wrapFetchWithPayment(guardFetch(fetch, opts), client).
// The payer then only ever sees payment options alalanet allowed, within your budget.

const PAID_HEADERS = ["PAYMENT-SIGNATURE", "X-PAYMENT"];
const MAX_402_BYTES = 64 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export class X402GuardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "X402GuardError";
    // blocked | held | denied_host | not_allowed_host | not_allowed_url | over_budget | alalanet_unreachable
    // | bad_402 | already_paid | payment_outcome_unknown | pay_to_unexpected | pay_to_lookalike | not_delivered_before
    // | not_approved
    this.code = code;
    Object.assign(this, details);
  }
}

function b64decode(s) {
  const bin = typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("binary");
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function b64encode(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
}

// Best effort, Node only: the versions of the x402 payment libraries installed next to the guard,
// so alalanet can warn about known flaws (their fixes shipped without advisories; npm audit is silent).
let detected;
async function detectClient() {
  if (detected !== undefined) return detected;
  detected = "";
  try {
    if (typeof process === "undefined" || !process.versions?.node) return detected;
    const { createRequire } = await import("node:module");
    const { readFileSync, existsSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const req = createRequire(join(process.cwd(), "noop.js"));
    const found = [];
    for (const name of ["@x402/fetch", "@x402/axios", "@x402/core", "@x402/mcp", "@x402/extensions", "@x402/svm"]) {
      try {
        let dir = dirname(req.resolve(name));
        for (let i = 0; i < 6; i++, dir = dirname(dir)) {
          const pj = join(dir, "package.json");
          if (!existsSync(pj)) continue;
          const j = JSON.parse(readFileSync(pj, "utf8"));
          if (j.name === name && j.version) {
            found.push(`${name}@${j.version}`);
            break;
          }
        }
      } catch {}
    }
    detected = found.join(",");
  } catch {}
  return detected;
}

// --- double-pay protection --------------------------------------------------------------------
// A paid attempt that ends in a timeout, a 5xx or an unclear answer may have settled while the answer
// was lost. Signing a fresh payment for the retry can then pay twice (x402 #3438, #4094). The guard
// holds the signed payment per purchase (method + URL + body) and re-presents it while it is valid:
// an EIP-3009 authorization settles at most once, and a Solana transaction with the same blockhash
// lands at most once. After the window it asks alalanet (payment_status, read on chain) before a new
// payment may go out.

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

function b64bytes(s) {
  const bin = typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("binary");
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// compact-u16 (Solana short_vec)
function shortVec(b, i) {
  let len = 0, shift = 0;
  for (;;) {
    const x = b[i++];
    len |= (x & 0x7f) << shift;
    if (!(x & 0x80)) return [len, i];
    shift += 7;
  }
}

// Signers (besides the fee payer) and the recent blockhash of a serialized Solana transaction.
export function solanaPaymentInfo(txBase64) {
  const b = b64bytes(txBase64);
  let [nsig, i] = shortVec(b, 0);
  i += 64 * nsig;
  if (b[i] & 0x80) i++; // versioned message prefix
  const required = b[i];
  i += 3;
  const [nkeys, j] = shortVec(b, i);
  i = j;
  const keys = [];
  for (let k = 0; k < nkeys; k++, i += 32) keys.push(base58(b.slice(i, i + 32)));
  const blockhash = base58(b.slice(i, i + 32));
  if (keys.length < 1 || i + 32 > b.length) throw new Error("short transaction");
  return { signers: keys.slice(1, required), feePayer: keys[0], blockhash };
}

// What the guard needs to know about a payment header value; null when it cannot be read.
export function paymentInfo(value) {
  try {
    const p = JSON.parse(b64decode(value));
    const network = p.accepted?.network ?? p.network ?? "";
    const maxTimeout = Number(p.accepted?.maxTimeoutSeconds ?? p.maxTimeoutSeconds ?? 0) || 0;
    const auth = p.payload?.authorization;
    if (auth?.from && auth?.nonce) {
      return { kind: "evm", network, from: auth.from, nonce: auth.nonce, validBefore: Number(auth.validBefore) || 0, asset: p.accepted?.asset };
    }
    if (typeof p.payload?.transaction === "string" && String(network).startsWith("solana")) {
      const s = solanaPaymentInfo(p.payload.transaction);
      return { kind: "svm", network, from: s.signers[0], blockhash: s.blockhash, maxTimeout };
    }
  } catch {}
  return null;
}

// Facilitator verdicts are snake_case codes; anything else (a copied exception text, a pending
// settlement, a nonce reported as used) leaves the outcome open (same rule as x402 #4094).
function refusedForSure(settle, required) {
  const reason = settle.errorReason ?? required?.error ?? "";
  if (settle.transaction) return false;
  if (!/^[a-z0-9_]+$/.test(reason)) return false;
  return !(reason === "settlement_pending" || /nonce_already_used|already_used|already_processed/.test(reason));
}

function definiteFailure(response, settle, required) {
  if (response.ok) return false;
  return refusedForSure(settle, required) && (response.status === 402 || settle.success === false);
}

async function purchaseKey(request) {
  let body = "";
  if (request.body) {
    const buf = await request.clone().arrayBuffer();
    if (buf.byteLength) {
      const h = await crypto.subtle.digest("SHA-256", buf);
      body = Array.from(new Uint8Array(h), (x) => x.toString(16).padStart(2, "0")).join("");
    }
  }
  return `${request.method} ${request.url} ${body}`;
}

function hostMatches(host, patterns) {
  return (patterns || []).some((p) => {
    p = String(p).toLowerCase();
    return host === p || (p.startsWith("*.") && host.endsWith(p.slice(1)));
  });
}

// A URL prefix matches on the same origin, by the start of the path (and query). strict (allow
// lists): only at a segment boundary, and never a path with an encoded slash, backslash or dot or a
// ';' (Tomcat, Jetty and Spring read "..;" as ".."), which the server could resolve into another path.
// Not strict (expectPayTo): any URL that starts with the prefix, so the pin applies on the safe side.
function prefixMatches(url, prefix, strict = true) {
  try {
    const u = new URL(url);
    const p = new URL(prefix);
    const path = u.pathname + u.search;
    const start = p.pathname + p.search;
    if (u.origin !== p.origin || !path.startsWith(start)) return false;
    if (!strict) return true;
    if (/%2f|%5c|%2e|;/i.test(u.pathname)) return false;
    return path.length === start.length || start.endsWith("/") || "/?&".includes(path[start.length]);
  } catch {
    return false;
  }
}

const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

function optionMatches(accept, allowed) {
  const amount = accept.amount ?? accept.maxAmountRequired;
  return allowed.some((o) => same(o.pay_to, accept.payTo) && same(o.asset, accept.asset) && String(o.amount) === String(amount));
}

// A payee as compared: an EVM address without 0x and case; any other address (Solana, TRON) as written.
const payeeKey = (a) => (/^0x[0-9a-f]+$/i.test(String(a)) ? String(a).slice(2).toLowerCase() : String(a ?? ""));
const samePayee = (a, b) => payeeKey(a) === payeeKey(b);
// Another address with the same first and last four characters: made to pass a glance.
function lookalike(a, b) {
  const x = payeeKey(a);
  const y = payeeKey(b);
  return x !== y && x.length === y.length && x.length > 8 && x.slice(0, 4) === y.slice(0, 4) && x.slice(-4) === y.slice(-4);
}

// The payee of a payment header value (x402 v2 accepted.payTo, or the EIP-3009 authorization's to).
function payeeOf(value) {
  try {
    const p = JSON.parse(b64decode(value));
    return p.accepted?.payTo ?? p.payload?.authorization?.to;
  } catch {
    return undefined;
  }
}

const VERSION = "2.0";
const MEMORY = 1000; // entries kept per guard: payees paid, resources paid, sellers that did not deliver
const RESERVE_MS = 5 * 60 * 1000; // wrapper: how long an approved 402's share counts while it waits for its payment
const APPROVAL_MS = RESERVE_MS + 15 * 60 * 1000; // wrapper: how long an approved 402 may still be paid
const PAY_TO_CHANGED_MS = 15 * 60 * 1000; // hook: how long a resource just paid may not ask for another payee

// alalanet's hold reasons that only say it has no data on the seller yet. Every other hold reason
// compares the payment against data (a listing, earlier 402s, the trust score, the asset), and so
// does any reason the guard does not know; none of those is paid as new. Blocks (quote_expired, over_budget, ...) are never paid.
const NEW_SELLER = new Set(["unknown_service", "not_checked_yet", "not_rated_yet", "pay_to_never_seen"]);
// reasons alalanet gives as information only
const INFO = new Set(["testnet", "frozen_status_unknown", "pay_to_as_observed", "pay_to_platform_wallet", "amount_is_ceiling"]);

// Sets key last in a map that keeps at most MEMORY entries, the oldest dropped first.
function bounded(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MEMORY) map.delete(map.keys().next().value);
  return value;
}

// Asks alalanet about one 402. mode ("fetch" or "hook") goes into the user agent, so alalanet can
// count how often each way of plugging in is used (no other data about the caller).
function makePreflight(opts, mode) {
  const api = (opts.api || "https://alalanet.com").replace(/\/$/, "");
  const call = opts.fetch || globalThis.fetch.bind(globalThis);
  const ua = `${opts.userAgent ? `${opts.userAgent} ` : ""}x402-guard/${VERSION} (${mode})`;
  let warned = false;
  async function preflight(url, paymentRequired, maxUsd) {
    const headers = { "content-type": "application/json", "user-agent": ua };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const body = { url, payment_required: paymentRequired };
    if (maxUsd !== undefined) body.max_usd = maxUsd;
    const client = opts.client ?? (opts.detectClient === false ? "" : await detectClient());
    if (client) body.client = client;
    const res = await call(`${api}/v1/preflight`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`alalanet preflight HTTP ${res.status}`);
    const verdict = await res.json();
    if (verdict.client_advisories?.length && !warned) {
      warned = true;
      if (opts.onAdvisory) opts.onAdvisory(verdict.client_advisories);
      else
        console.warn(
          "x402-guard: your x402 payment library has known flaws, update it: " +
            verdict.client_advisories.map((a) => `${a.package} < ${a.fixed_in} (${a.severity}): ${a.summary}`).join(" | "),
        );
    }
    return verdict;
  }
  return { api, call, ua, preflight };
}

// What is left of the per-call, daily and per-seller budgets, or the code of the limit hit.
function budgetLeft(opts, spentToday, host) {
  let maxUsd = opts.maxUsdPerCall;
  if (opts.maxUsdPerDay !== undefined) {
    const left = opts.maxUsdPerDay - spentToday();
    if (left <= 1e-9) return { over: "x402-guard: daily budget spent" };
    maxUsd = maxUsd === undefined ? left : Math.min(maxUsd, left);
  }
  if (opts.maxUsdPerHostPerDay !== undefined) {
    const left = opts.maxUsdPerHostPerDay - spentToday(host);
    if (left <= 1e-9) return { over: `x402-guard: daily budget for ${host} spent` };
    maxUsd = maxUsd === undefined ? left : Math.min(maxUsd, left);
  }
  return { maxUsd: maxUsd === undefined ? undefined : Math.round(maxUsd * 1e6) / 1e6 };
}

// The rules both modes share: the 24 h ledger, which verdicts may be paid, the URL scope, the payees.
function makeRules(opts) {
  const onHold = opts.onHold || "new";
  const capCall = opts.newSeller?.maxUsdPerCall ?? 0.05;
  const capDay = opts.newSeller?.maxUsdPerDay ?? 0.25;
  // {at, usd, host, fresh}: fresh counts against the new-seller caps; until is set while a wrapper
  // reservation waits for its payment, and it stops counting after that
  const entries = [];

  function spent(host, fresh) {
    const now = Date.now();
    while (entries.length && now - entries[0].at > DAY_MS) entries.shift();
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].until <= now) entries.splice(i, 1); // unused reservations
    return entries.filter((e) => (host === undefined || e.host === host) && (!fresh || e.fresh)).reduce((s, e) => s + e.usd, 0);
  }
  const add = (e) => (entries.push(e), e);
  const drop = (e) => {
    const i = entries.indexOf(e);
    if (i >= 0) entries.splice(i, 1);
  };
  const newLeft = () => capDay - spent(undefined, true);

  const isNew = (o) => {
    const reasons = o.reasons || [];
    return reasons.some((r) => NEW_SELLER.has(r)) && reasons.every((r) => NEW_SELLER.has(r) || INFO.has(r));
  };
  // May this option be paid? {pay, fresh}; why: a new seller over the new-seller caps. scoped: the
  // URL checked was named by the 402 while allow lists are set, so they cannot bound a new seller.
  function judge(o, left, scoped = false) {
    if (o.decision === "allow") return { pay: true };
    if (o.decision !== "hold") return { pay: false };
    if (onHold === "allow") return { pay: true };
    if (onHold !== "new" || !isNew(o)) return { pay: false };
    if (scoped) {
      return { pay: false, why: "the 402 names the URL, so your allowHosts / allowUrlPrefixes cannot bound a new seller (pin its payee with expectPayTo, or use guardFetch)" };
    }
    if (typeof o.usd !== "number") return { pay: false, why: "a new seller's price is unknown in US dollars" };
    if (o.usd > capCall + 1e-9) return { pay: false, why: `a new seller's ${o.usd} USD is over the new-seller cap of ${capCall} USD a payment` };
    if (o.usd > left + 1e-9) {
      return { pay: false, why: `a new seller's ${o.usd} USD is over what is left of the new-seller cap of ${capDay} USD a day (${Math.round(left * 1e6) / 1e6})` };
    }
    return { pay: true, fresh: true };
  }

  const pins = Object.entries(opts.expectPayTo || {}).map(([where, payTo]) => [where, [].concat(payTo)]);
  const paid = new Map(); // "host payee" -> {host, payTo}: payees this guard paid, per host
  const covers = (url, host, where) => (/^https?:\/\//i.test(where) ? prefixMatches(url, where, false) : hostMatches(host, [where]));
  const pinsFor = (url, host) => pins.filter(([where]) => covers(url, host, where));
  // the URL has a pin and this payee is on it
  const pinned = (url, host, payTo) => pinsFor(url, host).some(([, list]) => list.some((p) => samePayee(p, payTo)));

  // [code, why] when the URL is outside the caller's scope.
  function outOfScope(url, host) {
    if (hostMatches(host, opts.denyHosts)) return ["denied_host", `${host} is on your deny list`];
    const hosts = opts.allowHosts;
    const prefixes = opts.allowUrlPrefixes;
    if (!hosts && !prefixes) return null;
    if (hosts && hostMatches(host, hosts)) return null;
    if (prefixes && prefixes.some((p) => prefixMatches(url, p))) return null;
    if (prefixes) return ["not_allowed_url", `${url} is not under your allowed URL prefixes${hosts ? " or hosts" : ""}`];
    return ["not_allowed_host", `${host} is not on your allow list`];
  }

  // [code, why] when this payee must not be paid for this URL. paidToo: also compare it with the
  // payees paid on this host (not done for an option alalanet allows: its listing vouches for it, and
  // a ground look-alike paid once must not lock the honest payee out).
  function badPayee(url, host, payTo, paidToo) {
    if (pinsFor(url, host).length) return pinned(url, host, payTo) ? null : ["pay_to_unexpected", `${payTo} is not the payee you expect for ${url}`];
    const known = pins.flatMap(([, list]) => list);
    if (paidToo) for (const p of paid.values()) if (p.host === host) known.push(p.payTo);
    const like = known.find((p) => lookalike(p, payTo));
    if (like) return ["pay_to_lookalike", `${payTo} looks like ${like}, which you paid on ${host} or expect, but is another address`];
    return null;
  }
  const rememberPayee = (host, payTo) => payTo && bounded(paid, `${host} ${payeeKey(payTo)}`, { host, payTo: String(payTo) });

  return { spent, add, drop, newLeft, judge, outOfScope, badPayee, pinned, rememberPayee };
}

// The cheapest allowed options per payee, network and asset (every one at that price), cheapest
// first; options without a dollar price after the others.
function cheapestFirst(options) {
  const group = (o) => `${payeeKey(o.pay_to)} ${String(o.network_id ?? o.network).toLowerCase()} ${String(o.asset).toLowerCase()}`;
  const min = new Map();
  for (const o of options) {
    if (typeof o.usd !== "number") continue;
    const m = min.get(group(o));
    if (m === undefined || o.usd < m) min.set(group(o), o.usd);
  }
  const price = (o) => (typeof o.usd === "number" ? o.usd : Infinity);
  return options.filter((o) => typeof o.usd !== "number" || o.usd <= min.get(group(o)) + 1e-12).sort((a, b) => price(a) - price(b));
}

/**
 * Wrap fetch so that every x402 402 response is judged by alalanet before your payer signs.
 * @param {typeof fetch} inner the fetch your x402 payer would use
 * @param {import('./index').GuardOptions} [opts]
 * @returns {typeof fetch}
 */
export function guardFetch(inner, opts = {}) {
  const { api, call, ua, preflight } = makePreflight(opts, "fetch");
  const rules = makeRules(opts);
  const pending = new Map(); // url -> [{at, entry, allowed}]: approved 402s waiting for their payment, oldest first
  const holds = new Map(); // purchase key -> held payment {header, value, info, until, settledTx?, entry?}
  const notDelivered = new Map(); // "host payee" -> {payTo, at}: took a payment there and did not deliver
  const SVM_WINDOW_MS = 60 * 1000; // a Solana blockhash is valid for about 60-90 s

  function windowEnd(info) {
    if (info.kind === "evm" && info.validBefore) return info.validBefore * 1000 - 2000;
    return Date.now() + (info.kind === "svm" ? SVM_WINDOW_MS : 0);
  }

  async function reconcile(info) {
    const q = new URLSearchParams({ network: info.network, from: info.from });
    if (info.kind === "evm") {
      q.set("nonce", info.nonce);
      if (info.validBefore) q.set("valid_before", String(info.validBefore));
      if (info.asset) q.set("asset", info.asset);
    } else q.set("blockhash", info.blockhash);
    const headers = { "user-agent": ua };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await call(`${api}/v1/payment-status?${q}`, { headers });
    if (!res.ok) throw new Error(`alalanet payment-status HTTP ${res.status}`);
    return res.json();
  }

  function prune() {
    if (holds.size < 500) return;
    const now = Date.now();
    for (const [k, h] of holds) if (now - h.until > 15 * 60 * 1000) holds.delete(k);
  }

  // Decide which payment header goes out for this purchase: the held one, a fresh one, or none.
  // created: this call started holding the payment (new money goes out).
  async function choosePayment(request, key) {
    const name = PAID_HEADERS.find((h) => request.headers.has(h));
    const value = request.headers.get(name);
    const held = holds.get(key);
    if (held?.settledTx) {
      throw new X402GuardError("already_paid", `x402-guard: this purchase was already paid (tx ${held.settledTx}); not paying again`, {
        url: request.url, tx: held.settledTx,
      });
    }
    if (held && held.value !== value) {
      if (Date.now() < held.until) {
        if (opts.onRepresent) opts.onRepresent({ url: request.url, info: held.info });
        const headers = new Headers(request.headers);
        headers.delete(name);
        headers.set(held.header, held.value);
        return { request: new Request(request, { headers }), held, created: false };
      }
      let st;
      try {
        st = await reconcile(held.info);
      } catch (e) {
        throw new X402GuardError("payment_outcome_unknown", `x402-guard: an earlier payment for this purchase may have settled and alalanet could not confirm it (${e.message}); not signing another`, {
          url: request.url, held: held.info,
        });
      }
      if (opts.onReconcile) opts.onReconcile({ url: request.url, status: st });
      if (st.retry === "do_not_pay_again") {
        held.settledTx = st.tx || "on chain";
        throw new X402GuardError("already_paid", `x402-guard: the earlier payment for this purchase settled (${st.tx || st.state}); not paying again`, {
          url: request.url, tx: st.tx, status: st,
        });
      }
      if (st.retry === "resend_same") {
        const headers = new Headers(request.headers);
        headers.delete(name);
        headers.set(held.header, held.value);
        held.until = Date.now() + (held.info.kind === "svm" ? SVM_WINDOW_MS : 30000);
        return { request: new Request(request, { headers }), held, created: false };
      }
      if (!st.safe_to_sign_new) {
        throw new X402GuardError("payment_outcome_unknown", `x402-guard: an earlier payment for this purchase is ${st.state}; not signing another yet (${st.advice || ""})`, {
          url: request.url, status: st,
        });
      }
      holds.delete(key);
    }
    if (!holds.has(key)) {
      const info = paymentInfo(value);
      if (info) {
        prune();
        holds.set(key, { header: name, value, info, until: windowEnd(info) });
        return { request, held: holds.get(key), created: true };
      }
    }
    return { request, held: holds.get(key), created: false };
  }

  // The queue an approval for this URL joins. At most 100 per URL and MEMORY URLs wait (each up to
  // APPROVAL_MS); past that the 402 is refused, never another URL's approval evicted: its payment
  // would then be refused as not approved.
  function roomFor(url, verdict) {
    const now = Date.now();
    for (const [u, q] of pending) {
      while (q.length && now - q[0].at > APPROVAL_MS) q.shift();
      if (!q.length) pending.delete(u);
    }
    const queue = pending.get(url) || [];
    if (queue.length >= 100 || (!queue.length && pending.size >= MEMORY)) {
      throw new X402GuardError("over_budget", `x402-guard: too many 402s are waiting for their payment (${queue.length ? `100 for ${url}` : `${MEMORY} URLs`}); not paying ${url}`, { url, verdict });
    }
    pending.set(url, queue);
    return queue;
  }

  // The oldest reservation for this URL, bound to the payment that is going out: counted from now
  // on, until a definite failure. One that no longer counts (the payer took more than RESERVE_MS, or
  // it came back after a definite refusal) needs room in the budgets again, or nothing is sent.
  function takeReservation(url) {
    const queue = pending.get(url) || [];
    let r = queue.shift();
    while (r && Date.now() - r.at > APPROVAL_MS) {
      if (r.entry) rules.drop(r.entry);
      r = queue.shift(); // lapsed: it approves nothing any more
    }
    if (!queue.length) pending.delete(url);
    if (!r?.entry) return r; // none, or a failOpen pass (not checked, not counted)
    const { usd, host, fresh, until } = r.entry;
    rules.drop(r.entry);
    if (until <= Date.now()) {
      const b = budgetLeft(opts, rules.spent, host);
      const room = !b.over && (b.maxUsd === undefined || usd <= b.maxUsd + 1e-9) && (!fresh || usd <= rules.newLeft() + 1e-9);
      if (!room) throw new X402GuardError("over_budget", "x402-guard: this payment's approval no longer holds a share of your budget, and the budget has no room for it now; not sending it", { url });
    }
    r.entry = rules.add({ at: Date.now(), usd, host, fresh });
    return r;
  }

  function reportPurchase(url, info, outcome) {
    const send = (attempt) =>
      call(`${api}/v1/purchases`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": ua },
        body: JSON.stringify({ service_url: url, tx: info.tx, network: info.network, outcome }),
      })
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          // A just-settled payment can take a moment to reach every RPC node: retry a few times.
          if (attempt < 3 && (res.status === 503 || (res.status === 400 && /not found/.test(body.hint || "")))) {
            setTimeout(() => send(attempt + 1), 5000 * (attempt + 1));
            return;
          }
          if (opts.onReport) opts.onReport({ url, outcome, ok: res.ok, status: res.status, result: body });
        })
        .catch(() => {});
    send(0);
  }

  return async function guarded(input, init) {
    let request = new Request(input, init);
    const url = request.url;
    const isPaid = PAID_HEADERS.some((h) => request.headers.has(h));
    // to tell a retry of a held purchase from a new one, should a payee here turn out not to deliver
    const probe = !isPaid && request.body ? request.clone() : request;
    let key, held, created, reserved;
    if (isPaid) {
      reserved = takeReservation(url);
      if (opts.holdPayments !== false) {
        key = await purchaseKey(request);
        try {
          ({ request, held, created } = await choosePayment(request, key));
        } catch (e) {
          if (reserved) rules.drop(reserved.entry); // nothing went out
          throw e;
        }
      }
    }
    const again = Boolean(held && !created); // the held payment goes out again: no new money
    if (isPaid && !again && !reserved) {
      // new money for a 402 this guard did not judge, or whose approval lapsed: nothing was approved
      if (created) holds.delete(key);
      throw new X402GuardError("not_approved", `x402-guard: no 402 of ${url} was approved for this payment in the last ${APPROVAL_MS / 60000} minutes; not sending it`, { url });
    }
    if (again && reserved) rules.drop(reserved.entry);
    if (created && reserved) held.entry = reserved.entry;
    const sent = again ? held.entry : reserved?.entry; // the budget entry of the payment going out
    const response = await inner(request); // a throw (timeout, network) keeps the hold and the budget entry

    if (isPaid) {
      const header = response.headers.get("PAYMENT-RESPONSE") || response.headers.get("X-PAYMENT-RESPONSE");
      let settle = {};
      try {
        if (header) settle = JSON.parse(b64decode(header));
      } catch {}
      let required;
      try {
        const pr = response.headers.get("PAYMENT-REQUIRED");
        if (pr) required = JSON.parse(b64decode(pr));
      } catch {}
      const definite = definiteFailure(response, settle, required);
      if (key !== undefined && holds.has(key) && ((response.ok && settle.success !== false) || definite)) holds.delete(key);
      if (definite && sent) rules.drop(sent);
      if (definite && reserved) {
        // nothing was taken: the approval goes back first in line, holding no share until it is used,
        // so a payment the client signs again (a recovery) is judged and counted, not refused
        const e = reserved.entry;
        const queue = pending.get(url) || [];
        if (queue.length < 100 && (queue.length || pending.size < MEMORY)) {
          queue.unshift({ at: reserved.at, entry: e && { at: Date.now(), usd: e.usd, host: e.host, fresh: e.fresh, until: 0 }, allowed: reserved.allowed });
          pending.set(url, queue);
        }
      }
      const approved = reserved?.allowed || [];
      const usd = approved.length ? Math.max(...approved.map((o) => o.usd || 0)) : 0;
      const paid = settle.success === true || (settle.success !== false && response.ok);
      const payTo = payeeOf(request.headers.get(PAID_HEADERS.find((h) => request.headers.has(h))));
      const paidHost = new URL(url).hostname.toLowerCase();
      if (paid) rules.rememberPayee(paidHost, payTo);
      if (!response.ok && !definite && payTo && opts.onNotDelivered !== "allow") bounded(notDelivered, `${paidHost} ${payeeKey(payTo)}`, { payTo, at: Date.now() });
      const info = { url, paid, status: response.status, tx: settle.transaction, network: settle.network, payer: settle.payer, usd: paid ? usd : 0, response };
      if (opts.onPaid) await opts.onPaid(info);
      if (opts.report && paid && info.tx && info.network) {
        // Report the outcome bound to the payment (verified on chain by alalanet). Never blocks the caller.
        const outcome = typeof opts.report === "function" ? opts.report(info) : response.ok ? "delivered" : "not_delivered";
        if (outcome) reportPurchase(url, info, outcome);
      }
      return response;
    }
    if (response.status !== 402) return response;

    const host = new URL(url).hostname.toLowerCase();
    const scope = rules.outOfScope(url, host);
    if (scope) throw new X402GuardError(scope[0], `x402-guard: ${scope[1]}`, { url });

    const text = (await response.text()).slice(0, MAX_402_BYTES);
    const header = response.headers.get("PAYMENT-REQUIRED");
    if (!header && !text) throw new X402GuardError("bad_402", "x402-guard: 402 without payment terms", { url });

    const budget = budgetLeft(opts, rules.spent, host);
    if (budget.over) throw new X402GuardError("over_budget", budget.over, { url });
    // a retry of a purchase whose payment is held re-presents that payment: no new money to that payee
    const retrying = notDelivered.size > 0 && holds.has(await purchaseKey(probe));

    let verdict;
    try {
      verdict = await preflight(url, header || text, budget.maxUsd);
    } catch (e) {
      if (opts.failOpen) {
        roomFor(url).push({ at: Date.now(), entry: null, allowed: [] }); // a pass: not checked, not counted
        return new Response(text, { status: 402, headers: response.headers });
      }
      throw new X402GuardError("alalanet_unreachable", `x402-guard: could not get a decision (${e.message}); not paying`, { url });
    }
    if (opts.onDecision) opts.onDecision({ url, ...verdict });

    // From here to the reservation nothing awaits: 402s judged meanwhile have reserved their share.
    const now = budgetLeft(opts, rules.spent, host);
    if (now.over) throw new X402GuardError("over_budget", now.over, { url, verdict });
    const maxUsd = now.maxUsd;
    const options = verdict.options || [];
    const left = rules.newLeft();
    const judged = new Map(options.map((o) => [o, rules.judge(o, left)]));
    const ok = options.filter((o) => judged.get(o).pay);
    const refusal = (o) => {
      const bad = rules.badPayee(url, host, o.pay_to, o.decision !== "allow");
      if (bad) return bad;
      if (!retrying && notDelivered.has(`${host} ${payeeKey(o.pay_to)}`)) {
        return ["not_delivered_before", `${o.pay_to} took a payment and did not deliver; not paying it again (onNotDelivered: "allow" pays it)`];
      }
      return null;
    };
    const refusals = ok.map(refusal);
    const passed = ok.filter((o, i) => !refusals[i]);
    if (ok.length && !passed.length) {
      const [code, why] = refusals[0];
      throw new X402GuardError(code, `x402-guard: ${why}; not paying ${url}`, { url, verdict });
    }
    // alalanet blocks options above max_usd; the budget is also checked here, in case it did not
    const affordable = (o) => maxUsd === undefined || (typeof o.usd === "number" && o.usd <= maxUsd + 1e-9);
    const allowed = cheapestFirst(passed.filter(affordable));
    if (passed.length && !allowed.length) {
      throw new X402GuardError("over_budget", `x402-guard: every allowed option is over what is left of your budget (${maxUsd}); not paying ${url}`, { url, verdict });
    }
    if (!allowed.length) {
      const reasons = [...new Set(options.flatMap((o) => o.reasons || []))];
      const whys = [...new Set(options.map((o) => judged.get(o).why).filter(Boolean))];
      const code = verdict.decision === "hold" ? "held" : "blocked";
      throw new X402GuardError(code, `x402-guard: alalanet says ${verdict.decision} (${reasons.join(", ") || "no reason"})${whys.map((w) => `; ${w}`).join("")}; not paying ${url}`, {
        url, decision: verdict.decision, reasons, verdict,
      });
    }
    // Reserve the dearest option handed over until its payment comes (or RESERVE_MS passes). An
    // approval waits APPROVAL_MS for its payment; at most 100 per URL and MEMORY URLs wait, and past
    // that the 402 is refused: a dropped one would leave its payment unapproved.
    const queue = roomFor(url, verdict);
    const at = Date.now();
    const entry = rules.add({ at, usd: Math.max(...allowed.map((o) => o.usd || 0)), host, fresh: allowed.some((o) => judged.get(o).fresh), until: at + RESERVE_MS });
    queue.push({ at, entry, allowed });

    // Hand the payer only the allowed options, in the order of `allowed` (cheapest first).
    const rank = (a) => allowed.findIndex((o) => optionMatches(a, [o]) && (o.network_id === undefined || same(o.network_id, a.network)));
    const order = (accepts) =>
      (accepts || [])
        .map((a) => [a, rank(a)])
        .filter(([, i]) => i >= 0)
        .sort((x, y) => x[1] - y[1])
        .map(([a]) => a);
    const headers = new Headers(response.headers);
    if (header) {
      try {
        const pr = JSON.parse(b64decode(header));
        pr.accepts = order(pr.accepts);
        headers.set("PAYMENT-REQUIRED", b64encode(JSON.stringify(pr)));
      } catch {
        throw new X402GuardError("bad_402", "x402-guard: unreadable PAYMENT-REQUIRED header", { url });
      }
    }
    let body = text;
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j.accepts)) {
        j.accepts = order(j.accepts);
        body = JSON.stringify(j);
      }
    } catch {}
    headers.delete("content-length");
    return new Response(body, { status: 402, statusText: response.statusText, headers });
  };
}

// --- the official x402 client hook ---------------------------------------------------------------
// @x402/core's x402Client runs onBeforePaymentCreation before any payment is signed, and @x402/fetch,
// @x402/axios and @x402/mcp all create payments through it: one line covers all three. The hook can
// refuse a payment but cannot swap the option the client chose; the guard's client policy drops a
// payee's dearer options before the client chooses, and an allowed alternative is named in the
// reason. Re-presenting a signed payment on retries needs the transport: use guardFetch for that.

// x402Client policy: of the options to one payee on one network, in one asset and scheme, only the
// cheapest. The client's selector then chooses among what is left.
function cheapestPolicy(version, reqs) {
  const amount = (r) => {
    try {
      return BigInt(r.amount ?? r.maxAmountRequired);
    } catch {
      return undefined;
    }
  };
  const group = (r) => `${payeeKey(r.payTo)} ${r.network} ${String(r.asset).toLowerCase()} ${r.scheme}`;
  const min = new Map();
  for (const r of reqs) {
    const a = amount(r);
    if (a === undefined) continue;
    const m = min.get(group(r));
    if (m === undefined || a < m) min.set(group(r), a);
  }
  return reqs.filter((r) => {
    const a = amount(r);
    return a === undefined || a === min.get(group(r));
  });
}

/**
 * The hooks and the client policy, for wiring them yourself. Most callers use alalanetGuard(client, opts).
 * @param {import('./index').GuardOptions & import('./index').HookOptions} [opts]
 */
export function alalanetHooks(opts = {}) {
  const { preflight } = makePreflight(opts, "hook");
  const rules = makeRules(opts);
  // Every approved payment counts from the moment it is approved, so parallel payments cannot all
  // pass one budget. It is never freed on the seller's word (a seller alalanet allows could settle,
  // answer "failed" and be paid again and again): only when the payment was never created, which
  // the client itself reports (onPaymentCreationFailure). The entry is bound to the option object
  // the client chose, so a failure frees that payment and not another seller's.
  const byOption = new WeakMap(); // selectedRequirements -> entries approved for it, newest last
  // An unchecked payment (failOpen, onUnchecked: "allow") records a placeholder, so its failure
  // cannot free the entry of an earlier payment made with the same option object.
  const remember = (req, entry) => {
    if (!req || typeof req !== "object") return;
    if (!byOption.has(req)) byOption.set(req, []);
    byOption.get(req).push(entry);
  };
  // The payment approved per resource (the 402's own resource URL, e.g. mcp://tool/<name>, else the
  // URL checked), {url, payTo, at, until, keep}: until its validBefore no second payment for the
  // resource, until keep none to another payee. A settled payment or a definite refusal ends it.
  const paidFor = new Map();
  const current = (e) => Boolean(e?.mark) && paidFor.get(e.mark.url) === e.mark;

  const refuse = (code, message, details) => {
    if (opts.onAbort) opts.onAbort({ code, reasons: [], ...details, message });
    return { abort: true, reason: `x402-guard ${code}: ${message}` };
  };

  // [code, why] when a payment for this resource is still open (any payee), or it was just paid to
  // another payee that alalanet does not vouch for (allow: it matches the listing). vouched undefined:
  // the verdict is not known yet, so only the same payee is refused.
  function repeat(url, payTo, vouched) {
    const m = paidFor.get(url);
    const now = Date.now();
    if (!m || now >= m.keep) return null;
    const other = !samePayee(m.payTo, payTo);
    if (other && vouched === false) return ["pay_to_changed", `${url} was just paid to ${m.payTo} and now asks for ${payTo}; not paying the new address`];
    if (now < m.until && (!other || vouched)) return ["already_paid", `a payment for ${url} went out ${Math.round((now - m.at) / 1000)} s ago and is still open; not paying again`];
    return null;
  }

  // The verdict for the option the client chose: by its network when alalanet names it, otherwise the
  // strictest of the options with the same payTo, asset and amount.
  const rank = { block: 0, hold: 1, allow: 2 };
  function verdictFor(req, options) {
    const exact = options.filter((o) => optionMatches(req, [o]) && (o.network_id === undefined || same(o.network_id, req.network)));
    return exact.sort((a, b) => (rank[a.decision] ?? 0) - (rank[b.decision] ?? 0))[0];
  }
  const sameNetwork = (a, b) => same(a.network_id ?? a.network, b.network_id ?? b.network);

  async function onBeforePaymentCreation(ctx) {
    const req = ctx.selectedRequirements;
    const named = ctx.paymentRequired?.resource?.url || req.resource || "";
    // A function is your own code and decides; a plain string fills in when the 402 names no https URL.
    let url = typeof opts.resourceUrl === "function" ? opts.resourceUrl(ctx) || named : named;
    if (typeof opts.resourceUrl === "string" && !/^https:\/\//i.test(url)) url = opts.resourceUrl;
    if (!/^https:\/\//i.test(url)) {
      if (opts.onUnchecked === "allow") return remember(req, null);
      return refuse("unchecked", `no https URL of the paid service to check (${url || "none"}); pass resourceUrl (e.g. your MCP server's URL) or onUnchecked: "allow"`, { url });
    }
    const host = new URL(url).hostname.toLowerCase();
    const scope = rules.outOfScope(url, host);
    if (scope) return refuse(scope[0], scope[1], { url });
    const payee = rules.badPayee(url, host, req.payTo, false);
    if (payee) return refuse(payee[0], `${payee[1]}; not paying ${url}`, { url });
    const before = budgetLeft(opts, rules.spent, host);
    if (before.over) return refuse("over_budget", before.over.replace(/^x402-guard: /, ""), { url });
    const resource = named || url;
    const open = repeat(resource, req.payTo); // another payee waits for alalanet's verdict
    if (open) return refuse(open[0], open[1], { url });

    let verdict;
    try {
      verdict = await preflight(url, JSON.stringify(ctx.paymentRequired), before.maxUsd);
    } catch (e) {
      if (opts.failOpen) return remember(req, null);
      return refuse("alalanet_unreachable", `could not get a decision (${e.message}); not paying`, { url });
    }
    if (opts.onDecision) opts.onDecision({ url, ...verdict });

    // From here to the record nothing awaits: payments approved while alalanet answered are counted.
    const left = rules.newLeft();
    // the 402 named the URL: allow lists bound a new seller only through a pinned payee
    const fromThe402 = Boolean(opts.allowHosts || opts.allowUrlPrefixes) && typeof opts.resourceUrl !== "function" && url === named;
    const judge = (o) => rules.judge(o, left, fromThe402 && !rules.pinned(url, host, o.pay_to));
    const options = verdict.options || [];
    const chosen = verdictFor(req, options);
    const judgment = chosen && judge(chosen);
    if (!chosen || !judgment.pay) {
      const reasons = chosen?.reasons?.length ? chosen.reasons : [...new Set(options.flatMap((o) => o.reasons || []))];
      const decision = chosen?.decision || verdict.decision || "block";
      const others = options.filter((o) => o !== chosen && judge(o).pay);
      const instead = others.length ? `; allowed instead: ${others.map((o) => `${o.pay_to} ${o.amount} on ${o.network}`).join(", ")}` : "";
      const why = judgment?.why ? `; ${judgment.why}` : "";
      return refuse(decision === "hold" ? "held" : "blocked", `alalanet says ${decision} (${reasons.join(", ") || "no reason"})${why}; not paying ${url}${instead}`, {
        url, decision, reasons, verdict,
      });
    }
    // An allowed option to the same payee on the same network, for less, that this client can pay.
    const accepts = ctx.paymentRequired?.accepts || [];
    const cheaper = options.find(
      (o) =>
        typeof o.usd === "number" && typeof chosen.usd === "number" && o.usd < chosen.usd - 1e-12 &&
        samePayee(o.pay_to, chosen.pay_to) && sameNetwork(o, chosen) && same(o.asset, chosen.asset) && judge(o).pay &&
        accepts.some((a) => a.scheme === req.scheme && optionMatches(a, [o])),
    );
    if (cheaper) {
      return refuse("cheaper_option", `${cheaper.usd} USD to ${cheaper.pay_to} on ${cheaper.network} is allowed and cheaper than the chosen ${chosen.usd} USD; not paying ${url}`, { url, verdict });
    }
    // The budget again, now: other payments may have been approved while alalanet answered. alalanet
    // blocks options above max_usd; this is checked here too, and a price alalanet could not put in
    // dollars is refused when a budget is set.
    const now = budgetLeft(opts, rules.spent, host);
    if (now.over) return refuse("over_budget", now.over.replace(/^x402-guard: /, ""), { url, verdict });
    if (now.maxUsd !== undefined) {
      if (chosen.usd === undefined || chosen.usd === null) {
        return refuse("over_budget", `the price is unknown in US dollars (${chosen.amount} of ${chosen.asset}) and you set a budget; not paying ${url}`, { url, verdict });
      }
      if (chosen.usd > now.maxUsd + 1e-9) {
        return refuse("over_budget", `${chosen.usd} USD is over what is left of your budget (${now.maxUsd}); not paying ${url}`, { url, verdict });
      }
    }
    const vouched = chosen.decision === "allow";
    const like = rules.badPayee(url, host, req.payTo, !vouched);
    if (like) return refuse(like[0], `${like[1]}; not paying ${url}`, { url, verdict });
    const still = repeat(resource, req.payTo, vouched);
    if (still) return refuse(still[0], still[1], { url, verdict });
    const at = Date.now();
    const entry = rules.add({ at, usd: chosen.usd || 0, host, fresh: Boolean(judgment.fresh), vouched });
    if (opts.holdPayments !== false) {
      const until = at + (Number(req.maxTimeoutSeconds) || 60) * 1000;
      entry.mark = bounded(paidFor, resource, { url: resource, payTo: req.payTo, at, until, keep: Math.max(until, at + PAY_TO_CHANGED_MS) });
    }
    remember(req, entry);
  }

  // The payment was created: its payee counts as paid (look-alikes of it are refused), and its own
  // validBefore, when it has one, says how long it stays open.
  async function onAfterPaymentCreation(ctx) {
    const e = (byOption.get(ctx.selectedRequirements) || []).at(-1);
    // the host is the one the 402 names: only a payee alalanet allowed (its listing) is learned
    if (e?.vouched) rules.rememberPayee(e.host, ctx.selectedRequirements.payTo);
    const vb = Number(ctx.paymentPayload?.payload?.authorization?.validBefore);
    if (current(e) && vb > 0) {
      e.mark.until = vb * 1000;
      e.mark.keep = Math.max(e.mark.keep, e.mark.until);
    }
  }

  // The paid request's answer (the client reports it): settled, or refused for sure with a
  // facilitator code and no transaction, ends the resource's mark. Anything else keeps it.
  async function onPaymentResponse(ctx) {
    const s = ctx.settleResponse;
    const settled = s?.success === true;
    const refused = s ? s.success === false && refusedForSure(s) : Boolean(ctx.paymentRequired) && refusedForSure({}, ctx.paymentRequired);
    if (!settled && !refused) return;
    const e = (byOption.get(ctx.requirements) || []).findLast(current);
    if (e) paidFor.delete(e.mark.url);
  }

  // The payment was not created (the signer or a scheme failed): nothing was signed or sent, so its
  // share of the budget is free again, and so is its resource. Then the guard stops: failure hooks
  // that run after it may hand back a replacement payment for ANOTHER option (@x402/svm's batch
  // scheme does), which would go out without being checked. Throwing ends the client's hook loop
  // with no payment.
  async function onPaymentCreationFailure(ctx) {
    const entries = byOption.get(ctx.selectedRequirements);
    const entry = entries?.pop();
    if (entry) rules.drop(entry);
    if (current(entry)) paidFor.delete(entry.mark.url);
    const why = ctx.error?.message || String(ctx.error);
    throw Object.assign(new Error(`${why} (x402-guard: no replacement payment is made, it would not be checked)`), { cause: ctx.error });
  }

  return { onBeforePaymentCreation, onAfterPaymentCreation, onPaymentResponse, onPaymentCreationFailure, policy: cheapestPolicy };
}

/**
 * Plug alalanet into the official x402 client (@x402/core): every payment it is about to create is
 * judged first, within your budget. Works for @x402/fetch, @x402/axios and @x402/mcp.
 *   const client = new x402Client();
 *   registerExactEvmScheme(client, { signer });
 *   alalanetGuard(client, { maxUsdPerCall: 0.05, maxUsdPerDay: 2 });
 * @template C
 * @param {C} client an x402Client
 * @param {import('./index').GuardOptions & import('./index').HookOptions} [opts]
 * @returns {C}
 */
export function alalanetGuard(client, opts = {}) {
  const h = alalanetHooks(opts);
  if (typeof client.registerPolicy === "function") client.registerPolicy(h.policy);
  client.onBeforePaymentCreation(h.onBeforePaymentCreation);
  if (typeof client.onAfterPaymentCreation === "function") client.onAfterPaymentCreation(h.onAfterPaymentCreation);
  client.onPaymentCreationFailure(h.onPaymentCreationFailure);
  if (typeof client.onPaymentResponse === "function") client.onPaymentResponse(h.onPaymentResponse);
  return client;
}
