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

test("refused payment is reported as not paid and costs nothing", async () => {
  const inner = async (req) => new Response("{}", { status: 402, headers: req.headers.has("PAYMENT-SIGNATURE") ? {} : { "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [good] }) } });
  const a = alalanet(() => ({ decision: "allow" }));
  const seen = [];
  const g = guardFetch(inner, { fetch: a.f, maxUsdPerDay: 0.002, onPaid: (p) => seen.push(p) });
  await g(URL1);
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": "sig" } });
  assert.equal(seen[0].paid, false);
  assert.equal(seen[0].usd, 0);
  await g(URL1); // budget untouched
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

test("a retry after a timeout re-presents the held payment instead of a new one", async () => {
  const s = flaky(["timeout", "ok"]);
  const api = statusApi({});
  const g = guardFetch(s.inner, { fetch: api.f });
  const vb = Math.floor(Date.now() / 1000) + 60;
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", vb) } }));
  const r = await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", vb) } }); // the payer signed anew
  assert.equal(r.status, 200);
  assert.deepEqual(s.paid.map((p) => unb64(p).payload.authorization.nonce), ["0x01", "0x01"], "same authorization sent twice, never a second one");
  assert.equal(api.asked.length, 0, "no chain read needed inside the window");
});

test("after the window: settled on chain means no second payment", async () => {
  const s = flaky(["502"]);
  const api = statusApi({ state: "settled", retry: "do_not_pay_again", safe_to_sign_new: false, tx: "0xpaid" });
  const g = guardFetch(s.inner, { fetch: api.f });
  const past = Math.floor(Date.now() / 1000) - 1;
  const r = await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", past) } });
  assert.equal(r.status, 502);
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", past + 120) } }), (e) => e.code === "already_paid" && e.tx === "0xpaid");
  assert.equal(s.paid.length, 1, "the second authorization never left");
  assert.match(api.asked[0], /payment-status\?.*nonce=0x01.*valid_before=/);
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x03", past + 120) } }), (e) => e.code === "already_paid");
});

test("after the window: an expired, unused authorization allows a new payment", async () => {
  const s = flaky(["502", "ok"]);
  const api = statusApi({ state: "expired_unsettled", retry: "new_payment_ok", safe_to_sign_new: true });
  const g = guardFetch(s.inner, { fetch: api.f });
  const past = Math.floor(Date.now() / 1000) - 1;
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", past) } });
  const r = await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", past + 120) } });
  assert.equal(r.status, 200);
  assert.deepEqual(s.paid.map((p) => unb64(p).payload.authorization.nonce), ["0x01", "0x02"]);
});

test("an unclear chain answer stops the payment instead of risking a second one", async () => {
  const s = flaky(["502"]);
  const g = guardFetch(s.inner, { fetch: async () => new Response("down", { status: 503 }) });
  const past = Math.floor(Date.now() / 1000) - 1;
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", past) } });
  await assert.rejects(g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", past + 120) } }), (e) => e.code === "payment_outcome_unknown");
  assert.equal(s.paid.length, 1);
});

test("a definite facilitator rejection releases the hold; other purchases are independent", async () => {
  const s = flaky(["reject", "ok", "ok"]);
  const g = guardFetch(s.inner, { fetch: statusApi({}).f });
  const vb = Math.floor(Date.now() / 1000) + 60;
  const r1 = await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x01", vb) } });
  assert.equal(r1.status, 402);
  await g(URL1, { headers: { "PAYMENT-SIGNATURE": evmPay("0x02", vb) } });
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
