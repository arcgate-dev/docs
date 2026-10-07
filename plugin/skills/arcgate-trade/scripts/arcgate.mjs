#!/usr/bin/env node
// arcgate API from an agent, trade and agent services: one call per run, paying x402 with the wallet
// in PRIVATE_KEY.
//
//   node arcgate.mjs <search|quote|swap|swap-tx|receipt|venues|health> ['<json body>']
//   node arcgate.mjs <boxCreate|boxTopUp|inboundCreate|watchCreate|webhookCreate|telegramCreate> ['<json body>']
//   node arcgate.mjs <boxStatus|boxMessageList|boxMessageFetch|boxMessageDelete|inboundList|inboundDelete|
//     inboundRotate|watchList|watchDelete|webhookList|webhookDelete|webhookRotate|webhookEnable|
//     telegramList|telegramDelete|telegramLink> ['<json arguments>']
//   node arcgate.mjs inboundPost '{"url":"…","secret":"…","body":{…}}'
//
// The agent calls are named by their MCP tool and made by the box PRIVATE_KEY's address: the creates are
// paid over x402, the others carry an AgentRequest signature made with the same key. The arguments are
// one JSON object: `id` or `seq` fill the path, and the rest is the request body (the query of
// boxMessageList). inboundPost posts to an inbound address's url, signed with that address's secret.
//
// Env:
//   PRIVATE_KEY          the wallet that pays the fee, holding USDC on Arc, and is the box (every call but
//                        health, venues, receipt, swap-tx and inboundPost)
//   ARCGATE_MAX_PAYMENT  largest single payment allowed, in USDC (default 0.05)
//   API_URL              default https://api.arcgate.dev
//
// Prints one JSON object, { status, body, payment }, where payment is the settlement receipt of a
// paid call. Exits 1 when status is 400 or above, 2 on a usage error.
import { createHmac, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { decodePaymentResponseHeader, wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { keccak256, parseUnits, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const OPERATIONS = {
  search: { method: "POST", path: "/trade/v1/search", paid: true },
  quote: { method: "POST", path: "/trade/v1/quote", paid: true },
  swap: { method: "POST", path: "/trade/v1/swap", paid: true },
  "swap-tx": { method: "POST", path: "/trade/v1/swap/tx", paid: false },
  receipt: { method: "POST", path: "/trade/v1/receipt", paid: false },
  venues: { method: "GET", path: "/trade/v1/venues", paid: false },
  health: { method: "GET", path: "/health", paid: false },
  // The agent's box (/agent/v1): one entry per MCP tool, `{address}` being the key's address.
  boxCreate: { method: "POST", path: "/agent/v1/{address}/box", paid: true },
  boxTopUp: { method: "POST", path: "/agent/v1/{address}/box/topup", paid: true },
  boxStatus: { method: "GET", path: "/agent/v1/{address}/box/status", paid: false },
  boxMessageList: { method: "GET", path: "/agent/v1/{address}/box/messages", paid: false },
  boxMessageFetch: { method: "GET", path: "/agent/v1/{address}/box/messages/{seq}", paid: false },
  boxMessageDelete: { method: "DELETE", path: "/agent/v1/{address}/box/messages/{seq}", paid: false },
  inboundCreate: { method: "POST", path: "/agent/v1/{address}/inbound", paid: true },
  inboundList: { method: "GET", path: "/agent/v1/{address}/inbound/list", paid: false },
  inboundDelete: { method: "DELETE", path: "/agent/v1/{address}/inbound/{id}", paid: false },
  inboundRotate: { method: "POST", path: "/agent/v1/{address}/inbound/{id}/rotate", paid: false },
  watchCreate: { method: "POST", path: "/agent/v1/{address}/watch", paid: true },
  watchList: { method: "GET", path: "/agent/v1/{address}/watch/list", paid: false },
  watchDelete: { method: "DELETE", path: "/agent/v1/{address}/watch/{id}", paid: false },
  webhookCreate: { method: "POST", path: "/agent/v1/{address}/webhook", paid: true },
  webhookList: { method: "GET", path: "/agent/v1/{address}/webhook/list", paid: false },
  webhookDelete: { method: "DELETE", path: "/agent/v1/{address}/webhook/{id}", paid: false },
  webhookRotate: { method: "POST", path: "/agent/v1/{address}/webhook/{id}/rotate", paid: false },
  webhookEnable: { method: "POST", path: "/agent/v1/{address}/webhook/{id}/enable", paid: false },
  telegramCreate: { method: "POST", path: "/agent/v1/{address}/telegram", paid: true },
  telegramList: { method: "GET", path: "/agent/v1/{address}/telegram/list", paid: false },
  telegramDelete: { method: "DELETE", path: "/agent/v1/{address}/telegram/{id}", paid: false },
  telegramLink: { method: "POST", path: "/agent/v1/{address}/telegram/{id}/link", paid: false },
  // A post to an inbound address's own url (the one inboundCreate answers with): not an arcgate route.
  inboundPost: { method: "POST", paid: false },
};

// The client side of packages/core's agent signing, copied because this folder is published on its own
// and cannot import @arcgate/core: AGENT_DOMAIN and AGENT_REQUEST_TYPES (agent/signing.ts), canonicalJson
// and agentBodyHash (canonicalJson.ts, agent/signing.ts), signedPath (agent/paths.ts) and inboundSignature
// (agent/inboundAuth.ts). skills/arcgate-trade/arcgate.test.ts pins each to core byte for byte.
const AGENT_DOMAIN = { name: "arcgate", version: "1" };
const AGENT_REQUEST_TYPES = {
  AgentRequest: [
    { name: "address", type: "address" },
    { name: "method", type: "string" },
    { name: "path", type: "string" },
    { name: "bodyHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "expiry", type: "uint64" },
  ],
};
// A signature is good for this long: the server accepts an expiry up to a few minutes ahead.
const SIGNATURE_TTL_SECONDS = 60;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const agentBodyHash = (body) => keccak256(body === undefined ? "0x" : toBytes(canonicalJson(body)));

/** The path a request is signed over: the template with the address lowercased and `{param}`s filled. */
const signedPath = (template, address, params) =>
  template.replace("{address}", address.toLowerCase()).replace(/\{(\w+)\}/g, (token, name) => params[name] ?? token);

const inboundSignature = (secret, timestamp, body) => createHmac("sha256", Buffer.from(secret, "utf8")).update(`${timestamp}.`).update(body).digest("hex");

/** Whether `operation` is made by the box: its path starts at the key's address. */
const isBoxCall = (operation) => OPERATIONS[operation].path?.includes("{address}") === true;

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

/** The request of one call: `{ url, init }`, ready for fetch. The agent calls are made by `account`'s
 * address, lowercased in the path (the payer of a create must be the box). A create sends `args`, less
 * the path's `id` or `seq`, as its JSON body. A free call sends no body and signs the request instead;
 * boxMessageList's cursor and limit are its query, and are the signed body. `now` is unix seconds. */
export async function buildRequest({ operation, args, account, apiUrl, now = Math.floor(Date.now() / 1000), nonce = `0x${randomBytes(32).toString("hex")}` }) {
  const op = OPERATIONS[operation];
  if (operation === "inboundPost") {
    const body = JSON.stringify(args.body);
    const headers = { "content-type": "application/json", "INBOUND-TIMESTAMP": String(now), "INBOUND-SIGNATURE": inboundSignature(args.secret, now, Buffer.from(body, "utf8")) };
    return { url: args.url, init: { method: "POST", headers, body } };
  }
  if (!isBoxCall(operation)) {
    const init = op.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args ?? {}) } : { method: "GET" };
    return { url: `${apiUrl}${op.path}`, init };
  }
  const { id, seq, ...rest } = args ?? {};
  const path = signedPath(op.path, account.address, { id, seq: seq === undefined ? undefined : String(seq) });
  if (op.paid) {
    return { url: `${apiUrl}${path}`, init: { method: op.method, headers: { "content-type": "application/json" }, body: JSON.stringify(rest) } };
  }
  // Only boxMessageList has a signed query, and the server signs just its cursor and limit, as numbers.
  // Any other free call signs no body, whatever else the arguments carry.
  const query = operation === "boxMessageList" ? Object.fromEntries(["cursor", "limit"].filter((k) => rest[k] !== undefined).map((k) => [k, Number(rest[k])])) : {};
  const body = Object.keys(query).length > 0 ? query : undefined;
  const expiry = now + SIGNATURE_TTL_SECONDS;
  const signature = await account.signTypedData({
    domain: AGENT_DOMAIN,
    types: AGENT_REQUEST_TYPES,
    primaryType: "AgentRequest",
    message: { address: account.address, method: op.method, path, bodyHash: agentBodyHash(body), nonce, expiry: BigInt(expiry) },
  });
  const search = body === undefined ? "" : `?${new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]))}`;
  return { url: `${apiUrl}${path}${search}`, init: { method: op.method, headers: { "AGENT-SIGNATURE": signature, "AGENT-NONCE": nonce, "AGENT-EXPIRY": String(expiry) } } };
}

/** One call to the API. `fetchFn` is plain fetch for free operations, payingFetch for paid ones. */
export async function call({ fetchFn, apiUrl, operation, body, account }) {
  const { url, init } = await buildRequest({ operation, args: body, account, apiUrl });
  const res = await fetchFn(url, init);
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
  // A POST to trade or an inbound address needs its JSON; an agent call may leave its arguments out.
  let body;
  if ((!isBoxCall(operation) && op.method === "POST") || (isBoxCall(operation) && bodyArg !== undefined)) {
    try {
      body = JSON.parse(bodyArg ?? "");
    } catch {
      console.error(`${operation} needs a JSON ${isBoxCall(operation) ? "argument" : "body"}, e.g. node arcgate.mjs search '{"query":"USDC"}'`);
      return 2;
    }
  }
  let fetchFn = fetch;
  let account;
  if (op.paid || isBoxCall(operation)) {
    const key = env.PRIVATE_KEY?.trim();
    if (!key) {
      console.error(`${operation} needs PRIVATE_KEY: ${op.paid ? "a wallet holding USDC on Arc, which pays in USDC over x402" : "the box's key, which signs the call"}.`);
      return 2;
    }
    account = privateKeyToAccount(key);
    if (op.paid) fetchFn = payingFetch(account, parseUnits(env.ARCGATE_MAX_PAYMENT?.trim() || "0.05", 6));
  }
  const apiUrl = (env.API_URL?.trim() || "https://api.arcgate.dev").replace(/\/+$/, "");
  try {
    const result = await call({ fetchFn, apiUrl, operation, body, account });
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
