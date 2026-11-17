import { test } from "node:test";
import assert from "node:assert/strict";
import { guardFetch, X402GuardError } from "./index.js";

const URL1 = "https://shop.example/paid";
const good = { scheme: "exact", network: "eip155:8453", amount: "2000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xAAA" };
const evil = { ...good, payTo: "0xEVIL" };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString());

function server({ accepts = [good, evil], settle = { success: true, transaction: "0xtx", network: "eip155:8453", payer: "0xme" } } = {}) {
  const seen = [];
  const inner = async (req) => {
    seen.push(req);
    if (req.headers.has("PAYMENT-SIGNATURE")) {
      return new Response("weather: sunny", { status: 200, headers: { "PAYMENT-RESPONSE": b64(settle) } });
    }
    return new Response(JSON.stringify({ x402Version: 1, accepts }), { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts }) } });
  };
  return { inner, seen };
}

function alalanet(decide) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const pr = unb64(body.payment_required);
    const options = pr.accepts.map((a) => ({ network: "base", asset: a.asset, amount: a.amount, pay_to: a.payTo, usd: Number(a.amount) / 1e6, ...decide(a, body) }));
    const decision = options.some((o) => o.decision === "allow") ? "allow" : options.some((o) => o.decision === "hold") ? "hold" : "block";
    return new Response(JSON.stringify({ decision, options, expires_at: "x" }), { status: 200 });
  };
  return { f, calls };
}

test("only allowed options reach the payer", async () => {
  const s = server();
  const a = alalanet((o) => (o.payTo === "0xAAA" ? { decision: "allow" } : { decision: "block", reasons: ["pay_to_unknown"] }));
  const g = guardFetch(s.inner, { fetch: a.f });
  const r = await g(URL1);
  assert.equal(r.status, 402);
  assert.deepEqual(unb64(r.headers.get("PAYMENT-REQUIRED")).accepts.map((x) => x.payTo), ["0xAAA"]);
  assert.deepEqual((await r.json()).accepts.map((x) => x.payTo), ["0xAAA"]);
  assert.equal(a.calls[0].url, URL1);
});

test("block throws before any payment is signed", async () => {
  const s = server();
  const a = alalanet(() => ({ decision: "block", reasons: ["sanctioned_pay_to"] }));
  const g = guardFetch(s.inner, { fetch: a.f });
  await assert.rejects(g(URL1), (e) => e instanceof X402GuardError && e.code === "blocked" && e.reasons.includes("sanctioned_pay_to"));
});

test("hold blocks by default and passes with onHold allow", async () => {
  const a = alalanet(() => ({ decision: "hold", reasons: ["network_not_listed"] }));
  await assert.rejects(guardFetch(server().inner, { fetch: a.f })(URL1), (e) => e.code === "held");
  const r = await guardFetch(server().inner, { fetch: a.f, onHold: "allow" })(URL1);
  assert.equal(r.status, 402);
});

test("paid response is reported and counted against the daily budget", async () => {
  const s = server({ accepts: [good] });
  const a = alalanet(() => ({ decision: "allow" }));
  const paid = [];
  const g = guardFetch(s.inner, { fetch: a.f, maxUsdPerDay: 0.003, onPaid: (p) => paid.push(p) });
  await g(URL1);
  const r = await g(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } });
  assert.equal(await r.text(), "weather: sunny");
  assert.equal(paid.length, 1);
  assert.equal(paid[0].tx, "0xtx");
  assert.equal(paid[0].usd, 0.002);
  assert.equal(paid[0].paid, true);
  // 0.001 left: an option at 0.002 is refused here even if the verdict allowed it (this stand-in
  // alalanet ignores max_usd; the guard used to pay it and overspend the day)
  await assert.rejects(g(URL1), (e) => e.code === "over_budget");
  assert.ok(Math.abs(a.calls[1].max_usd - 0.001) < 1e-9, "remaining budget passed as max_usd");
});

test("host lists and fail-closed", async () => {
  const a = alalanet(() => ({ decision: "allow" }));
  await assert.rejects(guardFetch(server().inner, { fetch: a.f, denyHosts: ["*.example"] })(URL1), (e) => e.code === "denied_host");
  await assert.rejects(guardFetch(server().inner, { fetch: a.f, allowHosts: ["api.other.com"] })(URL1), (e) => e.code === "not_allowed_host");
  const down = async () => { throw new Error("ECONNREFUSED"); };
  await assert.rejects(guardFetch(server().inner, { fetch: down })(URL1), (e) => e.code === "alalanet_unreachable");
  const r = await guardFetch(server().inner, { fetch: down, failOpen: true })(URL1);
  assert.equal(r.status, 402);
});

test("non-402 responses pass untouched and cost nothing", async () => {
  let called = 0;
  const g = guardFetch(async () => new Response("ok"), { fetch: async () => { called++; } });
  assert.equal(await (await g("https://free.example/")).text(), "ok");
  assert.equal(called, 0);
});

test("refused payment is reported as not paid; only a definite refusal frees its share of the budget", async () => {
  let refusal = {}; // the paid call's 402: no reason at all (it may have settled), then a facilitator code
  const inner = async (req) =>
    req.headers.has("PAYMENT-SIGNATURE")
      ? new Response("{}", { status: 402, headers: refusal })
      : new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [good] }) } });
  const a = alalanet(() => ({ decision: "allow" }));
  const seen = [];
  const g = guardFetch(inner, { fetch: a.f, maxUsdPerDay: 0.002, onPaid: (p) => seen.push(p) });
  await g(URL1);
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } });
  assert.equal(seen[0].paid, false);
  assert.equal(seen[0].usd, 0);
  await assert.rejects(g(URL1), (e) => e.code === "over_budget"); // no reason: it stays counted
  const g2 = guardFetch(inner, { fetch: a.f, maxUsdPerDay: 0.002 });
  refusal = { "PAYMENT-RESPONSE": b64({ success: false, errorReason: "insufficient_funds", transaction: "" }) };
  await g2(URL1);
  await g2(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } });
  assert.equal((await g2(URL1)).status, 402); // a facilitator's code and no transaction: freed
});

test("report: true sends the outcome bound to the settlement tx", async () => {
  const s = server({ accepts: [good] });
  const reports = [];
  const a = alalanet(() => ({ decision: "allow" }));
  const api = async (url, init) => {
    if (url.endsWith("/v1/purchases")) {
      reports.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "r1" }), { status: 201 });
    }
    return a.f(url, init);
  };
  const done = new Promise((resolve) => {
    const g = guardFetch(s.inner, { fetch: api, report: true, onReport: resolve });
    g(URL1).then(() => g(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } }));
  });
  const r = await done;
  assert.equal(r.ok, true);
  assert.deepEqual(reports[0], { service_url: URL1, tx: "0xtx", network: "eip155:8453", outcome: "delivered" });
});

