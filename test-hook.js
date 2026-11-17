import { test } from "node:test";
import assert from "node:assert/strict";
import { x402Client } from "@x402/core/client";
import { alalanetGuard, alalanetHooks } from "./index.js";

// The real x402 client from @x402/core with a stand-in scheme: it records whether a payment was
// signed, so a test sees that a refused payment never reached the signer.
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const good = { scheme: "exact", network: "eip155:8453", amount: "2000", asset: USDC, payTo: "0xAAA", maxTimeoutSeconds: 60, extra: {} };
const evil = { ...good, payTo: "0xEVIL" };
const required = (accepts, url = "https://shop.example/paid") => ({ x402Version: 2, resource: { url, description: "d", mimeType: "application/json" }, accepts });

function makeClient(guardOpts, decide, alalanetDown = false, reverse = false) {
  const signed = [];
  const made = [];
  const calls = [];
  const client = new x402Client();
  client.register("eip155:8453", {
    scheme: "exact",
    findDefaultAsset: (asset) => (asset.toLowerCase() === USDC.toLowerCase() ? { asset: USDC, decimals: 6, symbol: "USDC" } : undefined),
    async createPaymentPayload(version, req) {
      signed.push(req.payTo);
      made.push(req);
      return { x402Version: version, payload: { signature: "0xsig", authorization: { from: "0xme", nonce: "0x1" } } };
    },
  });
  const fetch = async (url, init) => {
    if (alalanetDown) throw new Error("connect ECONNREFUSED");
    const body = JSON.parse(init.body);
    calls.push({ url, body, ua: init.headers["user-agent"] });
    const pr = JSON.parse(body.payment_required);
    const options = pr.accepts.map((a) => ({ network: "base", asset: a.asset, amount: a.amount ?? a.maxAmountRequired, pay_to: a.payTo, usd: Number(a.amount ?? a.maxAmountRequired) / 1e6, ...decide(a, body) }));
    if (reverse) options.reverse(); // alalanet's order is not the 402's
    const decision = options.some((o) => o.decision === "allow") ? "allow" : options.some((o) => o.decision === "hold") ? "hold" : "block";
    return new Response(JSON.stringify({ decision, options, expires_at: "x" }), { status: 200 });
  };
  alalanetGuard(client, { fetch, detectClient: false, ...guardOpts });
  return { client, signed, made, calls };
}
const settle = (client, req, success = true) =>
  client.handlePaymentResponse({ paymentPayload: { x402Version: 2, payload: {} }, requirements: req, settleResponse: { success, transaction: "0xtx", network: req.network } });

test("a blocked payment is refused before it is signed", async () => {
  const { client, signed, calls } = makeClient({}, () => ({ decision: "block", reasons: ["sanctioned_pay_to"] }));
  await assert.rejects(client.createPaymentPayload(required([good])), /Payment creation aborted: x402-guard blocked: .*sanctioned_pay_to/);
  assert.deepEqual(signed, []);
  assert.equal(calls[0].body.url, "https://shop.example/paid");
  assert.equal(calls[0].ua, "x402-guard/2.0 (hook)");
  assert.equal(JSON.parse(calls[0].body.payment_required).accepts[0].payTo, "0xAAA");
});

test("an allowed payment is signed", async () => {
  const { client, signed } = makeClient({}, () => ({ decision: "allow" }));
  await client.createPaymentPayload(required([good]));
  assert.deepEqual(signed, ["0xAAA"]);
});

test("the option the client chose is the one judged; another allowed option is named", async () => {
  const { client, signed } = makeClient({}, (a) => (a.payTo === "0xAAA" ? { decision: "allow" } : { decision: "hold", reasons: ["pay_to_differs_from_listing"] }), false, true);
  // the client picks the first option: put the held one first (alalanet lists it second)
  await assert.rejects(client.createPaymentPayload(required([evil, good])), (e) => /x402-guard held/.test(e.message) && /pay_to_differs_from_listing/.test(e.message) && /0xAAA/.test(e.message));
  assert.deepEqual(signed, []);
});

test("hold passes with onHold allow", async () => {
  const { client, signed } = makeClient({ onHold: "allow" }, () => ({ decision: "hold", reasons: ["network_not_listed"] }));
  await client.createPaymentPayload(required([good]));
  assert.deepEqual(signed, ["0xAAA"]);
});

test("the daily budget counts settled payments and payments still in flight", async () => {
  const { client, signed, calls } = makeClient({ maxUsdPerDay: 0.005 }, () => ({ decision: "allow" }));
  await client.createPaymentPayload(required([good], "https://shop.example/1")); // 0.002, in flight
  await client.createPaymentPayload(required([good], "https://shop.example/2")); // 0.002, in flight: 0.004
  assert.equal(calls[1].body.max_usd, 0.003);
  await assert.rejects(client.createPaymentPayload(required([good], "https://shop.example/3")), /x402-guard over_budget/); // 0.006 > 0.005
  await settle(client, good, false); // the seller says it did not settle: its word frees nothing
  await assert.rejects(client.createPaymentPayload(required([good], "https://shop.example/4")), /over_budget/);
  assert.equal(signed.length, 2);
});

test("alalanet unreachable: refuse by default, pay with failOpen", async () => {
  const down = makeClient({}, () => ({ decision: "allow" }), true);
  await assert.rejects(down.client.createPaymentPayload(required([good])), /x402-guard alalanet_unreachable/);
  assert.deepEqual(down.signed, []);
  const open = makeClient({ failOpen: true }, () => ({ decision: "allow" }), true);
  await open.client.createPaymentPayload(required([good]));
  assert.deepEqual(open.signed, ["0xAAA"]);
});

test("x402 v1 terms: the resource and maxAmountRequired of the chosen option", async () => {
  const signedV1 = [];
  const calls = [];
  const client = new x402Client();
  client.registerV1("base", { scheme: "exact", findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }), async createPaymentPayload(v, req) { signedV1.push(req.payTo); return { x402Version: 1, scheme: "exact", network: "base", payload: {} }; } });
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return new Response(JSON.stringify({ decision: "allow", options: [{ network: "base", asset: USDC, amount: "5000", pay_to: "0xAAA", usd: 0.005, decision: "allow" }] }), { status: 200 });
  };
  alalanetGuard(client, { fetch, detectClient: false });
  const v1 = { scheme: "exact", network: "base", maxAmountRequired: "5000", resource: "https://old.example/v1", asset: USDC, payTo: "0xAAA", maxTimeoutSeconds: 60, description: "", mimeType: "" };
  await client.createPaymentPayload({ x402Version: 1, accepts: [v1] });
  assert.equal(calls[0].url, "https://old.example/v1");
  assert.deepEqual(signedV1, ["0xAAA"]);
});

