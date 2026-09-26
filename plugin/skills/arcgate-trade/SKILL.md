---
name: arcgate-trade
description: Use when an agent needs to turn a plain-English crypto order on Arc ("buy 100 USDC of X", "sell my MOLLY for USDC") into a checked trade through the arcgate API - resolve the token, quote it, read the safety verdict, and get unsigned transactions for the user's wallet. Every search, quote and swap is paid per call in real USDC over x402; includes a script that makes those paid calls with a wallet key.
---

# arcgate trade: from an order to signed transactions

arcgate is a checkpoint between an agent and the DEXes on Arc. It finds the token the user meant,
prices the trade across the indexed venues, simulates a buy and sell-back to catch taxes and
honeypots, and returns **unsigned** transactions. It never holds funds and never signs: the user's
own wallet signs and sends.

API: `https://api.arcgate.dev`. Reference: https://docs.arcgate.dev

| Call | What it does | USDC per call |
| --- | --- | --- |
| `POST /trade/v1/search` | Resolve a ticker, name or address to tokens | 0.005 |
| `POST /trade/v1/quote` | Price a trade, returns a `quoteId` | 0.01 |
| `POST /trade/v1/swap` | Turn a `quoteId` into unsigned transactions | 0.01 to 5, by size |
| `GET /trade/v1/venues`, `GET /health` | Venues; service status | free |

The same operations are MCP tools on `POST /trade/v1/mcp`: `tradeSearch`, `tradeQuote`,
`tradeSwap`, `tradeVenues`, `health`, with the same inputs and prices.

## 1. Paying: read this before the first paid call