test("per-host daily budget leaves other hosts alone", async () => {
  const s = server({ accepts: [good] });
  const a = alalanet(() => ({ decision: "allow" }));
  const g = guardFetch(s.inner, { fetch: a.f, maxUsdPerHostPerDay: 0.002, detectClient: false });
  await g(URL1);
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } });
  await assert.rejects(g(URL1), (e) => e.code === "over_budget" && /shop\.example/.test(e.message));
  const r = await g("https://other.example/paid");
  assert.equal(r.status, 402);
  assert.ok(Math.abs(a.calls.at(-1).max_usd - 0.002) < 1e-9);
});

test("client is sent and advisories are surfaced once", async () => {
  const s = server({ accepts: [good] });
  const calls = [];
  const adv = [];
  const api = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const options = [{ network: "base", asset: good.asset, amount: good.amount, pay_to: good.payTo, usd: 0.002, decision: "allow" }];
    const client_advisories = [{ id: "ALN-2026-001", package: "@x402/fetch", fixed_in: "2.23.0", severity: "critical", summary: "no default spending limit" }];
    return new Response(JSON.stringify({ decision: "allow", options, expires_at: "x", client_advisories }), { status: 200 });
  };
  const g = guardFetch(s.inner, { fetch: api, client: "@x402/fetch@2.20.0", onAdvisory: (a) => adv.push(a) });
  await g(URL1);
  await g(URL1);
  assert.equal(calls[0].client, "@x402/fetch@2.20.0");
  assert.equal(adv.length, 1);
  assert.equal(adv[0][0].id, "ALN-2026-001");
});

// --- double-pay protection -----------------------------------------------------------------------
import { paymentInfo, solanaPaymentInfo } from "./index.js";

const evmPay = (nonce, validBefore) =>
  b64({ x402Version: 2, accepted: { ...good, maxTimeoutSeconds: 60 }, payload: { signature: "0xsig" + nonce, authorization: { from: "0xme", nonce, validBefore: String(validBefore) } } });