test("a paid MCP tool (mcp://) needs the server URL; without one it is refused unless allowed", async () => {
  const mcp = required([good], "mcp://tool/get_weather");
  const plain = makeClient({}, () => ({ decision: "allow" }));
  await assert.rejects(plain.client.createPaymentPayload(mcp), /x402-guard unchecked: .*resourceUrl/);
  assert.equal(plain.calls.length, 0);
  const named = makeClient({ resourceUrl: "https://tools.example/mcp" }, () => ({ decision: "allow" }));
  await named.client.createPaymentPayload(mcp);
  assert.equal(named.calls[0].body.url, "https://tools.example/mcp");
  const loose = makeClient({ onUnchecked: "allow" }, () => ({ decision: "allow" }));
  await loose.client.createPaymentPayload(mcp);
  assert.equal(loose.calls.length, 0);
  assert.deepEqual(loose.signed, ["0xAAA"]);
});

test("deny and allow lists apply before alalanet is asked", async () => {
  const deny = makeClient({ denyHosts: ["*.example"] }, () => ({ decision: "allow" }));
  await assert.rejects(deny.client.createPaymentPayload(required([good])), /x402-guard denied_host/);
  assert.equal(deny.calls.length, 0);
  const allow = makeClient({ allowHosts: ["api.other"] }, () => ({ decision: "allow" }));
  await assert.rejects(allow.client.createPaymentPayload(required([good])), /x402-guard not_allowed_host/);
});

test("onDecision and onAbort see the verdict", async () => {
  const seen = [];
  const { client } = makeClient({ onDecision: (d) => seen.push(["d", d.decision]), onAbort: (a) => seen.push(["a", a.code, a.reasons.join()]) }, () => ({ decision: "block", reasons: ["pay_to_unknown"] }));
  await assert.rejects(client.createPaymentPayload(required([good])));
  assert.deepEqual(seen, [["d", "block"], ["a", "blocked", "pay_to_unknown"]]);
});

test("a spent budget refuses before alalanet is asked", async () => {
  const { client, calls } = makeClient({ maxUsdPerDay: 0.004 }, () => ({ decision: "allow" }));
  await client.createPaymentPayload(required([good]));
  await settle(client, good, true);
  await client.createPaymentPayload(required([good]));
  await settle(client, good, true);
  await assert.rejects(client.createPaymentPayload(required([good])), /x402-guard over_budget: daily budget spent/);
  assert.equal(calls.length, 2);
});

test("a per-seller budget counts that seller only", async () => {
  const { client } = makeClient({ maxUsdPerHostPerDay: 0.002 }, () => ({ decision: "allow" }));
  await client.createPaymentPayload(required([good]));
  await settle(client, good, true);
  await assert.rejects(client.createPaymentPayload(required([good])), /over_budget: daily budget for shop.example spent/);
  await client.createPaymentPayload(required([good], "https://other.example/paid"));
});

// --- independent review of 1.4.0 ---------------------------------------------------------------

test("concurrent payments cannot all pass one daily budget", async () => {
  const { client, signed } = makeClient({ maxUsdPerDay: 0.005 }, () => ({ decision: "allow" }));
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => client.createPaymentPayload(required([good], `https://shop.example/${i}`))));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(signed.length, 2);
});

test("a payment without a payment response (x402 v1, a lost answer, no header) stays counted", async () => {
  const { client, signed } = makeClient({ maxUsdPerDay: 0.005 }, () => ({ decision: "allow" }));
  await client.createPaymentPayload(required([good], "https://shop.example/1"));
  await client.createPaymentPayload(required([good], "https://shop.example/2"));
  // no settle reported for either: both count, the day is spent
  await assert.rejects(client.createPaymentPayload(required([good], "https://shop.example/3")), /over_budget/);
  // a 2xx without PAYMENT-RESPONSE: handlePaymentResponse with no settleResponse keeps it counted
  await client.handlePaymentResponse({ paymentPayload: { x402Version: 2, payload: {} }, requirements: good });
  await assert.rejects(client.createPaymentPayload(required([good], "https://shop.example/4")), /over_budget/);
  assert.equal(signed.length, 2);
});

test("a seller's refusal frees nothing: an allowed seller cannot drain the budget by claiming failure", async () => {
  const { client, signed } = makeClient({ maxUsdPerDay: 0.005 }, () => ({ decision: "allow" }));
  for (let i = 0; i < 10; i++) {
    try {
      await client.createPaymentPayload(required([good], `https://shop.example/${i}`));
    } catch {
      continue;
    }
    // the seller settles, then answers 402 or success: false
    if (i % 2) await settle(client, good, false);
    else await client.handlePaymentResponse({ paymentPayload: { x402Version: 2, payload: {} }, requirements: good, paymentRequired: required([good]) });
  }
  assert.equal(signed.length, 2);
});

test("a payment that was never created (signer failed) frees its share of the budget", async () => {
  let fail = true;
  const signedNow = [];
  const client = new x402Client();
  client.register("eip155:8453", {
    scheme: "exact",
    findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }),
    async createPaymentPayload(v, req) {
      if (fail) throw new Error("signer locked");
      signedNow.push(req.payTo);
      return { x402Version: v, payload: {} };
    },
  });
  const fetch = async (url, init) => new Response(JSON.stringify({ decision: "allow", options: [{ network: "base", network_id: "eip155:8453", asset: USDC, amount: "2000", pay_to: "0xAAA", usd: 0.002, decision: "allow" }] }), { status: 200 });
  alalanetGuard(client, { fetch, detectClient: false, maxUsdPerDay: 0.004 });
  for (let i = 0; i < 3; i++) await assert.rejects(client.createPaymentPayload(required([good])), /signer locked/);
  fail = false;
  await client.createPaymentPayload(required([good])); // the failed attempts left no mark on the resource either
  await client.createPaymentPayload(required([good], "https://shop.example/2"));
  await assert.rejects(client.createPaymentPayload(required([good], "https://shop.example/3")), /over_budget/);
  assert.equal(signedNow.length, 2);
});

