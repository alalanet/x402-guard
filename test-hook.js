import { test } from "node:test";
import assert from "node:assert/strict";
import { x402Client } from "@x402/core/client";
import { alalanetGuard } from "./index.js";

// The real x402 client from @x402/core with a stand-in scheme: it records whether a payment was
// signed, so a test sees that a refused payment never reached the signer.
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const good = { scheme: "exact", network: "eip155:8453", amount: "2000", asset: USDC, payTo: "0xAAA", maxTimeoutSeconds: 60, extra: {} };
const evil = { ...good, payTo: "0xEVIL" };
const required = (accepts, url = "https://shop.example/paid") => ({ x402Version: 2, resource: { url, description: "d", mimeType: "application/json" }, accepts });

function makeClient(guardOpts, decide, alalanetDown = false, reverse = false) {
  const signed = [];
  const calls = [];
  const client = new x402Client();
  client.register("eip155:8453", {
    scheme: "exact",
    findDefaultAsset: (asset) => (asset.toLowerCase() === USDC.toLowerCase() ? { asset: USDC, decimals: 6, symbol: "USDC" } : undefined),
    async createPaymentPayload(version, req) {
      signed.push(req.payTo);
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
  return { client, signed, calls };
}
const settle = (client, req, success = true) =>
  client.handlePaymentResponse({ paymentPayload: { x402Version: 2, payload: {} }, requirements: req, settleResponse: { success, transaction: "0xtx", network: req.network } });

test("a blocked payment is refused before it is signed", async () => {
  const { client, signed, calls } = makeClient({}, () => ({ decision: "block", reasons: ["sanctioned_pay_to"] }));
  await assert.rejects(client.createPaymentPayload(required([good])), /Payment creation aborted: x402-guard blocked: .*sanctioned_pay_to/);
  assert.deepEqual(signed, []);
  assert.equal(calls[0].body.url, "https://shop.example/paid");
  assert.equal(calls[0].ua, "x402-guard/1.4 (hook)");
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
  await client.createPaymentPayload(required([good])); // 0.002, in flight
  await client.createPaymentPayload(required([good])); // 0.002, in flight: 0.004
  assert.equal(calls[1].body.max_usd, 0.003);
  await assert.rejects(client.createPaymentPayload(required([good])), /x402-guard over_budget/); // 0.006 > 0.005
  await settle(client, good, false); // the seller says it did not settle: its word frees nothing
  await assert.rejects(client.createPaymentPayload(required([good])), /over_budget/);
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
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => client.createPaymentPayload(required([good]))));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(signed.length, 2);
});

test("a payment without a payment response (x402 v1, a lost answer, no header) stays counted", async () => {
  const { client, signed } = makeClient({ maxUsdPerDay: 0.005 }, () => ({ decision: "allow" }));
  await client.createPaymentPayload(required([good]));
  await client.createPaymentPayload(required([good]));
  // no settle reported for either: both count, the day is spent
  await assert.rejects(client.createPaymentPayload(required([good])), /over_budget/);
  // a 2xx without PAYMENT-RESPONSE: handlePaymentResponse with no settleResponse keeps it counted
  await client.handlePaymentResponse({ paymentPayload: { x402Version: 2, payload: {} }, requirements: good });
  await assert.rejects(client.createPaymentPayload(required([good])), /over_budget/);
  assert.equal(signed.length, 2);
});

test("a seller's refusal frees nothing: an allowed seller cannot drain the budget by claiming failure", async () => {
  const { client, signed } = makeClient({ maxUsdPerDay: 0.005 }, () => ({ decision: "allow" }));
  for (let i = 0; i < 10; i++) {
    try {
      await client.createPaymentPayload(required([good]));
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
  await client.createPaymentPayload(required([good]));
  await client.createPaymentPayload(required([good]));
  await assert.rejects(client.createPaymentPayload(required([good])), /over_budget/);
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
  const results = await Promise.allSettled([1, 2, 3].map(() => client.createPaymentPayload(required([good]))));
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
  await assert.rejects(client.createPaymentPayload(pr), /signer failed/); // unchecked (failOpen) and failed: frees nothing real
  down = false;
  await client.createPaymentPayload(pr); // counted 0.004
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
  url = "https://shop.example/paid";
  await client.createPaymentPayload(pr); // 0.004
  await assert.rejects(client.createPaymentPayload(pr), /over_budget/);
});