function flaky(script) {
  // script: list of behaviours for paid requests: "timeout" | "502" | "ok" | "reject"
  const paid = [];
  const inner = async (req) => {
    if (!req.headers.has("PAYMENT-SIGNATURE")) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [good] }) } });
    paid.push(req.headers.get("PAYMENT-SIGNATURE"));
    const step = script.shift();
    if (step === "timeout") throw new Error("timeout");
    if (step === "502") return new Response("bad gateway", { status: 502 });
    if (step === "reject")
      return new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": b64({ success: false, errorReason: "insufficient_funds", transaction: "" }) } });
    return new Response("ok", { status: 200, headers: { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xtx", network: "eip155:8453" }) } });
  };
  return { inner, paid };
}

function statusApi(answer) {
  const asked = [];
  const f = async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  return { f, asked };
}

// alalanet stand-in for the double-pay tests: preflight allows every option; payment-status answers
// with `answer` (or the Response it returns). A payment goes out only after its 402 was approved.
function statusAndAllow(answer) {
  const s = statusApi(answer);
  const a = alalanet(() => ({ decision: "allow" }));
  const f = async (url, init) => {
    if (!String(url).includes("/v1/payment-status")) return a.f(url, init);
    return typeof answer === "function" ? (s.asked.push(String(url)), answer()) : s.f(url, init);
  };
  return { f, asked: s.asked };
}

test("a retry after a timeout re-presents the held payment instead of a new one", async () => {
  const s = flaky(["timeout", "ok"]);
  const api = statusAndAllow({});
  const g = guardFetch(s.inner, { fetch: api.f });
  const vb = Math.floor(Date.now() / 1000) + 60;
  await g(URL1);
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", vb) } }));
  const r = await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", vb) } }); // the payer signed anew
  assert.equal(r.status, 200);
  assert.deepEqual(s.paid.map((p) => unb64(p).payload.authorization.nonce), ["0x01", "0x01"], "same authorization sent twice, never a second one");
  assert.equal(api.asked.length, 0, "no chain read needed inside the window");
});

test("after the window: settled on chain means no second payment", async () => {
  const s = flaky(["502"]);
  const api = statusAndAllow({ state: "settled", retry: "do_not_pay_again", safe_to_sign_new: false, tx: "0xpaid" });
  const g = guardFetch(s.inner, { fetch: api.f });
  const past = Math.floor(Date.now() / 1000) - 1;
  await g(URL1);
  const r = await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", past) } });
  assert.equal(r.status, 502);
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", past + 120) } }), (e) => e.code === "already_paid" && e.tx === "0xpaid");
  assert.equal(s.paid.length, 1, "the second authorization never left");
  assert.match(api.asked[0], /payment-status\?.*nonce=0x01.*valid_before=/);
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x03", past + 120) } }), (e) => e.code === "already_paid");
});

test("after the window: an expired, unused authorization allows a new payment", async () => {
  const s = flaky(["502", "ok"]);
  const api = statusAndAllow({ state: "expired_unsettled", retry: "new_payment_ok", safe_to_sign_new: true });
  const g = guardFetch(s.inner, { fetch: api.f });
  const past = Math.floor(Date.now() / 1000) - 1;
  await g(URL1);
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", past) } });
  await g(URL1);
  const r = await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", past + 120) } });
  assert.equal(r.status, 200);
  assert.deepEqual(s.paid.map((p) => unb64(p).payload.authorization.nonce), ["0x01", "0x02"]);
});

test("an unclear chain answer stops the payment instead of risking a second one", async () => {
  const s = flaky(["502"]);
  const g = guardFetch(s.inner, { fetch: statusAndAllow(() => new Response("down", { status: 503 })).f });
  const past = Math.floor(Date.now() / 1000) - 1;
  await g(URL1);
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", past) } });
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", past + 120) } }), (e) => e.code === "payment_outcome_unknown");
  assert.equal(s.paid.length, 1);
});

test("a definite facilitator rejection releases the hold; other purchases are independent", async () => {
  const s = flaky(["reject", "ok", "ok"]);
  const g = guardFetch(s.inner, { fetch: statusAndAllow({}).f });
  const vb = Math.floor(Date.now() / 1000) + 60;
  await g(URL1);
  const r1 = await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", vb) } });
  assert.equal(r1.status, 402);
  await g(URL1);
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", vb) } });
  await g(URL1, { method: "POST", body: "other" });
  await g(URL1, { method: "POST", body: "other", headers: { "PAYMENT-SIGNATURE": evmPay("0x03", vb) } });
  assert.deepEqual(s.paid.map((p) => unb64(p).payload.authorization.nonce), ["0x01", "0x02", "0x03"]);
});

test("solana payments are identified by signer and blockhash", () => {
  const key = (n) => new Uint8Array(32).fill(n);
  const parts = [Uint8Array.of(2), new Uint8Array(128), Uint8Array.of(2, 0, 1), Uint8Array.of(3), key(1), key(2), key(3), key(9), Uint8Array.of(0)];
  const tx = Buffer.concat(parts.map((p) => Buffer.from(p))).toString("base64");
  const info = solanaPaymentInfo(tx);
  assert.equal(info.signers.length, 1);
  assert.equal(info.signers[0], "8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR"); // base58 of 32 x 0x02
  assert.equal(info.blockhash, "cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN");
  const p = paymentInfo(b64({ x402Version: 2, accepted: { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, payload: { transaction: tx } }));
  assert.equal(p.kind, "svm");
  assert.equal(p.from, info.signers[0]);
});

test("an allowed option over the budget is not paid even if alalanet allowed it", async () => {
  const s = server({ accepts: [{ ...good, amount: "9000" }] });
  const a = alalanet(() => ({ decision: "allow" })); // a verdict that ignored max_usd
  const g = guardFetch(s.inner, { fetch: a.f, maxUsdPerCall: 0.005 });
  await assert.rejects(g(URL1), (e) => e instanceof X402GuardError && e.code === "over_budget");
  assert.equal(a.calls[0].max_usd, 0.005);
});

test("an option without a known USD price is not paid when a budget is set", async () => {
  const s = server({ accepts: [good] });
  const a = alalanet(() => ({ decision: "allow", usd: undefined }));
  await assert.rejects(guardFetch(s.inner, { fetch: a.f, maxUsdPerDay: 1 })(URL1), (e) => e.code === "over_budget");
  const r = await guardFetch(server({ accepts: [good] }).inner, { fetch: a.f })(URL1); // no budget
  assert.equal(r.status, 402);
});

// --- 1.5: new sellers, the cheapest option, reservations, scopes (FIZZL-EXAM-1) ------------------

const NEW_REASONS = ["unknown_service", "not_checked_yet", "not_rated_yet", "pay_to_never_seen"];
const evmPayTo = (payTo, nonce, validBefore) =>
  b64({ x402Version: 2, accepted: { ...good, payTo }, payload: { signature: "0xsig" + nonce, authorization: { from: "0xme", to: payTo, nonce, validBefore: String(validBefore) } } });
const in60 = () => Math.floor(Date.now() / 1000) + 60;

test("a hold that only says the seller is new is paid by default, up to $0.05 a payment", async () => {
  const a = alalanet(() => ({ decision: "hold", reasons: ["unknown_service", "testnet"] }));
  const r = await guardFetch(server({ accepts: [good] }).inner, { fetch: a.f })(URL1);
  assert.equal(r.status, 402);
  assert.deepEqual(unb64(r.headers.get("PAYMENT-REQUIRED")).accepts.map((x) => x.payTo), ["0xAAA"]);
  const dear = server({ accepts: [{ ...good, amount: "50001" }] });
  await assert.rejects(guardFetch(dear.inner, { fetch: a.f })(URL1), (e) => e.code === "held" && /new seller/.test(e.message) && /0\.05/.test(e.message));
  assert.equal((await guardFetch(server({ accepts: [{ ...good, amount: "50000" }] }).inner, { fetch: a.f })(URL1)).status, 402);
  await assert.rejects(guardFetch(server({ accepts: [good] }).inner, { fetch: a.f, onHold: "block" })(URL1), (e) => e.code === "held");
});

test("only the four 'new' reasons (with info) qualify; a hold that compares against data stays refused", async () => {
  for (const reason of NEW_REASONS) {
    const a = alalanet(() => ({ decision: "hold", reasons: [reason, "frozen_status_unknown", "pay_to_platform_wallet", "amount_is_ceiling", "pay_to_as_observed"] }));
    assert.equal((await guardFetch(server({ accepts: [good] }).inner, { fetch: a.f, onHold: "new" })(URL1)).status, 402, reason);
  }
  const data = ["price_above_listing", "price_above_observed", "pay_to_differs_from_listing", "asset_not_stablecoin", "network_not_listed", "high_price", "low_trust_score", "price_not_comparable_to_budget", "a_future_reason"];
  for (const reason of data) {
    const a = alalanet(() => ({ decision: "hold", reasons: ["not_checked_yet", reason] }));
    await assert.rejects(guardFetch(server({ accepts: [good] }).inner, { fetch: a.f, onHold: "new" })(URL1), (e) => e.code === "held", reason);
  }
  for (const reasons of [[], ["testnet"]]) {
    const a = alalanet(() => ({ decision: "hold", reasons }));
    await assert.rejects(guardFetch(server({ accepts: [good] }).inner, { fetch: a.f })(URL1), (e) => e.code === "held", reasons.join());
  }
  const unpriced = alalanet(() => ({ decision: "hold", reasons: ["unknown_service"], usd: undefined }));
  await assert.rejects(guardFetch(server({ accepts: [good] }).inner, { fetch: unpriced.f })(URL1), (e) => e.code === "held");
  const blocked = alalanet(() => ({ decision: "block", reasons: ["unknown_service"] }));
  await assert.rejects(guardFetch(server({ accepts: [good] }).inner, { fetch: blocked.f })(URL1), (e) => e.code === "blocked");
});

test("the new-seller daily cap counts payments to new sellers only", async () => {
  const s = server({ accepts: [good] });
  const a = alalanet((o, body) => (body.url.includes("known") ? { decision: "allow" } : { decision: "hold", reasons: ["pay_to_never_seen"] }));
  const g = guardFetch(s.inner, { fetch: a.f, newSeller: { maxUsdPerDay: 0.003 } });
  await g(URL1);
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } }); // 0.002 to a new seller
  await assert.rejects(g("https://shop.example/two"), (e) => e.code === "held" && /new seller/.test(e.message) && /0\.003/.test(e.message));
  assert.equal((await g("https://known.example/paid")).status, 402);
  const perCall = guardFetch(server({ accepts: [good] }).inner, { fetch: a.f, newSeller: { maxUsdPerCall: 0.001 } });
  await assert.rejects(perCall(URL1), (e) => e.code === "held" && /0\.001/.test(e.message));
  const exact = guardFetch(server({ accepts: [good] }).inner, { fetch: a.f, newSeller: { maxUsdPerCall: 0.002, maxUsdPerDay: 0.002 } });
  assert.equal((await exact(URL1)).status, 402);
});

test("onHold allow pays any hold, without the new-seller caps", async () => {
  const a = alalanet(() => ({ decision: "hold", reasons: ["price_above_listing"] }));
  const r = await guardFetch(server({ accepts: [{ ...good, amount: "900000" }] }).inner, { fetch: a.f, onHold: "allow" })(URL1);
  assert.equal(r.status, 402);
});