test("a failure frees the entry of that payment, not another seller's", async () => {
  let failFor = "";
  const client = new x402Client();
  client.register("eip155:8453", {
    scheme: "exact",
    findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }),
    async createPaymentPayload(v, req) {
      await new Promise((r) => setTimeout(r, 5));
      if (failFor && req.extra?.host === failFor) throw new Error("signer failed for " + failFor);
      return { x402Version: v, payload: {} };
    },
  });
  const fetch = async (url, init) => new Response(JSON.stringify({ decision: "allow", options: [{ network: "base", network_id: "eip155:8453", asset: USDC, amount: "2000", pay_to: "0xAAA", usd: 0.002, decision: "allow" }] }), { status: 200 });
  alalanetGuard(client, { fetch, detectClient: false, maxUsdPerHostPerDay: 0.002 });
  const forA = { ...good, extra: { host: "a" } };
  const forB = { ...good, extra: { host: "b" } };
  failFor = "b";
  await Promise.allSettled([
    client.createPaymentPayload(required([forA], "https://a.example/x")),
    client.createPaymentPayload(required([forB], "https://b.example/x")),
  ]);
  failFor = "";
  // a.example's payment went out: its seller budget is spent; b.example's failed: it is free
  await assert.rejects(client.createPaymentPayload(required([forA], "https://a.example/x")), /over_budget: daily budget for a.example spent/);
  await client.createPaymentPayload(required([forB], "https://b.example/x"));
  // the other way round: the first one recorded fails
  const c2 = new x402Client();
  c2.register("eip155:8453", {
    scheme: "exact",
    findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }),
    async createPaymentPayload(v, req) {
      await new Promise((r) => setTimeout(r, 5));
      if (req.extra?.host === "a") throw new Error("signer failed for a");
      return { x402Version: v, payload: {} };
    },
  });
  alalanetGuard(c2, { fetch, detectClient: false, maxUsdPerHostPerDay: 0.002 });
  await Promise.allSettled([
    c2.createPaymentPayload(required([forA], "https://a.example/x")),
    c2.createPaymentPayload(required([forB], "https://b.example/x")),
  ]);
  await assert.rejects(c2.createPaymentPayload(required([forB], "https://b.example/x")), /over_budget: daily budget for b.example spent/);
});

test("a resourceUrl function decides even when the 402 names an https URL", async () => {
  const { client, calls } = makeClient({ resourceUrl: () => "https://my-server.example/mcp" }, () => ({ decision: "allow" }));
  await client.createPaymentPayload(required([good], "https://somewhere.example/tool"));
  assert.equal(calls[0].body.url, "https://my-server.example/mcp");
});

test("an option without a known USD price is refused when a budget is set", async () => {
  const odd = { ...good, asset: "0x1111111111111111111111111111111111111111", amount: "900000" };
  const { client, signed } = makeClient({ maxUsdPerCall: 0.001 }, (a) => ({ decision: "allow", usd: undefined }));
  // the stand-in scheme knows only USDC: allow every asset for this test
  client.setSpendControls(false);
  await assert.rejects(client.createPaymentPayload(required([odd])), /x402-guard over_budget: .*price is unknown/);
  assert.deepEqual(signed, []);
  const free = makeClient({}, () => ({ decision: "allow", usd: undefined }));
  free.client.setSpendControls(false);
  await free.client.createPaymentPayload(required([odd])); // no budget: nothing to compare
  assert.equal(free.signed.length, 1);
});

test("resourceUrl is used only when the 402 names no https URL", async () => {
  const { client, calls } = makeClient({ resourceUrl: "https://tools.example/mcp" }, () => ({ decision: "allow" }));
  await client.createPaymentPayload(required([good]));
  assert.equal(calls[0].body.url, "https://shop.example/paid");
  await client.createPaymentPayload(required([good], "mcp://tool/x"));
  assert.equal(calls[1].body.url, "https://tools.example/mcp");
});

test("the chosen option is matched on its network too", async () => {
  const onMainnet = { ...good, network: "eip155:1" };
  const signedNets = [];
  const client = new x402Client();
  for (const net of ["eip155:8453", "eip155:1"]) {
    client.register(net, { scheme: "exact", findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }), async createPaymentPayload(v, req) { signedNets.push(req.network); return { x402Version: v, payload: {} }; } });
  }
  // a verdict with network_id: base allowed, mainnet held; alalanet lists base first
  const fetchWithId = async (url, init) => new Response(JSON.stringify({ decision: "allow", options: [
    { network: "base", network_id: "eip155:8453", asset: USDC, amount: "2000", pay_to: "0xAAA", usd: 0.002, decision: "allow" },
    { network: "ethereum", network_id: "eip155:1", asset: USDC, amount: "2000", pay_to: "0xAAA", usd: 0.002, decision: "hold", reasons: ["network_not_listed"] },
  ] }), { status: 200 });
  alalanetGuard(client, { fetch: fetchWithId, detectClient: false });
  await assert.rejects(client.createPaymentPayload(required([onMainnet, good])), /x402-guard held: .*network_not_listed/);
  await client.createPaymentPayload(required([good, onMainnet])); // base chosen: allowed, mainnet's hold does not count
  assert.deepEqual(signedNets, ["eip155:8453"]);
  signedNets.length = 0;
  // an older verdict without network_id: the stricter of the matching options decides
  const client2 = new x402Client();
  client2.register("eip155:1", { scheme: "exact", findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }), async createPaymentPayload(v) { signedNets.push("x"); return { x402Version: v, payload: {} }; } });
  const fetchNoId = async () => new Response(JSON.stringify({ decision: "allow", options: [
    { network: "base", asset: USDC, amount: "2000", pay_to: "0xAAA", usd: 0.002, decision: "allow" },
    { network: "ethereum", asset: USDC, amount: "2000", pay_to: "0xAAA", usd: 0.002, decision: "hold", reasons: ["network_not_listed"] },
  ] }), { status: 200 });
  alalanetGuard(client2, { fetch: fetchNoId, detectClient: false });
  await assert.rejects(client2.createPaymentPayload(required([onMainnet])), /x402-guard held/);
  assert.deepEqual(signedNets, []);
});

