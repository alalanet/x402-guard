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
    // blocked | held | denied_host | not_allowed_host | over_budget | alalanet_unreachable | bad_402
    // | already_paid | payment_outcome_unknown
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
    for (const name of ["@x402/fetch", "@x402/axios", "@x402/core", "@x402/extensions", "@x402/svm"]) {
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
function definiteFailure(response, settle, required) {
  if (response.ok) return false;
  const reason = settle.errorReason ?? required?.error ?? "";
  if (settle.transaction) return false;
  if (!/^[a-z0-9_]+$/.test(reason)) return false;
  if (reason === "settlement_pending" || /nonce_already_used|already_used|already_processed/.test(reason)) return false;
  return response.status === 402 || settle.success === false;
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

const same = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();

function optionMatches(accept, allowed) {
  const amount = accept.amount ?? accept.maxAmountRequired;
  return allowed.some((o) => same(o.pay_to, accept.payTo) && same(o.asset, accept.asset) && String(o.amount) === String(amount));
}

/**
 * Wrap fetch so that every x402 402 response is judged by alalanet before your payer signs.
 * @param {typeof fetch} inner the fetch your x402 payer would use
 * @param {import('./index').GuardOptions} [opts]
 * @returns {typeof fetch}
 */
export function guardFetch(inner, opts = {}) {
  const api = (opts.api || "https://alalanet.com").replace(/\/$/, "");
  const call = opts.fetch || globalThis.fetch.bind(globalThis);
  const onHold = opts.onHold || "block";
  const spent = []; // [{at, usd, host}]
  let warned = false;
  const pending = new Map(); // url -> allowed options from the last preflight
  const holds = new Map(); // purchase key -> held payment {header, value, info, until, settledTx?}
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
    const headers = { "user-agent": "x402-guard/1" };
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
        return { request: new Request(request, { headers }), held };
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
        return { request: new Request(request, { headers }), held };
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
      }
    }
    return { request, held: holds.get(key) };
  }

  const spentToday = (host) => {
    const now = Date.now();
    while (spent.length && now - spent[0].at > DAY_MS) spent.shift();
    return spent.filter((x) => host === undefined || x.host === host).reduce((s, x) => s + x.usd, 0);
  };

  async function preflight(url, paymentRequired, maxUsd) {
    const headers = { "content-type": "application/json", "user-agent": "x402-guard/1" };
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

  function reportPurchase(url, info, outcome) {
    const send = (attempt) =>
      call(`${api}/v1/purchases`, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "x402-guard/1" },
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
    let key;
    if (isPaid && opts.holdPayments !== false) {
      key = await purchaseKey(request);
      ({ request } = await choosePayment(request, key));
    }
    const response = await inner(request); // a throw (timeout, network) keeps the hold

    if (isPaid) {
      const header = response.headers.get("PAYMENT-RESPONSE") || response.headers.get("X-PAYMENT-RESPONSE");
      let settle = {};
      try {
        if (header) settle = JSON.parse(b64decode(header));
      } catch {}
      if (key !== undefined && holds.has(key)) {
        let required;
        try {
          const pr = response.headers.get("PAYMENT-REQUIRED");
          if (pr) required = JSON.parse(b64decode(pr));
        } catch {}
        if ((response.ok && settle.success !== false) || definiteFailure(response, settle, required)) holds.delete(key);
      }
      const approved = pending.get(url) || [];
      pending.delete(url);
      const usd = approved.length ? Math.max(...approved.map((o) => o.usd || 0)) : 0;
      const paid = settle.success === true || (settle.success !== false && response.ok);
      if (paid) spent.push({ at: Date.now(), usd, host: new URL(url).hostname.toLowerCase() });
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
    if (hostMatches(host, opts.denyHosts)) throw new X402GuardError("denied_host", `x402-guard: ${host} is on your deny list`, { url });
    if (opts.allowHosts && !hostMatches(host, opts.allowHosts)) {
      throw new X402GuardError("not_allowed_host", `x402-guard: ${host} is not on your allow list`, { url });
    }

    const text = (await response.text()).slice(0, MAX_402_BYTES);
    const header = response.headers.get("PAYMENT-REQUIRED");
    if (!header && !text) throw new X402GuardError("bad_402", "x402-guard: 402 without payment terms", { url });

    let maxUsd = opts.maxUsdPerCall;
    if (opts.maxUsdPerDay !== undefined) {
      const left = opts.maxUsdPerDay - spentToday();
      if (left <= 0) throw new X402GuardError("over_budget", "x402-guard: daily budget spent", { url });
      maxUsd = maxUsd === undefined ? left : Math.min(maxUsd, left);
    }
    if (opts.maxUsdPerHostPerDay !== undefined) {
      const left = opts.maxUsdPerHostPerDay - spentToday(host);
      if (left <= 0) throw new X402GuardError("over_budget", `x402-guard: daily budget for ${host} spent`, { url });
      maxUsd = maxUsd === undefined ? left : Math.min(maxUsd, left);
    }

    let verdict;
    try {
      verdict = await preflight(url, header || text, maxUsd);
    } catch (e) {
      if (opts.failOpen) return new Response(text, { status: 402, headers: response.headers });
      throw new X402GuardError("alalanet_unreachable", `x402-guard: could not get a decision (${e.message}); not paying`, { url });
    }
    if (opts.onDecision) opts.onDecision({ url, ...verdict });

    const ok = (o) => o.decision === "allow" || (o.decision === "hold" && onHold === "allow");
    const allowed = (verdict.options || []).filter(ok);
    if (!allowed.length) {
      const reasons = [...new Set((verdict.options || []).flatMap((o) => o.reasons || []))];
      const code = verdict.decision === "hold" ? "held" : "blocked";
      throw new X402GuardError(code, `x402-guard: alalanet says ${verdict.decision} (${reasons.join(", ") || "no reason"}); not paying ${url}`, {
        url, decision: verdict.decision, reasons, verdict,
      });
    }
    pending.set(url, allowed);

    // Hand the payer only the allowed options.
    const headers = new Headers(response.headers);
    if (header) {
      try {
        const pr = JSON.parse(b64decode(header));
        pr.accepts = (pr.accepts || []).filter((a) => optionMatches(a, allowed));
        headers.set("PAYMENT-REQUIRED", b64encode(JSON.stringify(pr)));
      } catch {
        throw new X402GuardError("bad_402", "x402-guard: unreadable PAYMENT-REQUIRED header", { url });
      }
    }
    let body = text;
    try {
      const j = JSON.parse(text);
      if (Array.isArray(j.accepts)) {
        j.accepts = j.accepts.filter((a) => optionMatches(a, allowed));
        body = JSON.stringify(j);
      }
    } catch {}
    headers.delete("content-length");
    return new Response(body, { status: 402, statusText: response.statusText, headers });
  };
}
