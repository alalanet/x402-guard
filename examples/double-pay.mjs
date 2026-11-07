// Reproduces the double payment of a retried x402 call, and shows x402-guard preventing it.
// A local seller answers 402, then 502 on the first paid request (settled, answer lost); the caller
// retries. Nothing touches a chain: signatures are local EIP-712, the alalanet API is mocked.
//   npm i @x402/fetch @x402/evm viem @alalanet/x402-guard && node double-pay.mjs
// Result with @x402/fetch 2.30.0: alone = 2 distinct authorizations (paid twice); with the guard = 1.

import http from "node:http";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { guardFetch } from "@alalanet/x402-guard";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
function seller(failFirst) {
  const nonces = [];
  let paidCalls = 0;
  const srv = http.createServer((req, res) => {
    const sig = req.headers["payment-signature"];
    if (!sig) {
      const pr = { x402Version: 2, resource: { url: "http://127.0.0.1/paid" }, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: USDC, payTo: "0x000000000000000000000000000000000000dEaD", maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } }] };
      res.writeHead(402, { "PAYMENT-REQUIRED": b64(pr), "content-type": "application/json" });
      return res.end("{}");
    }
    const p = JSON.parse(Buffer.from(sig, "base64").toString());
    nonces.push(p.payload.authorization.nonce);
    paidCalls++;
    if (failFirst && paidCalls === 1) { res.writeHead(502); return res.end("facilitator timeout"); } // settled, answer lost
    res.writeHead(200, { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer: p.payload.authorization.from }) });
    res.end("data");
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}/paid`, nonces, close: () => srv.close() })));
}
const alalanet = async (url, init) => {
  if (String(url).includes("/v1/preflight")) {
    const body = JSON.parse(init.body);
    const pr = JSON.parse(Buffer.from(body.payment_required, "base64").toString());
    const options = pr.accepts.map((a) => ({ network: "base", asset: a.asset, amount: a.amount, pay_to: a.payTo, usd: 0.001, decision: "allow" }));
    return new Response(JSON.stringify({ decision: "allow", options, expires_at: "x" }));
  }
  throw new Error("unexpected call " + url);
};
const scheme = () => [{ network: "eip155:8453", client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }];

async function run(label, withGuard) {
  const s = await seller(true);
  const base = withGuard ? guardFetch(fetch, { fetch: alalanet, detectClient: false }) : fetch;
  const pay = wrapFetchWithPaymentFromConfig(base, { schemes: scheme() });
  const r1 = await pay(s.url).catch((e) => ({ status: "throw " + e.message.slice(0, 60) }));
  const r2 = await pay(s.url).catch((e) => ({ status: "throw " + e.message.slice(0, 60) })); // the caller retries
  console.log(label, "| responses:", r1.status, r2.status, "| paid requests:", s.nonces.length, "| distinct authorizations:", new Set(s.nonces).size);
  s.close();
}
await run("@x402/fetch alone      ", false);
await run("@x402/fetch + x402-guard", true);