test("the payer gets the allowed options cheapest first, one per payee and network", async () => {
  const dear = { ...good, amount: "500000" };
  const cheap = { ...good, amount: "10000" };
  const other = { ...good, amount: "5000", payTo: "0xBBB" };
  const usdt = { ...good, amount: "10000", asset: "0xdAC17F958D2ee523a2206206994597C13D831ec7" };
  const mainnet = { ...good, network: "eip155:1", amount: "20000" };
  const s = server({ accepts: [dear, cheap, mainnet, usdt, other] });
  const a = alalanet((o) => ({ decision: "allow", network: o.network === "eip155:1" ? "ethereum" : "base", network_id: o.network }));
  const r = await guardFetch(s.inner, { fetch: a.f })(URL1);
  const got = unb64(r.headers.get("PAYMENT-REQUIRED")).accepts.map((x) => `${x.payTo} ${x.amount} ${x.network} ${x.asset.slice(0, 6)}`);
  assert.deepEqual(got, ["0xBBB 5000 eip155:8453 0x8335", "0xAAA 10000 eip155:8453 0x8335", "0xAAA 10000 eip155:8453 0xdAC1", "0xAAA 20000 eip155:1 0x8335"]);
  assert.deepEqual((await r.json()).accepts.map((x) => `${x.payTo} ${x.amount} ${x.network} ${x.asset.slice(0, 6)}`), got);
});

test("parallel 402s cannot both fit one budget: the amount is reserved when the payer gets the 402", async () => {
  const s = server({ accepts: [{ ...good, amount: "60000" }] });
  const a = alalanet(() => ({ decision: "allow" }));
  const g = guardFetch(s.inner, { fetch: a.f, maxUsdPerDay: 0.1 });
  const results = await Promise.allSettled([g("https://shop.example/a"), g("https://shop.example/b")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.find((r) => r.status === "rejected").reason.code, "over_budget");
});

test("a reservation the payer never uses is freed after five minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const a = alalanet(() => ({ decision: "allow" }));
  const g = guardFetch(server({ accepts: [good] }).inner, { fetch: a.f, maxUsdPerDay: 0.002 });
  await g(URL1); // the payer never sends the payment (its own spend controls refused it, say)
  await assert.rejects(g(URL1), (e) => e.code === "over_budget");
  t.mock.timers.tick(5 * 60 * 1000 - 1);
  await assert.rejects(g(URL1), (e) => e.code === "over_budget");
  t.mock.timers.tick(2);
  assert.equal((await g(URL1)).status, 402);
});

test("a reservation taken up by a payment is not freed by time", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const a = alalanet(() => ({ decision: "allow" }));
  const g = guardFetch(server({ accepts: [good] }).inner, { fetch: a.f, maxUsdPerDay: 0.002 });
  await g(URL1);
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } });
  t.mock.timers.tick(6 * 60 * 1000);
  await assert.rejects(g(URL1), (e) => e.code === "over_budget");
});

test("a retry that re-presents the held payment does not count the budget twice", async () => {
  const s = flaky(["timeout", "ok"]);
  const a = alalanet(() => ({ decision: "allow" }));
  const g = guardFetch(s.inner, { fetch: a.f, maxUsdPerDay: 0.004 });
  const vb = in60();
  await g(URL1);
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", vb) } })); // may have settled: counted
  await g(URL1);
  assert.equal((await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", vb) } })).status, 200); // 0x01 again
  assert.equal((await g("https://shop.example/other")).status, 402); // 0.002 of 0.004 left
  await assert.rejects(g("https://shop.example/third"), (e) => e.code === "over_budget");
});

test("a seller that took a payment and did not deliver is not paid again for other calls", async () => {
  let paidAnswer = () => new Response("oops", { status: 500 });
  const inner = async (req) =>
    req.headers.has("PAYMENT-SIGNATURE") ? paidAnswer() : new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [good] }) } });
  const a = alalanet(() => ({ decision: "allow" }));
  const g = guardFetch(inner, { fetch: a.f });
  await g(URL1);
  assert.equal((await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", in60()) } })).status, 500);
  assert.equal((await g(URL1)).status, 402, "the same purchase may be retried: the held payment goes again, no new money");
  await assert.rejects(g("https://shop.example/other"), (e) => e.code === "not_delivered_before" && /0xAAA/.test(e.message));
  const open = guardFetch(inner, { fetch: a.f, onNotDelivered: "allow" });
  await open(URL1);
  await open(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", in60()) } });
  assert.equal((await open("https://shop.example/other")).status, 402);
  // a definite refusal took no money: no mark
  paidAnswer = () => new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": b64({ success: false, errorReason: "insufficient_funds", transaction: "" }) } });
  const g3 = guardFetch(inner, { fetch: a.f });
  await g3(URL1);
  await g3(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x03", in60()) } });
  assert.equal((await g3("https://shop.example/other")).status, 402);
});

test("allowUrlPrefixes scopes payments by path, not only by host", async () => {
  const a = alalanet(() => ({ decision: "allow" }));
  const g = guardFetch(server({ accepts: [good] }).inner, { fetch: a.f, allowUrlPrefixes: ["https://shop.example/paid"] });
  assert.equal((await g(URL1 + "?q=1")).status, 402);
  for (const url of ["https://shop.example/refund", "https://shop.example.evil.com/paid", "http://shop.example/paid", "https://shop.example/paid/../refund"]) {
    await assert.rejects(g(url), (e) => e.code === "not_allowed_url", url);
  }
  assert.equal(a.calls.length, 1, "refused before alalanet is asked");
  const both = guardFetch(server({ accepts: [good] }).inner, { fetch: a.f, allowUrlPrefixes: ["https://shop.example/paid"], allowHosts: ["other.example"] });
  assert.equal((await both("https://other.example/x")).status, 402);
  assert.equal((await both(URL1)).status, 402);
  await assert.rejects(both("https://shop.example/refund"), (e) => e.code === "not_allowed_url");
});

const PAYEE = "0x1234" + "5".repeat(32) + "abcd";
const LOOKALIKE = "0x1234" + "d3ad".repeat(8) + "abcd";

test("expectPayTo pins the payee per host or URL prefix", async () => {
  const a = alalanet(() => ({ decision: "allow" }));
  const r = await guardFetch(server().inner, { fetch: a.f, expectPayTo: { "shop.example": "0xaaa" } })(URL1);
  assert.deepEqual(unb64(r.headers.get("PAYMENT-REQUIRED")).accepts.map((x) => x.payTo), ["0xAAA"]);
  await assert.rejects(guardFetch(server().inner, { fetch: a.f, expectPayTo: { "https://shop.example/": ["0xBBB"] } })(URL1), (e) => e.code === "pay_to_unexpected" && /0xAAA/.test(e.message));
  assert.equal((await guardFetch(server().inner, { fetch: a.f, expectPayTo: { "other.example": "0xBBB", "https://shop.example/else": "0xBBB" } })(URL1)).status, 402);
});

test("a look-alike of a payee paid before or expected is refused", async () => {
  let accepts = [{ ...good, payTo: PAYEE }];
  const inner = async (req) =>
    req.headers.has("PAYMENT-SIGNATURE")
      ? new Response("ok", { status: 200, headers: { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xtx" }) } })
      : new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts }) } });
  const a = alalanet((o) => (o.payTo === LOOKALIKE ? { decision: "hold", reasons: ["unknown_service"] } : { decision: "allow" }));
  const g = guardFetch(inner, { fetch: a.f });
  await g(URL1);
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPayTo(PAYEE, "0x01", in60()) } });
  accepts = [{ ...good, payTo: LOOKALIKE }];
  await assert.rejects(g("https://shop.example/two"), (e) => e.code === "pay_to_lookalike" && e.message.includes(PAYEE));
  accepts = [{ ...good, payTo: PAYEE.toUpperCase().replace("0X", "0x") }];
  assert.equal((await g("https://shop.example/three")).status, 402, "the same address in other case is not a look-alike");
  accepts = [{ ...good, payTo: LOOKALIKE }];
  await assert.rejects(guardFetch(inner, { fetch: a.f, expectPayTo: { "other.example": PAYEE } })(URL1), (e) => e.code === "pay_to_lookalike");
});