Search, quote and swap cost **real USDC on Arc mainnet**, paid per call with
[x402](https://x402.org). An agent can only make those calls if it can run code and has a wallet
key to pay with.

- **Can run code (Claude Code and similar):** use `scripts/arcgate.mjs` from this skill. Once:
  `npm install --prefix <this skill's directory>/scripts`. It needs `PRIVATE_KEY` (a wallet holding
  USDC on Arc) in the environment. It refuses any single payment above `ARCGATE_MAX_PAYMENT`
  (USDC, default `0.05`, enough for search, quote and a swap under $10,000). Never ask the user to
  paste a private key into the conversation; they set it in the environment.
- **Can't run code:** the free calls still work, and the rest of this skill still helps plan the
  trade. Tell the user the paid calls need an x402-capable client, and point them at the docs.

Tell the user what a call will cost before the first paid call. A call that ends in an error is
never charged.

```bash
node scripts/arcgate.mjs health
node scripts/arcgate.mjs search '{"query":"MOLLY"}'
node scripts/arcgate.mjs quote '{"sell":"0x3600000000000000000000000000000000000000","buy":"0x…","amount":"100"}'
node scripts/arcgate.mjs swap '{"quoteId":"q_…","taker":"0x…","approval":"approve"}'
```

It prints one JSON object: `{ "status", "body", "payment" }`, where `payment` is the settlement
receipt of a paid call. It exits non-zero when `status` is 400 or above.
`ARCGATE_API_URL` points it at another deployment.

## 2. Settle the direction before anything else

`side` is `exactIn` (the amount is on the `sell` side: exactly that much is spent) or `exactOut`
(the amount is on the `buy` side: exactly that much is received, at whatever it costs). Say which
reading you used.

- **"spend N USDC on X"**, **"buy N USDC of/worth of X"**: exactIn, sell USDC, buy X, amount N.
- **"buy N X"**, **"get N X"**: exactOut, sell USDC, buy X, amount N.
- **"sell N X"**: exactIn, sell X, buy USDC, amount N.
- **"sell X for N USDC"**: exactOut, sell X, buy USDC, amount N.

**"N of X"**, with nothing saying whether N is USDC or units of X: stop and ask. The two readings
can differ by orders of magnitude.

`amount` is a decimal string in whole-token units: `"100"` is 100 USDC, `"0.5"` is half a token.
Never base units.

## 3. A ticker is never enough: resolve it first

Anyone can deploy a token called USDC. Never pass a ticker to quote (it answers
`ticker_not_allowed`). Search first, then use an address:

1. `search` with `{ "query": "MOLLY" }`.
2. Read `results[]`: each has `address`, `verification` (`status`, `source`, `trust`) and `safety`.
   If `resolution` is `"ambiguous"`, or several results share the symbol, don't pick on your own
   unless one is the verified canonical token. Ask the user, or say which one you picked and why.
3. Put the chosen `address` in `sell` or `buy`.

USDC is `0x3600000000000000000000000000000000000000` (native and ERC-20 USDC are the same asset).

## 4. Quote, and read the safety verdict

`quote` takes `sell`, `buy`, `amount`, and optionally `side` (default `exactIn`) and
`slippageBps` (default 100). Leave `venues` out: it searches every venue.

The answer has a `quoteId`, the best route under `best` (expected output, `minAmountOut`, fees,
`executable`) and `safety.verdict`:

| Verdict | Meaning | What to do |
| --- | --- | --- |
| `ok`, `pinned` | Sells back normally; `pinned` is a fixed trusted asset (USDC, EURC, cirBTC) | Proceed |
| `taxed` | Buy/sell taxes (`buyTaxBps`, `sellTaxBps`, `roundTripLossBps`) | Tell the user the taxes and round-trip loss; proceed only if they accept |
| `size_limited` | A per-transaction cap (`maxBuyUsdc`) | Tell the user; trade at or below the cap |
| `illiquid` | Not enough liquidity to exit | Stop and tell the user |
| `cannot_sell` | Buying works, selling back doesn't (a honeypot) | Stop. Don't swap |
| `inconclusive` | Couldn't be measured | Tell the user it's unverified; don't proceed on your own |

If `best.executable` is `false`, the route can't be swapped: say so and stop.

## 5. Swap within two minutes

A `quoteId` lives 120 seconds (`ttlSec`). After that `swap` answers `410 quote_expired`: quote
again.

`swap` takes `{ "quoteId", "taker", "approval": "approve" }`:

- **`taker`** is the wallet that will sign and send the transactions. It must hold the sell token,
  plus a little native USDC for gas (native USDC is Arc's gas token), or the answer is
  `422 insufficient_balance`. It isn't necessarily the wallet that pays arcgate's fee.
- **`recipient`** (optional) receives the bought tokens; it defaults to `taker`.
- **`approval: "approve"`** is always one call: at most one exact-amount ERC-20 approve, then the
  swap. The default, `"permit2"`, can instead return a permit to sign and needs a second paid
  `swap` call with `permit: { message, signature }`. Prefer `"approve"`.

The answer's `transactions[]` are unsigned, for Arc mainnet (chain 5042), in order: an approve if
needed, then the swap through arcgate's router. The user's wallet signs and sends each, in order,
waiting for each to confirm. Show the user what they're about to sign.

`swap` re-quotes and re-simulates at the current block, so a price that moved fails loudly
(`409 quote_stale`) instead of executing worse: quote again.

## 6. Errors

| Status | Code | Next step |
| --- | --- | --- |
| 400 | `invalid_request`, `ticker_not_allowed` | Fix the request (addresses, not tickers) |
| 402 | - | Payment needed; the script pays it |
| 404 | `quote_not_found` | That `quoteId` was never issued here: quote again |
| 409 | `quote_stale` | Price moved: quote again |
| 410 | `quote_expired` | Older than 120s: quote again |
| 422 | `insufficient_balance`, `insufficient_liquidity`, `not_executable` | Tell the user |

## Worked examples

[examples.json](./examples.json) has one worked order per reading, each validated against the
real quote schema. "spend 100 USDC on MOLLY", after search resolves MOLLY:

```json
{ "sell": "0x3600000000000000000000000000000000000000", "buy": "0x816de78fabdd52922964647529e304a0c86489cd", "amount": "100", "side": "exactIn" }
```

## Checklist

1. Can you pay? If not, say so before starting. Tell the user the cost.
2. Settle exactIn vs exactOut; ask if the amount's currency is ambiguous.
3. Resolve every ticker with search; use addresses.
4. Quote; read `safety.verdict` and `best.executable`; stop on `cannot_sell` or `illiquid`.
5. Swap within 120s with `approval: "approve"` and a `taker` that holds the funds.
6. The user's wallet signs and sends the transactions, in order.