test("parallel payments that use up the budget exactly leave nothing for the next", async () => {
  const { client, signed } = makeClient({ maxUsdPerDay: 0.004 }, () => ({ decision: "allow" }));
  const results = await Promise.allSettled([1, 2, 3].map((i) => client.createPaymentPayload(required([good], `https://shop.example/${i}`))));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.match(results.find((r) => r.status === "rejected").reason.message, /over_budget: daily budget spent/);
  assert.equal(signed.length, 2);
});

test("a scheme's own recovery cannot swap in an unchecked payment after a failure", async () => {
  // like @x402/svm's batch scheme: on a signing failure it signs ANOTHER accept (same network and
  // asset, any payTo) and hands it back through its onPaymentCreationFailure hook
  const signedTo = [];
  const client = new x402Client();
  client.register("eip155:8453", {
    scheme: "exact",
    findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }),
    schemeHooks: {
      onPaymentCreationFailure: async (ctx) => {
        const fallback = ctx.paymentRequired.accepts.find((a) => a !== ctx.selectedRequirements);
        signedTo.push(fallback.payTo);
        return { recovered: true, payload: { x402Version: 2, payload: {}, accepted: fallback } };
      },
    },
    async createPaymentPayload() {
      throw new Error("operator untrusted");
    },
  });
  const fetch = async () => new Response(JSON.stringify({ decision: "allow", options: [
    { network: "base", network_id: "eip155:8453", asset: USDC, amount: "2000", pay_to: "0xAAA", usd: 0.002, decision: "allow" },
    { network: "base", network_id: "eip155:8453", asset: USDC, amount: "2000", pay_to: "0xEVIL", usd: 0.002, decision: "block", reasons: ["pay_to_sanctioned"] },
  ] }), { status: 200 });
  alalanetGuard(client, { fetch, detectClient: false, maxUsdPerDay: 0.003 });
  await assert.rejects(client.createPaymentPayload(required([good, evil])), (e) => /operator untrusted/.test(e.message) && /x402-guard/.test(e.message));
  assert.deepEqual(signedTo, [], "the scheme's replacement was never asked for");
});

test("a failure after an unchecked payment does not free an earlier, real one", async () => {
  let down = false;
  let failNext = false;
  const client = new x402Client();
  client.register("eip155:8453", {
    scheme: "exact",
    findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }),
    async createPaymentPayload(v) {
      if (failNext) { failNext = false; throw new Error("signer failed"); }
      return { x402Version: v, payload: {} };
    },
  });
  const fetch = async () => {
    if (down) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify({ decision: "allow", options: [{ network: "base", network_id: "eip155:8453", asset: USDC, amount: "2000", pay_to: "0xAAA", usd: 0.002, decision: "allow" }] }), { status: 200 });
  };
  alalanetGuard(client, { fetch, detectClient: false, maxUsdPerDay: 0.004, failOpen: true });
  const pr = required([good]); // one object, reused
  await client.createPaymentPayload(pr); // counted 0.002
  down = true;
  failNext = true;
  pr.resource.url = "https://shop.example/2"; // the same option object, another resource
  await assert.rejects(client.createPaymentPayload(pr), /signer failed/); // unchecked (failOpen) and failed: frees nothing real
  down = false;
  pr.resource.url = "https://shop.example/3";
  await client.createPaymentPayload(pr); // counted 0.004
  pr.resource.url = "https://shop.example/4";
  await assert.rejects(client.createPaymentPayload(pr), /over_budget/);
});

test("the same for a payment let through by onUnchecked", async () => {
  let failNext = false;
  const client = new x402Client();
  client.register("eip155:8453", {
    scheme: "exact",
    findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }),
    async createPaymentPayload(v) {
      if (failNext) { failNext = false; throw new Error("signer failed"); }
      return { x402Version: v, payload: {} };
    },
  });
  const fetch = async () => new Response(JSON.stringify({ decision: "allow", options: [{ network: "base", network_id: "eip155:8453", asset: USDC, amount: "2000", pay_to: "0xAAA", usd: 0.002, decision: "allow" }] }), { status: 200 });
  let url = "https://shop.example/paid";
  alalanetGuard(client, { fetch, detectClient: false, maxUsdPerDay: 0.004, onUnchecked: "allow", resourceUrl: () => url });
  const pr = required([good]);
  await client.createPaymentPayload(pr); // checked, counted 0.002
  url = "";
  pr.resource.url = "mcp://tool/x";
  failNext = true;
  await assert.rejects(client.createPaymentPayload(pr), /signer failed/); // unchecked and failed
  url = "https://shop.example/paid2";
  await client.createPaymentPayload(pr); // 0.004
  url = "https://shop.example/paid3";
  await assert.rejects(client.createPaymentPayload(pr), /over_budget/);
});

// --- 1.5: new sellers, the cheapest option, one open payment per resource (FIZZL-EXAM-1) ---------

test("a new seller is paid by default up to $0.05; a hold that compares against data is not", async () => {
  const fresh = makeClient({}, () => ({ decision: "hold", reasons: ["unknown_service", "testnet"] }));
  await fresh.client.createPaymentPayload(required([good]));
  assert.deepEqual(fresh.signed, ["0xAAA"]);
  const dear = makeClient({}, () => ({ decision: "hold", reasons: ["not_checked_yet"] }));
  await assert.rejects(dear.client.createPaymentPayload(required([{ ...good, amount: "50001" }])), /x402-guard held: .*new seller.*0\.05/);
  const data = makeClient({}, () => ({ decision: "hold", reasons: ["not_rated_yet", "price_above_listing"] }));
  await assert.rejects(data.client.createPaymentPayload(required([good])), /x402-guard held/);
  const block = makeClient({ onHold: "block" }, () => ({ decision: "hold", reasons: ["unknown_service"] }));
  await assert.rejects(block.client.createPaymentPayload(required([good])), /x402-guard held/);
  assert.deepEqual([dear, data, block].flatMap((c) => c.signed), []);
});

test("the new-seller daily cap counts new sellers only and is checked when the payment is approved", async () => {
  const { client, signed } = makeClient({ newSeller: { maxUsdPerDay: 0.005 } }, (a, body) =>
    body.url.includes("known") ? { decision: "allow" } : { decision: "hold", reasons: ["pay_to_never_seen"] });
  const results = await Promise.allSettled([1, 2, 3].map((i) => client.createPaymentPayload(required([good], `https://shop.example/${i}`))));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.match(results.find((r) => r.status === "rejected").reason.message, /held: .*new seller.*0\.005/);
  await client.createPaymentPayload(required([good], "https://known.example/a"));
  assert.equal(signed.length, 3);
});