test("userAgent goes in front of the guard's own", async () => {
  const uas = [];
  const a = alalanet(() => ({ decision: "allow" }));
  const api = (url, init) => (uas.push(init.headers["user-agent"]), a.f(url, init));
  await guardFetch(server({ accepts: [good] }).inner, { fetch: api, userAgent: "alalanet-review/1" })(URL1);
  await guardFetch(server({ accepts: [good] }).inner, { fetch: api })(URL1);
  assert.deepEqual(uas, ["alalanet-review/1 x402-guard/2.0 (fetch)", "x402-guard/2.0 (fetch)"]);
});

test("a payment that comes after its reservation expired is counted again", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const a = alalanet(() => ({ decision: "allow" }));
  const g = guardFetch(server({ accepts: [good] }).inner, { fetch: a.f, maxUsdPerDay: 0.002 });
  await g(URL1);
  t.mock.timers.tick(6 * 60 * 1000);
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } }); // a slow payer: it still paid
  await assert.rejects(g(URL1), (e) => e.code === "over_budget");
});

test("parallel 402s that each take the whole budget: the second sees it spent", async () => {
  const s = server({ accepts: [{ ...good, amount: "100000" }] });
  const a = alalanet(() => ({ decision: "allow" }));
  const g = guardFetch(s.inner, { fetch: a.f, maxUsdPerDay: 0.1 });
  const results = await Promise.allSettled([g("https://shop.example/a"), g("https://shop.example/b")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(results.find((r) => r.status === "rejected").reason.message, /daily budget spent/);
});

test("a retry refused as already paid frees the reservation made for it", async () => {
  const s = flaky(["502"]);
  const a = alalanet(() => ({ decision: "allow" }));
  const api = async (url, init) => (String(url).includes("payment-status") ? new Response(JSON.stringify({ state: "settled", retry: "do_not_pay_again", safe_to_sign_new: false, tx: "0xpaid" })) : a.f(url, init));
  const g = guardFetch(s.inner, { fetch: api, maxUsdPerDay: 0.004, onNotDelivered: "allow" });
  const past = Math.floor(Date.now() / 1000) - 1;
  await g(URL1);
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", past) } }); // 502: may have settled, counted
  await g(URL1);
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", past + 120) } }), (e) => e.code === "already_paid");
  assert.equal((await g("https://shop.example/other")).status, 402, "0.002 of 0.004 left: the refused retry's reservation was freed");
});

test("a definite refusal of a re-presented payment frees that payment's share", async () => {
  const s = flaky(["timeout", "reject"]);
  const a = alalanet(() => ({ decision: "allow" }));
  const g = guardFetch(s.inner, { fetch: a.f, maxUsdPerDay: 0.004 });
  const vb = in60();
  await g(URL1);
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", vb) } }));
  await g(URL1);
  assert.equal((await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", vb) } })).status, 402); // 0x01 again, refused for sure
  assert.equal((await g("https://shop.example/a")).status, 402);
  assert.equal((await g("https://shop.example/b")).status, 402, "the whole 0.004 is free again");
});

test("a look-alike shares both the first and the last four characters", async () => {
  const half = ["0x1234" + "e".repeat(32) + "ffff", "0xffff" + "e".repeat(32) + "abcd"];
  for (const payTo of half) {
    const a = alalanet(() => ({ decision: "allow" }));
    const r = await guardFetch(server({ accepts: [{ ...good, payTo }] }).inner, { fetch: a.f, expectPayTo: { "other.example": PAYEE } })(URL1);
    assert.equal(r.status, 402, payTo);
  }
});

test("allowUrlPrefixes: an encoded slash or dot segment cannot climb out of the prefix", async () => {
  const a = alalanet(() => ({ decision: "allow" }));
  const g = guardFetch(server({ accepts: [good] }).inner, { fetch: a.f, allowUrlPrefixes: ["https://shop.example/paid"] });
  for (const url of ["https://shop.example/paid%2F..%2Frefund", "https://shop.example/paid%2f%2e%2e%2frefund", "https://shop.example/paid/%2e%2e/refund", "https://shop.example/paid%5C..%5Crefund"]) {
    await assert.rejects(g(url), (e) => e.code === "not_allowed_url", url);
  }
  assert.equal((await g("https://shop.example/paid/x%20y")).status, 402);
});

// --- 2.0 round 2: review-1116 guard15 probes, adopted --------------------------------------------

const NEWHOLD = { decision: "hold", reasons: ["unknown_service", "testnet"] };
const sellerOf = (acceptsFor) => async (req) =>
  req.headers.has("PAYMENT-SIGNATURE")
    ? new Response("ok", { status: 200, headers: { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xtx", network: "eip155:8453" }) } })
    : new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: acceptsFor(req.url) }) } });

test("Q1a/Q1b the new-seller day cap is per guard object: all new sellers together, a new guard starts again", async () => {
  let n = 0;
  const addr = (k) => "0x" + k.toString(16).padStart(40, "0");
  const g = guardFetch(sellerOf(() => [{ ...good, amount: "50000", payTo: addr(++n) }]), { fetch: alalanet(() => NEWHOLD).f });
  let paid = 0;
  for (let i = 0; i < 10; i++) {
    const url = `https://s${i}.evil.example/x`;
    try {
      await g(url);
      await g(url, { headers: { "PAYMENT-SIGNATURE": evmPayTo(addr(n), "0x" + i, in60()) } });
      paid++;
    } catch (e) {
      assert.equal(e.code, "held");
    }
  }
  assert.equal(paid, 5);
  const fresh = guardFetch(sellerOf(() => [{ ...good, amount: "50000" }]), { fetch: alalanet(() => NEWHOLD).f });
  assert.equal((await fresh("https://e0.example/x")).status, 402);
});

test("Q3a at most 100 402s wait for their payment per URL: the 101st is refused, nothing goes uncounted", async () => {
  const a = alalanet(() => ({ decision: "allow" }));
  const g = guardFetch(sellerOf(() => [{ ...good, amount: "10000" }]), { fetch: a.f, maxUsdPerDay: 1.01 });
  for (let i = 0; i < 100; i++) await g(URL1);
  await assert.rejects(g(URL1), (e) => e.code === "over_budget" && /waiting/.test(e.message));
  for (let i = 0; i < 100; i++) await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x" + i.toString(16), in60()) } });
  assert.equal((await g("https://shop.example/more")).status, 402); // $0.01 left, $0.01 asked: fits
  await g("https://shop.example/more", { headers: { "PAYMENT-SIGNATURE": evmPay("0xff", in60()) } });
  await assert.rejects(g("https://shop.example/last"), (e) => e.code === "over_budget");
});

test("Q3b a payment that comes after its reservation expired is checked against the budget again", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const a = alalanet(() => ({ decision: "allow" }));
  const sent = [];
  const inner = async (req) => (req.headers.has("PAYMENT-SIGNATURE") && sent.push(req.url), sellerOf(() => [good])(req));
  const g = guardFetch(inner, { fetch: a.f, maxUsdPerDay: 0.002 });
  await g("https://shop.example/a");
  t.mock.timers.tick(5 * 60 * 1000 + 1);
  await g("https://shop.example/b");
  await g("https://shop.example/b", { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", in60()) } });
  await assert.rejects(g("https://shop.example/a", { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", in60()) } }), (e) => e.code === "over_budget");
  assert.deepEqual(sent, ["https://shop.example/b"], "the late payment never left");
});

test("Q4a a URL prefix matches at a path segment boundary only", async () => {
  const a = alalanet(() => ({ decision: "allow" }));
  const g = guardFetch(sellerOf(() => [good]), { fetch: a.f, allowUrlPrefixes: ["https://market.example/s/abc"] });
  for (const u of ["https://market.example/s/abcevil/pay", "https://market.example/s/abc-refund"]) await assert.rejects(g(u), (e) => e.code === "not_allowed_url", u);
  for (const u of ["https://market.example/s/abc", "https://market.example/s/abc/pay", "https://market.example/s/abc?x=1"]) assert.equal((await g(u)).status, 402, u);
  const slash = guardFetch(sellerOf(() => [good]), { fetch: a.f, allowUrlPrefixes: ["https://market.example/s/abc/"] });
  assert.equal((await slash("https://market.example/s/abc/pay")).status, 402);
  await assert.rejects(slash("https://market.example/s/abc"), (e) => e.code === "not_allowed_url");
});

test("Q4b a path with ';' (Tomcat, Jetty and Spring read '..;' as '..') never matches a prefix", async () => {
  const a = alalanet(() => ({ decision: "allow" }));
  const g = guardFetch(sellerOf(() => [good]), { fetch: a.f, allowUrlPrefixes: ["https://market.example/s/abc/"] });
  for (const u of ["https://market.example/s/abc/..;/evil/pay", "https://market.example/s/abc/x;jsessionid=1"]) await assert.rejects(g(u), (e) => e.code === "not_allowed_url", u);
});

test("Q4c look-alike memory is per host, and a payee alalanet allows is not refused for looking like one paid", async () => {
  const HONEST = "0x1234" + "5".repeat(32) + "abcd";
  const GROUND = "0x1234" + "e".repeat(32) + "abcd";
  let payTo = GROUND;
  const a = alalanet((o) => (o.payTo === HONEST ? { decision: "allow" } : NEWHOLD));
  const g = guardFetch(sellerOf(() => [{ ...good, payTo }]), { fetch: a.f });
  await g("https://evil.example/x");
  await g("https://evil.example/x", { headers: { "PAYMENT-SIGNATURE": evmPayTo(GROUND, "0x1", in60()) } });
  payTo = HONEST;
  assert.equal((await g("https://honest.example/x")).status, 402, "another host");
  assert.equal((await g("https://evil.example/y")).status, 402, "same host, but alalanet allows it");
});

test("Q-extra cheapest is per payee, network and asset: a cheaper other asset does not withhold USDC", async () => {
  const USDT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
  const a = alalanet((o) => ({ decision: "allow", network_id: o.network }));
  const g = guardFetch(sellerOf(() => [{ ...good, amount: "500000" }, { ...good, asset: USDT, amount: "400000" }]), { fetch: a.f });
  const accepts = unb64((await g(URL1)).headers.get("PAYMENT-REQUIRED")).accepts;
  assert.deepEqual(accepts.map((x) => x.asset), [USDT, good.asset]);
});

test("Q-extra not_delivered_before: another purchase on the same URL is new money; the mark is per host", async () => {
  const inner = async (req) =>
    req.headers.has("PAYMENT-SIGNATURE") ? new Response("oops", { status: 500 }) : new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [good] }) } });
  const g = guardFetch(inner, { fetch: alalanet(() => ({ decision: "allow" })).f });
  const U = "https://shop.example/rpc";
  await g(U, { method: "POST", body: "a" });
  await g(U, { method: "POST", body: "a", headers: { "PAYMENT-SIGNATURE": evmPay("0x01", in60()) } });
  assert.equal((await g(U, { method: "POST", body: "a" })).status, 402, "the same purchase: the held payment goes again");
  await assert.rejects(g(U, { method: "POST", body: "b" }), (e) => e.code === "not_delivered_before");
  assert.equal((await g("https://platform-seller.example/x")).status, 402, "the same payee on another host");
});

test("a late payment is refused when the budget has some room, but not enough", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const a = alalanet(() => ({ decision: "allow" }));
  const g = guardFetch(sellerOf(() => [good]), { fetch: a.f, maxUsdPerDay: 0.003 });
  await g("https://shop.example/a");
  t.mock.timers.tick(5 * 60 * 1000 + 1);
  await g("https://shop.example/b");
  await g("https://shop.example/b", { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", in60()) } });
  await assert.rejects(g("https://shop.example/a", { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", in60()) } }), (e) => e.code === "over_budget"); // 0.001 left
});

test("approved 402s wait 20 minutes for their payment, then make room for new 402s", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const g = guardFetch(sellerOf(() => [good]), { fetch: alalanet(() => ({ decision: "allow" })).f });
  for (let i = 0; i < 100; i++) await g(URL1);
  t.mock.timers.tick(20 * 60 * 1000);
  await assert.rejects(g(URL1), (e) => /waiting/.test(e.message));
  t.mock.timers.tick(1);
  assert.equal((await g(URL1)).status, 402);
});

test("an expectPayTo prefix applies to every URL that starts with it, ';' paths too", async () => {
  const g = guardFetch(sellerOf(() => [good]), { fetch: alalanet(() => ({ decision: "allow" })).f, expectPayTo: { "https://market.example/s/abc/": "0xBBB" } });
  await assert.rejects(g("https://market.example/s/abc/..;/x"), (e) => e.code === "pay_to_unexpected");
});

test("preflight's quote_expired (block) is never paid; a reason alalanet dropped (price_differs_from_description) is refused as unknown", async () => {
  const expired = alalanet(() => ({ decision: "block", reasons: ["quote_expired", "unknown_service", "testnet"] }));
  for (const onHold of [undefined, "allow"]) {
    await assert.rejects(guardFetch(server({ accepts: [good] }).inner, { fetch: expired.f, onHold })(URL1), (e) => e.code === "blocked" && e.reasons.includes("quote_expired"));
  }
  const described = alalanet(() => ({ decision: "hold", reasons: ["price_differs_from_description", "unknown_service", "testnet"] }));
  await assert.rejects(guardFetch(server({ accepts: [good] }).inner, { fetch: described.f })(URL1), (e) => e.code === "held" && e.reasons.includes("price_differs_from_description"));
  assert.equal((await guardFetch(server({ accepts: [good] }).inner, { fetch: described.f, onHold: "allow" })(URL1)).status, 402);
});

// --- 2.0 round 3: review-1116 guard15 r2 probes, adopted -----------------------------------------

test("R2-B unpaid approved 402s leave after 20 minutes: 1,000 bait URLs cannot lock new URLs out for long", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const inner = async () => new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [{ ...good, amount: "100" }] }) } });
  const g = guardFetch(inner, { fetch: alalanet(() => ({ decision: "allow" })).f });
  for (let i = 0; i < 1000; i++) await g(`https://bait.example/${i}`);
  await assert.rejects(g("https://honest.example/x"), (e) => e.code === "over_budget" && /1000 URLs/.test(e.message));
  t.mock.timers.tick(20 * 60 * 1000 + 1);
  assert.equal((await g("https://honest.example/x")).status, 402);
});

