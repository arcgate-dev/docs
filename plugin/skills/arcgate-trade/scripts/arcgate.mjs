#!/usr/bin/env node
// arcgate trade API from an agent: one call per run, paying x402 with the wallet in PRIVATE_KEY.
//
//   node arcgate.mjs <search|quote|swap|swap-tx|receipt|venues|health> ['<json body>']
//
// Env:
//   PRIVATE_KEY          the wallet that pays the fee, holding USDC on Arc (search, quote, swap)
//   ARCGATE_MAX_PAYMENT  largest single payment allowed, in USDC (default 0.05)
//   API_URL              default https://api.arcgate.dev
//
// Prints one JSON object, { status, body, payment }, where payment is the settlement receipt of a
// paid call. Exits 1 when status is 400 or above, 2 on a usage error.
import { pathToFileURL } from "node:url";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const OPERATIONS = {
  search: { method: "POST", path: "/trade/v1/search", paid: true },
  quote: { method: "POST", path: "/trade/v1/quote", paid: true },
  swap: { method: "POST", path: "/trade/v1/swap", paid: true },
  "swap-tx": { method: "POST", path: "/trade/v1/swap/tx", paid: false },
  receipt: { method: "POST", path: "/trade/v1/receipt", paid: false },
  venues: { method: "GET", path: "/trade/v1/venues", paid: false },
  health: { method: "GET", path: "/health", paid: false },
};

const USDC = "0x3600000000000000000000000000000000000000";
// Arc mainnet (what production charges on) and Arc testnet (local development stacks).
const FEE_NETWORKS = ["eip155:5042", "eip155:5042002"];

/** fetch that pays x402 with `signer`, in Arc USDC only, never more than `maxAmount` base units
 * per payment (Arc USDC isn't one of x402's built-in assets, so it has to be allowed here). */
export function payingFetch(signer, maxAmount) {
  const client = x402Client.fromConfig({
    schemes: FEE_NETWORKS.map((network) => ({ network, client: new ExactEvmScheme(signer) })),
    spendControls: {
      allowedAssets: FEE_NETWORKS.map((network) => ({ network, asset: USDC, maxAmountPerPayment: String(maxAmount) })),
    },
  });
  return wrapFetchWithPayment(fetch, client);
}

/** One call to the API. `fetchFn` is plain fetch for free operations, payingFetch for paid ones. */
export async function call({ fetchFn, apiUrl, operation, body }) {
  const op = OPERATIONS[operation];
  const init = op.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) } : { method: "GET" };
  const res = await fetchFn(`${apiUrl}${op.path}`, init);
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  // A 402 that survives a paid call means the payment was refused (e.g. the wallet has too little
  // USDC); its body is empty and the reason is in PAYMENT-REQUIRED.
  const required = res.status === 402 ? res.headers.get("payment-required") : null;
  if (required) parsed = decodePaymentRequiredHeader(required);
  const receipt = res.headers.get("payment-response");
  return { status: res.status, body: parsed, payment: receipt ? decodePaymentResponseHeader(receipt) : null };
}

async function main(argv, env) {
  const [operation, bodyArg] = argv;
  const op = OPERATIONS[operation];
  if (!op) {
    console.error(`usage: node arcgate.mjs <${Object.keys(OPERATIONS).join("|")}> ['<json body>']`);
    return 2;
  }
  let body;
  if (op.method === "POST") {
    try {
      body = JSON.parse(bodyArg ?? "");
    } catch {
      console.error(`${operation} needs a JSON body, e.g. node arcgate.mjs search '{"query":"USDC"}'`);
      return 2;
    }
  }
  let fetchFn = fetch;
  if (op.paid) {
    const key = env.PRIVATE_KEY?.trim();
    if (!key) {
      console.error(`${operation} is paid in USDC over x402: set PRIVATE_KEY to a wallet holding USDC on Arc.`);
      return 2;
    }
    fetchFn = payingFetch(privateKeyToAccount(key), parseUnits(env.ARCGATE_MAX_PAYMENT?.trim() || "0.05", 6));
  }
  const apiUrl = (env.API_URL?.trim() || "https://api.arcgate.dev").replace(/\/+$/, "");
  try {
    const result = await call({ fetchFn, apiUrl, operation, body });
    console.log(JSON.stringify(result, null, 2));
    return result.status >= 400 ? 1 : 0;
  } catch (err) {
    // e.g. the price is above ARCGATE_MAX_PAYMENT, or the wallet can't pay: nothing was charged.
    console.log(JSON.stringify({ status: null, error: err instanceof Error ? err.message : String(err) }, null, 2));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