test("the client is steered to a payee's cheapest option; a dearer one is refused with cheaper_option", async () => {
  const dear = { ...good, amount: "500000" };
  const otherPayee = { ...good, payTo: "0xBBB", amount: "100" };
  const { client, made } = makeClient({}, () => ({ decision: "allow" }));
  await client.createPaymentPayload(required([dear, good]));
  assert.deepEqual(made.map((r) => r.amount), ["2000"]);
  await client.createPaymentPayload(required([dear, otherPayee], "https://shop.example/2")); // another payee: the client's choice stands
  assert.deepEqual(made.map((r) => r.amount), ["2000", "500000"]);
  // hooks wired without the guard's policy: the hook itself refuses the dearer option
  const bare = new x402Client();
  const signed = [];
  bare.register("eip155:8453", { scheme: "exact", findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }), async createPaymentPayload(v, req) { signed.push(req.amount); return { x402Version: v, payload: {} }; } });
  const fetch = async (url, init) => {
    const pr = JSON.parse(JSON.parse(init.body).payment_required);
    const options = pr.accepts.map((a) => ({ network: "base", network_id: a.network, asset: a.asset, amount: a.amount, pay_to: a.payTo, usd: Number(a.amount) / 1e6, decision: "allow" }));
    return new Response(JSON.stringify({ decision: "allow", options }), { status: 200 });
  };
  const h = alalanetHooks({ fetch, detectClient: false });
  bare.onBeforePaymentCreation(h.onBeforePaymentCreation);
  await assert.rejects(bare.createPaymentPayload(required([dear, good])), /x402-guard cheaper_option: .*0\.002.*0xAAA/);
  assert.deepEqual(signed, []);
  await bare.createPaymentPayload(required([good, dear], "https://shop.example/3"));
  assert.deepEqual(signed, ["2000"]);
  assert.deepEqual(h.policy(2, [dear, good, otherPayee]), [good, otherPayee]);
  const v1 = (amount) => ({ ...good, amount: undefined, maxAmountRequired: amount });
  assert.deepEqual(h.policy(1, [v1("9"), v1("10")]).map((r) => r.maxAmountRequired), ["9"]);
});

test("a cheaper option on another network, asset or scheme is not a reason to refuse", async () => {
  const fetch = async (url, init) => {
    const pr = JSON.parse(JSON.parse(init.body).payment_required);
    const options = pr.accepts.map((a) => ({ network: a.network, network_id: a.network, asset: a.asset, amount: a.amount, pay_to: a.payTo, usd: Number(a.amount) / 1e6, decision: "allow" }));
    return new Response(JSON.stringify({ decision: "allow", options }), { status: 200 });
  };
  const signed = [];
  const c = new x402Client();
  c.register("eip155:8453", { scheme: "exact", findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }), async createPaymentPayload(v, req) { signed.push(req.amount); return { x402Version: v, payload: {} }; } });
  const h = alalanetHooks({ fetch, detectClient: false });
  c.onBeforePaymentCreation(h.onBeforePaymentCreation);
  const dear = { ...good, amount: "500000" };
  await c.createPaymentPayload(required([dear, { ...good, network: "eip155:1" }], "https://shop.example/a"));
  await c.createPaymentPayload(required([dear, { ...good, scheme: "upto" }], "https://shop.example/b"));
  await c.createPaymentPayload(required([dear, { ...good, asset: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2" }], "https://shop.example/c"));
  assert.deepEqual(signed, ["500000", "500000", "500000"]);
});

test("the hook does not pay a resource again while its payment is open, nor to a new payee", async () => {
  const { client, signed } = makeClient({}, (a) => (a.payTo === "0xEVIL" ? { decision: "hold", reasons: ["pay_to_never_seen"] } : { decision: "allow" }));
  await client.createPaymentPayload(required([good]));
  await assert.rejects(client.createPaymentPayload(required([good])), /x402-guard already_paid/);
  await assert.rejects(client.createPaymentPayload(required([evil])), /x402-guard pay_to_changed: .*0xAAA.*0xEVIL/);
  await client.createPaymentPayload(required([good], "https://shop.example/other"));
  assert.deepEqual(signed, ["0xAAA", "0xAAA"]);
  const off = makeClient({ holdPayments: false }, () => ({ decision: "allow" }));
  await off.client.createPaymentPayload(required([good]));
  await off.client.createPaymentPayload(required([good]));
  assert.equal(off.signed.length, 2);
});

test("a settled or definitely refused payment ends the memory; an unclear answer keeps it", async () => {
  const { client, signed } = makeClient({}, () => ({ decision: "allow" }));
  const p1 = await client.createPaymentPayload(required([good]));
  await client.handlePaymentResponse({ paymentPayload: p1, requirements: p1.accepted, paymentRequired: { ...required([good]), error: "payment not received, please retry" } });
  await assert.rejects(client.createPaymentPayload(required([good])), /already_paid/);
  await client.handlePaymentResponse({ paymentPayload: p1, requirements: p1.accepted, paymentRequired: { ...required([good]), error: "settlement_pending" } });
  await client.handlePaymentResponse({ paymentPayload: p1, requirements: p1.accepted, settleResponse: { success: false, errorReason: "insufficient_funds", transaction: "0xtx" } });
  await assert.rejects(client.createPaymentPayload(required([good])), /already_paid/);
  await client.handlePaymentResponse({ paymentPayload: p1, requirements: p1.accepted, settleResponse: { success: false, errorReason: "insufficient_funds", transaction: "" } });
  const p2 = await client.createPaymentPayload(required([good]));
  await client.handlePaymentResponse({ paymentPayload: p2, requirements: p2.accepted, paymentRequired: { ...required([good]), error: "invalid_signature" } });
  const p3 = await client.createPaymentPayload(required([good]));
  await client.handlePaymentResponse({ paymentPayload: p3, requirements: p3.accepted, settleResponse: { success: true, transaction: "0xtx", network: good.network } });
  await client.createPaymentPayload(required([good]));
  assert.equal(signed.length, 4);
});

test("the memory lasts until the payment's validBefore; a new payee stays refused for 15 minutes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const signed = [];
  const client = new x402Client();
  client.register("eip155:8453", {
    scheme: "exact",
    findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }),
    async createPaymentPayload(v, req) {
      signed.push(req.payTo);
      return { x402Version: v, payload: { authorization: { validBefore: String(Math.floor(Date.now() / 1000) + 300) } } };
    },
  });
  const fetch = async (url, init) => {
    const pr = JSON.parse(JSON.parse(init.body).payment_required);
    const options = pr.accepts.map((a) => ({ network: "base", network_id: a.network, asset: a.asset, amount: a.amount, pay_to: a.payTo, usd: 0.002, ...(a.payTo === "0xEVIL" ? { decision: "hold", reasons: ["unknown_service"] } : { decision: "allow" }) }));
    return new Response(JSON.stringify({ decision: "allow", options }), { status: 200 });
  };
  alalanetGuard(client, { fetch, detectClient: false });
  await client.createPaymentPayload(required([good])); // maxTimeoutSeconds 60, the payment says 300
  t.mock.timers.tick(299_000);
  await assert.rejects(client.createPaymentPayload(required([good])), /already_paid/);
  t.mock.timers.tick(1_000);
  await assert.rejects(client.createPaymentPayload(required([evil])), /pay_to_changed/);
  await client.createPaymentPayload(required([good]));
  t.mock.timers.tick(15 * 60 * 1000);
  await client.createPaymentPayload(required([evil]));
  assert.deepEqual(signed, ["0xAAA", "0xAAA", "0xEVIL"]);
});