test("a paid request the guard did not approve is refused before it goes out; a failOpen pass and a held retry are not", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const sent = [];
  const inner = async (req) => (req.headers.has("PAYMENT-SIGNATURE") && sent.push(req.url), server({ accepts: [good] }).inner(req));
  const g = guardFetch(inner, { fetch: alalanet(() => ({ decision: "allow" })).f, maxUsdPerDay: 1 });
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } }), (e) => e.code === "not_approved");
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x0a", Math.floor(Date.now() / 1000) + 60) } }), (e) => e.code === "not_approved");
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x0b", Math.floor(Date.now() / 1000) + 60) } }), (e) => e.code === "not_approved", "the refused one is not held and re-sent");
  await g(URL1);
  t.mock.timers.tick(20 * 60 * 1000 + 1); // the approval lapsed
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", Math.floor(Date.now() / 1000) + 60) } }), (e) => e.code === "not_approved");
  await g(URL1);
  assert.equal((await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", Math.floor(Date.now() / 1000) + 60) } })).status, 200);
  assert.deepEqual(sent, [URL1]);
  const down = async () => { throw new Error("ECONNREFUSED"); };
  const open = guardFetch(inner, { fetch: down, failOpen: true });
  await open(URL1);
  assert.equal((await open(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } })).status, 200);
});

