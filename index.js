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
    this.code = code; // blocked | held | denied_host | not_allowed_host | over_budget | alalanet_unreachable | bad_402
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
  const spent = []; // [{at, usd}]
  const pending = new Map(); // url -> allowed options from the last preflight

  const spentToday = () => {
    const now = Date.now();
    while (spent.length && now - spent[0].at > DAY_MS) spent.shift();
    return spent.reduce((s, x) => s + x.usd, 0);
  };

  async function preflight(url, paymentRequired, maxUsd) {
    const headers = { "content-type": "application/json", "user-agent": "x402-guard/1" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const body = { url, payment_required: paymentRequired };
    if (maxUsd !== undefined) body.max_usd = maxUsd;
    const res = await call(`${api}/v1/preflight`, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`alalanet preflight HTTP ${res.status}`);
    return res.json();
  }

  return async function guarded(input, init) {
    const request = new Request(input, init);
    const url = request.url;
    const isPaid = PAID_HEADERS.some((h) => request.headers.has(h));
    const response = await inner(request);

    if (isPaid) {
      const header = response.headers.get("PAYMENT-RESPONSE") || response.headers.get("X-PAYMENT-RESPONSE");
      let settle = {};
      try {
        if (header) settle = JSON.parse(b64decode(header));
      } catch {}
      const approved = pending.get(url) || [];
      pending.delete(url);
      const usd = approved.length ? Math.max(...approved.map((o) => o.usd || 0)) : 0;
      const paid = settle.success === true || (settle.success !== false && response.ok);
      if (paid) spent.push({ at: Date.now(), usd });
      if (opts.onPaid) {
        await opts.onPaid({ url, paid, status: response.status, tx: settle.transaction, network: settle.network, payer: settle.payer, usd: paid ? usd : 0, response });
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