test("a payment approved but never created leaves no mark", async () => {
  let fail = true;
  const client = new x402Client();
  client.register("eip155:8453", { scheme: "exact", findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }), async createPaymentPayload(v) { if (fail) throw new Error("signer locked"); return { x402Version: v, payload: {} }; } });
  const fetch = async () => new Response(JSON.stringify({ decision: "allow", options: [{ network: "base", network_id: "eip155:8453", asset: USDC, amount: "2000", pay_to: "0xAAA", usd: 0.002, decision: "allow" }] }), { status: 200 });
  alalanetGuard(client, { fetch, detectClient: false });
  await assert.rejects(client.createPaymentPayload(required([good])), /signer locked/);
  fail = false;
  await client.createPaymentPayload(required([good]));
});

test("hook: allowUrlPrefixes and expectPayTo are refused before alalanet is asked; a look-alike of a payee paid on that host after it", async () => {
  const PAYEE = "0x1234" + "5".repeat(32) + "abcd";
  const LOOK = "0x1234" + "d3ad".repeat(8) + "abcd";
  const scoped = makeClient({ allowUrlPrefixes: ["https://shop.example/paid"] }, () => ({ decision: "allow" }));
  await assert.rejects(scoped.client.createPaymentPayload(required([good], "https://shop.example/refund")), /x402-guard not_allowed_url/);
  await scoped.client.createPaymentPayload(required([good], "https://shop.example/paid/x"));
  assert.equal(scoped.calls.length, 1);
  const pinned = makeClient({ expectPayTo: { "shop.example": "0xBBB" } }, () => ({ decision: "allow" }));
  await assert.rejects(pinned.client.createPaymentPayload(required([good])), /x402-guard pay_to_unexpected: .*0xAAA/);
  assert.equal(pinned.calls.length, 0);
  const seen = makeClient({}, (a) => (a.payTo === LOOK ? { decision: "hold", reasons: ["unknown_service"] } : { decision: "allow" }));
  await seen.client.createPaymentPayload(required([{ ...good, payTo: PAYEE }], "https://a.example/x"));
  await assert.rejects(seen.client.createPaymentPayload(required([{ ...good, payTo: LOOK }], "https://a.example/y")), new RegExp(`x402-guard pay_to_lookalike: .*${PAYEE}`));
  await seen.client.createPaymentPayload(required([{ ...good, payTo: LOOK }], "https://b.example/x")); // another host
  assert.equal(seen.calls.length, 3);
});

test("hook: userAgent goes in front of the guard's own", async () => {
  const { client, calls } = makeClient({ userAgent: "alalanet-review/1" }, () => ({ decision: "allow" }));
  await client.createPaymentPayload(required([good]));
  assert.equal(calls[0].ua, "alalanet-review/1 x402-guard/2.0 (hook)");
});

test("the default new-seller cap is $0.25 a day; payments to known sellers do not use it", async () => {
  const { client } = makeClient({}, (a, body) => (body.url.includes("known") ? { decision: "allow" } : { decision: "hold", reasons: ["unknown_service"] }));
  const fifty = { ...good, amount: "50000" };
  for (let i = 0; i < 4; i++) await client.createPaymentPayload(required([fifty], `https://known.example/${i}`));
  for (let i = 0; i < 5; i++) await client.createPaymentPayload(required([fifty], `https://new.example/${i}`));
  await assert.rejects(client.createPaymentPayload(required([good], "https://new.example/6")), /held: .*new seller.*0\.25/);
});

test("two parallel payments for one resource: one goes out", async () => {
  const { client, signed } = makeClient({}, () => ({ decision: "allow" }));
  const results = await Promise.allSettled([client.createPaymentPayload(required([good])), client.createPaymentPayload(required([good]))]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(results.find((r) => r.status === "rejected").reason.message, /already_paid/);
  assert.equal(signed.length, 1);
});

test("a cheaper option alalanet does not allow is no reason to refuse; the policy keeps other assets and schemes", async () => {
  const dear = { ...good, amount: "500000" };
  const { client, made } = makeClient({}, (a) => (a.amount === "2000" ? { decision: "block", reasons: ["pay_to_sanctioned"] } : { decision: "allow" }));
  const h = alalanetHooks({});
  const bare = new x402Client();
  bare.register("eip155:8453", { scheme: "exact", findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }), async createPaymentPayload(v, req) { made.push(req); return { x402Version: v, payload: {} }; } });
  const fetch = async (url, init) => {
    const pr = JSON.parse(JSON.parse(init.body).payment_required);
    const options = pr.accepts.map((a) => ({ network: "base", network_id: a.network, asset: a.asset, amount: a.amount, pay_to: a.payTo, usd: Number(a.amount) / 1e6, decision: a.amount === "2000" ? "block" : "allow" }));
    return new Response(JSON.stringify({ decision: "allow", options }), { status: 200 });
  };
  const hooks = alalanetHooks({ fetch, detectClient: false });
  bare.onBeforePaymentCreation(hooks.onBeforePaymentCreation);
  await bare.createPaymentPayload(required([dear, good]));
  assert.deepEqual(made.map((r) => r.amount), ["500000"]);
  const otherAsset = { ...good, asset: "0x1111111111111111111111111111111111111111" };
  const upto = { ...good, scheme: "upto" };
  assert.deepEqual(h.policy(2, [dear, otherAsset]), [dear, otherAsset]);
  assert.deepEqual(h.policy(2, [dear, upto]), [dear, upto]);
  assert.equal(client.constructor, x402Client);
});