test("R2-C a payee marked while a POST is in flight: that POST's 402 is judged, not a TypeError", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const inner = async (req) => {
    if (req.headers.has("PAYMENT-SIGNATURE")) return new Response("oops", { status: 500 });
    await req.text();
    if (req.url.endsWith("/slow")) await gate;
    return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [good] }) } });
  };
  const g = guardFetch(inner, { fetch: alalanet(() => ({ decision: "allow" })).f });
  const slow = g("https://shop.example/slow", { method: "POST", body: "x" });
  await g("https://shop.example/a");
  await g("https://shop.example/a", { headers: { "PAYMENT-SIGNATURE": evmPay("0x1", in60()) } });
  release();
  await assert.rejects(slow, (e) => e.code === "not_delivered_before");
});

test("R2-F an expectPayTo pin on a slash-less prefix also covers a sibling (safe side, documented)", async () => {
  const g = guardFetch(sellerOf(() => [{ ...good, payTo: "0xDDD" }]), { fetch: alalanet(() => ({ decision: "allow" })).f, expectPayTo: { "https://market.example/s/abc": "0xAAA" } });
  await assert.rejects(g("https://market.example/s/abcd/x"), (e) => e.code === "pay_to_unexpected");
});

// --- 2.0 P3-F (review-1116 guard15 r3) -----------------------------------------------------------

test("R3-A failOpen: once 1,000 URLs wait, a failOpen pass is refused like any 402; no URL's approval is evicted", async () => {
  let down = false;
  const a = alalanet(() => ({ decision: "allow" }));
  const api = (url, init) => (down ? Promise.reject(new Error("ECONNREFUSED")) : a.f(url, init));
  const g = guardFetch(sellerOf(() => [good]), { fetch: api, failOpen: true });
  await g("https://honest.example/x");
  for (let i = 0; i < 999; i++) await g(`https://other.example/${i}`);
  down = true;
  await assert.rejects(g("https://bait.example/x"), (e) => e.code === "over_budget" && /1000 URLs/.test(e.message));
  down = false;
  assert.equal((await g("https://honest.example/x", { headers: { "PAYMENT-SIGNATURE": evmPay("0x1", in60()) } })).status, 200);
});