test("paid MCP tools: one open payment per tool, not per server URL", async () => {
  const { client, signed, calls } = makeClient({ resourceUrl: "https://tools.example/mcp" }, () => ({ decision: "allow" }));
  await client.createPaymentPayload(required([good], "mcp://tool/weather"));
  await client.createPaymentPayload(required([good], "mcp://tool/news"));
  await assert.rejects(client.createPaymentPayload(required([good], "mcp://tool/weather")), /already_paid: .*mcp:\/\/tool\/weather/);
  assert.deepEqual(calls.map((c) => c.body.url), ["https://tools.example/mcp", "https://tools.example/mcp"]);
  assert.equal(signed.length, 2);
});

// --- 2.0 round 2: review-1116 guard15 probes, adopted --------------------------------------------

const NEWHOLD = () => ({ decision: "hold", reasons: ["unknown_service", "testnet"] });

test("Q1d with allowHosts or allowUrlPrefixes, a new-seller hold on a URL the 402 names is not paid", async () => {
  const at = (u) => required([{ ...good, payTo: "0xEVIL" }], u);
  for (const scope of [{ allowHosts: ["api.trusted.example"] }, { allowUrlPrefixes: ["https://api.trusted.example/"] }]) {
    const h = makeClient(scope, NEWHOLD);
    await assert.rejects(h.client.createPaymentPayload(at("https://api.trusted.example/anything")), /x402-guard held: .*names the URL/);
    assert.deepEqual(h.signed, []);
    const known = makeClient(scope, () => ({ decision: "allow" }));
    await known.client.createPaymentPayload(at("https://api.trusted.example/anything"));
    assert.deepEqual(known.signed, ["0xEVIL"]);
  }
  const pinned = makeClient({ allowHosts: ["api.trusted.example"], expectPayTo: { "api.trusted.example": "0xEVIL" } }, NEWHOLD);
  await pinned.client.createPaymentPayload(at("https://api.trusted.example/anything"));
  const chosen = makeClient({ allowHosts: ["api.trusted.example"], resourceUrl: () => "https://api.trusted.example/mcp" }, NEWHOLD);
  await chosen.client.createPaymentPayload(at("mcp://tool/x"));
  const open = makeClient({}, NEWHOLD);
  await open.client.createPaymentPayload(at("https://api.trusted.example/anything"));
  assert.equal(pinned.signed.length + chosen.signed.length + open.signed.length, 3);
});

test("Q2a documented: a seller naming another resource each time is paid each time", async () => {
  const { client, signed } = makeClient({}, () => ({ decision: "allow" }));
  for (let i = 0; i < 3; i++) await client.createPaymentPayload(required([good], `https://shop.example/paid?n=${i}`));
  assert.equal(signed.length, 3);
});

test("Q2b a new payee alalanet allows (listed) is paid after another seller named its resource; an unlisted one waits", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  let listed = false;
  const { client, signed, calls } = makeClient({}, (a) => (a.payTo === "0xAAA" && listed ? { decision: "allow" } : { decision: "hold", reasons: ["unknown_service"] }));
  await client.createPaymentPayload(required([{ ...good, payTo: "0xEVIL" }], "https://honest.example/data"));
  await assert.rejects(client.createPaymentPayload(required([good], "https://honest.example/data")), /pay_to_changed/);
  listed = true;
  await assert.rejects(client.createPaymentPayload(required([good], "https://honest.example/data")), /already_paid/); // the first is still open
  t.mock.timers.tick(60_000);
  await client.createPaymentPayload(required([good], "https://honest.example/data"));
  assert.deepEqual(signed, ["0xEVIL", "0xAAA"]);
  assert.equal(calls.length, 4);
});

test("Q-extra a cheaper option in another asset is no reason to refuse", async () => {
  const USDT = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
  const { client, made } = makeClient({}, () => ({ decision: "allow" }));
  await client.createPaymentPayload(required([{ ...good, amount: "500000" }, { ...good, asset: USDT, amount: "400000" }]));
  assert.deepEqual(made.map((r) => r.asset), [USDC]);
});

test("a resourceUrl function decides the URL: a new seller under allowHosts is paid when your code named the URL", async () => {
  const h = makeClient({ allowHosts: ["api.trusted.example"], resourceUrl: (ctx) => ctx.paymentRequired.resource.url }, NEWHOLD);
  await h.client.createPaymentPayload(required([good], "https://api.trusted.example/x"));
  assert.deepEqual(h.signed, ["0xAAA"]);
});

test("hook: a payee alalanet allows is paid though it looks like one paid on that host", async () => {
  const PAYEE = "0x1234" + "5".repeat(32) + "abcd";
  const LOOK = "0x1234" + "d3ad".repeat(8) + "abcd";
  const { client, signed } = makeClient({}, () => ({ decision: "allow" }));
  await client.createPaymentPayload(required([{ ...good, payTo: PAYEE }], "https://a.example/x"));
  await client.createPaymentPayload(required([{ ...good, payTo: LOOK }], "https://a.example/y"));
  assert.deepEqual(signed, [PAYEE, LOOK]);
});

test("hook: quote_expired, and a reason alalanet dropped (price_differs_from_description, now unknown), are not paid under the default", async () => {
  const expired = makeClient({}, () => ({ decision: "block", reasons: ["quote_expired", "unknown_service"] }));
  await assert.rejects(expired.client.createPaymentPayload(required([good])), /x402-guard blocked: .*quote_expired/);
  const described = makeClient({}, () => ({ decision: "hold", reasons: ["unknown_service", "price_differs_from_description"] }));
  await assert.rejects(described.client.createPaymentPayload(required([good])), /x402-guard held: .*price_differs_from_description/);
  assert.deepEqual([...expired.signed, ...described.signed], []);
});

// --- 2.0 round 3: review-1116 guard15 r2 probes, adopted -----------------------------------------

function twoNetClient(decide) {
  const signed = [];
  const client = new x402Client();
  for (const net of ["eip155:8453", "eip155:1"]) {
    client.register(net, { scheme: "exact", findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }), async createPaymentPayload(v, req) { signed.push(req.payTo); return { x402Version: v, payload: {} }; } });
  }
  const fetch = async (url, init) => {
    const pr = JSON.parse(JSON.parse(init.body).payment_required);
    const options = pr.accepts.map((a) => ({ network: "base", network_id: a.network, asset: a.asset, amount: a.amount, pay_to: a.payTo, usd: Number(a.amount) / 1e6, ...decide(a) }));
    return new Response(JSON.stringify({ decision: options[0].decision, options }), { status: 200 });
  };
  alalanetGuard(client, { fetch, detectClient: false });
  return { client, signed };
}

test("R2-A a second allowed payee is refused already_paid while the first payment is open; after it, it is paid", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const { client, signed } = twoNetClient(() => ({ decision: "allow" }));
  const R = "https://listed.example/r";
  await client.createPaymentPayload(required([good], R));
  await assert.rejects(client.createPaymentPayload(required([{ ...good, network: "eip155:1", payTo: "0xBBB" }], R)), /already_paid/);
  await assert.rejects(client.createPaymentPayload(required([good], R)), /already_paid/);
  t.mock.timers.tick(60_000);
  await client.createPaymentPayload(required([{ ...good, network: "eip155:1", payTo: "0xBBB" }], R)); // window closed, alalanet vouches
  assert.deepEqual(signed, ["0xAAA", "0xBBB"]);
});

test("R2-D the hook learns payees only from payments alalanet allowed: a look-alike paid as new cannot lock out the honest payee", async () => {
  const HONEST = "0x1234" + "5".repeat(32) + "abcd";
  const GROUND = "0x1234" + "e".repeat(32) + "abcd";
  const { client, signed } = makeClient({}, NEWHOLD);
  await client.createPaymentPayload(required([{ ...good, payTo: GROUND }], "https://honest.example/x"));
  await client.createPaymentPayload(required([{ ...good, payTo: HONEST }], "https://honest.example/y"));
  assert.deepEqual(signed, [GROUND, HONEST]);
});

test("R2-E the expectPayTo exception pays only the pinned payee; a resourceUrl string does not lift the scope rule", async () => {
  const pinned = makeClient({ allowHosts: ["api.trusted.example"], expectPayTo: { "api.trusted.example": "0xAAA" } }, NEWHOLD);
  await assert.rejects(pinned.client.createPaymentPayload(required([{ ...good, payTo: "0xEVIL" }], "https://api.trusted.example/x")), /pay_to_unexpected/);
  await pinned.client.createPaymentPayload(required([good], "https://api.trusted.example/x"));
  assert.deepEqual(pinned.signed, ["0xAAA"]);
  const str = makeClient({ allowHosts: ["api.trusted.example"], resourceUrl: "https://api.trusted.example/" }, NEWHOLD);
  await assert.rejects(str.client.createPaymentPayload(required([{ ...good, payTo: "0xEVIL" }], "https://api.trusted.example/x")), /held/);
});

test("hook: a decision already past its expiry is asked again once, then refused decision_expired", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const make = (stale) => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push(1);
      const pr = JSON.parse(JSON.parse(init.body).payment_required);
      const options = pr.accepts.map((a) => ({ network: "base", network_id: a.network, asset: a.asset, amount: a.amount, pay_to: a.payTo, usd: 0.002, decision: "allow" }));
      const expires = calls.length <= stale ? Date.now() - 1000 : Date.now() + 60_000;
      return new Response(JSON.stringify({ decision: "allow", options, expires_at: new Date(expires).toISOString() }), { status: 200, headers: { date: new Date().toUTCString() } });
    };
    const signed = [];
    const client = new x402Client();
    client.register("eip155:8453", { scheme: "exact", findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }), async createPaymentPayload(v, req) { signed.push(req.payTo); return { x402Version: v, payload: {} }; } });
    alalanetGuard(client, { fetch, detectClient: false });
    return { client, signed, calls };
  };
  const once = make(1);
  await once.client.createPaymentPayload(required([good]));
  assert.deepEqual([once.signed.length, once.calls.length], [1, 2]);
  const twice = make(2);
  await assert.rejects(twice.client.createPaymentPayload(required([good])), /x402-guard decision_expired/);
  assert.deepEqual([twice.signed.length, twice.calls.length], [0, 2]);
});

test("R5-F hook: a decision expired on arrival whose re-ask fails is refused decision_expired, failOpen or not", async () => {
  for (const failOpen of [true, false]) {
    let n = 0;
    const fetch = async (url, init) => {
      if (++n === 2) throw new Error("ECONNREFUSED");
      const pr = JSON.parse(JSON.parse(init.body).payment_required);
      const options = pr.accepts.map((a) => ({ network: "base", network_id: a.network, asset: a.asset, amount: a.amount, pay_to: a.payTo, usd: 0.002, decision: "block", reasons: ["pay_to_sanctioned"] }));
      return new Response(JSON.stringify({ decision: "block", options, expires_at: new Date(Date.now() - 1000).toISOString() }), { status: 200 });
    };
    const signed = [];
    const client = new x402Client();
    client.register("eip155:8453", { scheme: "exact", findDefaultAsset: () => ({ asset: USDC, decimals: 6, symbol: "USDC" }), async createPaymentPayload(v, req) { signed.push(req); return { x402Version: v, payload: {} }; } });
    alalanetGuard(client, { fetch, detectClient: false, failOpen });
    await assert.rejects(client.createPaymentPayload(required([good])), /x402-guard decision_expired/, `failOpen ${failOpen}`);
    assert.deepEqual([signed.length, n], [0, 2]);
  }
});

test("hook: listing_removed is never paid as new", async () => {
  const { client, signed } = makeClient({}, () => ({ decision: "hold", reasons: ["unknown_service", "listing_removed"] }));
  await assert.rejects(client.createPaymentPayload(required([good])), /x402-guard held: .*listing_removed/);
  assert.deepEqual(signed, []);
});