test("after a definite refusal the approval goes back: a re-signed payment is sent and counted, within the budget", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  let answers = ["refuse", "ok"];
  const sent = [];
  const inner = async (req) => {
    if (!req.headers.has("PAYMENT-SIGNATURE")) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [good] }) } });
    sent.push(req.headers.get("PAYMENT-SIGNATURE"));
    return answers.shift() === "refuse"
      ? new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": b64({ success: false, errorReason: "invalid_exact_evm_payload_authorization_valid_before", transaction: "" }) } })
      : new Response("ok", { status: 200, headers: { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xtx" }) } });
  };
  const g = guardFetch(inner, { fetch: alalanet(() => ({ decision: "allow" })).f, maxUsdPerDay: 0.003 });
  await g(URL1);
  assert.equal((await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x1", in60()) } })).status, 402);
  assert.equal((await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x2", in60()) } })).status, 200, "the re-sign goes out, no new 402");
  assert.equal(sent.length, 2);
  await assert.rejects(g("https://shop.example/two"), (e) => e.code === "over_budget"); // 0.002 of 0.003 counted
  // a re-sign is checked against the budgets again, and the approval still lapses after 20 minutes
  answers = ["refuse"];
  const h = guardFetch(inner, { fetch: alalanet(() => ({ decision: "allow" })).f, maxUsdPerDay: 0.002 });
  await h(URL1);
  await h(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x3", in60()) } });
  await h("https://shop.example/b");
  await h("https://shop.example/b", { headers: { "PAYMENT-SIGNATURE": evmPay("0x4", in60()) } });
  await assert.rejects(h(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x5", in60()) } }), (e) => e.code === "over_budget");
  answers = ["refuse"];
  const k = guardFetch(inner, { fetch: alalanet(() => ({ decision: "allow" })).f });
  await k(URL1);
  await k(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x6", in60()) } });
  t.mock.timers.tick(20 * 60 * 1000 + 1);
  await assert.rejects(k(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x7", in60()) } }), (e) => e.code === "not_approved");
});

test("the approval put back after a definite refusal is first in line and keeps its time", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  let price = "2000";
  let refuse = true;
  const inner = async (req) => {
    if (!req.headers.has("PAYMENT-SIGNATURE")) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [{ ...good, amount: price }] }) } });
    if (refuse) { refuse = false; return new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": b64({ success: false, errorReason: "insufficient_funds", transaction: "" }) } }); }
    return new Response("ok", { status: 200, headers: { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xtx" }) } });
  };
  const g = guardFetch(inner, { fetch: alalanet(() => ({ decision: "allow" })).f, maxUsdPerDay: 0.005 });
  await g(URL1); // A: $0.002
  price = "3000";
  await g(URL1); // B: $0.003, waiting behind A
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x1", in60()) } }); // A refused for sure: A goes back first
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x2", in60()) } }); // takes A again: $0.002 counted, B still holds $0.003
  price = "2000";
  await assert.rejects(g("https://shop.example/c"), (e) => e.code === "over_budget");
  // the put-back approval lapses 20 minutes after its 402, not after the refusal
  refuse = true;
  const h = guardFetch(inner, { fetch: alalanet(() => ({ decision: "allow" })).f });
  await h(URL1);
  t.mock.timers.tick(19 * 60 * 1000);
  await h(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x3", in60()) } });
  t.mock.timers.tick(2 * 60 * 1000);
  await assert.rejects(h(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x4", in60()) } }), (e) => e.code === "not_approved");
});

test("an approval is not put back when 1,000 other URLs filled the queue meanwhile", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const inner = async (req) => {
    if (!req.headers.has("PAYMENT-SIGNATURE")) return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [{ ...good, amount: "100" }] }) } });
    await gate;
    return new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": b64({ success: false, errorReason: "insufficient_funds", transaction: "" }) } });
  };
  const g = guardFetch(inner, { fetch: alalanet(() => ({ decision: "allow" })).f });
  await g(URL1);
  const paying = g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x1", in60()) } });
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 1000; i++) await g(`https://other.example/${i}`);
  release();
  await paying;
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x2", in60()) } }), (e) => e.code === "not_approved");
});

test("after a definite refusal of a re-presented payment, the unused approval of the new 402 goes back too", async () => {
  const s = flaky(["timeout", "reject", "ok"]);
  const g = guardFetch(s.inner, { fetch: statusAndAllow({}).f, maxUsdPerDay: 0.004 });
  const vb = in60();
  await g(URL1);
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", vb) } }));
  await g(URL1);
  assert.equal((await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", vb) } })).status, 402); // 0x01 again, refused for sure
  assert.equal((await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x03", vb) } })).status, 200, "a re-sign uses the approval put back");
  assert.deepEqual(s.paid.map((p) => unb64(p).payload.authorization.nonce), ["0x01", "0x01", "0x03"]);
});

// --- 2.0: the decision's own expiry (expires_at) -------------------------------------------------

// alalanet stand-in whose decision expires `ttl` ms after its own clock, which runs `skew` ms behind ours
function expiring({ ttl, skew = 0, stale = 0 }) {
  const calls = [];
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const pr = unb64(body.payment_required);
    const options = pr.accepts.map((a) => ({ network: "base", asset: a.asset, amount: a.amount, pay_to: a.payTo, usd: Number(a.amount) / 1e6, decision: "allow" }));
    const server = Date.now() - skew;
    const expires = calls.length <= stale ? server - 1000 : server + ttl;
    return new Response(JSON.stringify({ decision: "allow", options, expires_at: new Date(expires).toISOString() }), { status: 200, headers: { date: new Date(server).toUTCString() } });
  };
  return { f, calls };
}

test("an approval lapses at the decision's expires_at when that is sooner than 20 minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const a = expiring({ ttl: 60_000 });
  const g = guardFetch(server({ accepts: [good] }).inner, { fetch: a.f });
  await g(URL1);
  t.mock.timers.tick(59_000);
  assert.equal((await g(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } })).status, 200);
  await g(URL1);
  t.mock.timers.tick(61_000);
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } }), (e) => e.code === "not_approved");
  assert.equal((await g(URL1)).status, 402, "a new 402 goes back to alalanet");
  assert.equal(a.calls.length, 3);
  const later = expiring({ ttl: 60 * 60 * 1000 });
  const h = guardFetch(server({ accepts: [good] }).inner, { fetch: later.f });
  await h(URL1);
  t.mock.timers.tick(20 * 60 * 1000 + 1);
  await assert.rejects(h(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } }), (e) => e.code === "not_approved", "the guard's own 20 minutes still bound it");
});

test("expires_at is read on alalanet's clock (its Date header), not ours", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const a = expiring({ ttl: 60_000, skew: 10 * 60 * 1000 }); // alalanet's clock 10 minutes behind
  const g = guardFetch(server({ accepts: [good] }).inner, { fetch: a.f });
  await g(URL1);
  t.mock.timers.tick(30_000);
  assert.equal((await g(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } })).status, 200);
});

test("a decision already past its expiry is asked again once, then refused decision_expired", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const once = expiring({ ttl: 60_000, stale: 1 });
  assert.equal((await guardFetch(server({ accepts: [good] }).inner, { fetch: once.f })(URL1)).status, 402);
  assert.equal(once.calls.length, 2);
  const twice = expiring({ ttl: 60_000, stale: 2 });
  await assert.rejects(guardFetch(server({ accepts: [good] }).inner, { fetch: twice.f })(URL1), (e) => e.code === "decision_expired");
  assert.equal(twice.calls.length, 2);
});

test("an approval put back after a definite refusal still lapses at the decision's expiry", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const inner = async (req) =>
    req.headers.has("PAYMENT-SIGNATURE")
      ? new Response("{}", { status: 402, headers: { "PAYMENT-RESPONSE": b64({ success: false, errorReason: "insufficient_funds", transaction: "" }) } })
      : new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [good] }) } });
  const g = guardFetch(inner, { fetch: expiring({ ttl: 60_000 }).f });
  await g(URL1);
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } });
  t.mock.timers.tick(61_000);
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": "sig2" } }), (e) => e.code === "not_approved");
});

test("R5-F a decision expired on arrival whose re-ask fails is refused decision_expired, failOpen or not", async () => {
  for (const failOpen of [true, false]) {
    let n = 0;
    const api = async (url, init) => {
      if (++n === 2) throw new Error("ECONNREFUSED");
      const pr = unb64(JSON.parse(init.body).payment_required);
      const options = pr.accepts.map((a) => ({ network: "base", asset: a.asset, amount: a.amount, pay_to: a.payTo, usd: 0.002, decision: "block", reasons: ["pay_to_sanctioned"] }));
      return new Response(JSON.stringify({ decision: "block", options, expires_at: new Date(Date.now() - 1000).toISOString() }), { status: 200 });
    };
    await assert.rejects(guardFetch(server({ accepts: [good] }).inner, { fetch: api, failOpen })(URL1), (e) => e.code === "decision_expired", `failOpen ${failOpen}`);
    assert.equal(n, 2);
  }
});
