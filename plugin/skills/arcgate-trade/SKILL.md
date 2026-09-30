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
| `POST /trade/v1/swap` | Turn a `quoteId` into unsigned transactions | 0.01 to 5, by size, once per quote |
| `POST /trade/v1/swap/tx` | Turn a signed Permit2 permit into final transactions | free |
| `POST /trade/v1/receipt` | Confirm the sent swap: delivered against `minAmountOut`, pass or fail | free |
| `GET /trade/v1/venues`, `GET /health` | Venues; service status | free |

The same operations are MCP tools on `POST /trade/v1/mcp`: `tradeSearch`, `tradeQuote`,
`tradeSwap`, `tradeSwapTx`, `tradeReceipt`, `tradeVenues`, `health`, with the same inputs and prices.

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
node scripts/arcgate.mjs quote '{"sell":"0x3600000000000000000000000000000000000000","buy":"0x…","amount":"100","taker":"0x…"}'
node scripts/arcgate.mjs swap '{"quoteId":"q_…","taker":"0x…","approval":"approve"}'
node scripts/arcgate.mjs swap-tx '{"quoteId":"q_…","taker":"0x…","permit":{"message":…,"signature":"0x…"}}'
```

It prints one JSON object: `{ "status", "body", "payment" }`, where `payment` is the settlement
receipt of a paid call. It exits non-zero when `status` is 400 or above.
`API_URL` points it at another deployment.

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
`slippageBps` (default 100). Pass `taker` too: the wallet that will swap. Leave `venues` out: it
searches every venue.

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

With `taker`, the answer also has `readiness`, checked at the quote's block. Read it before paying
for a swap:

- Tell the user `readiness.totalCostUsdc`: the swap fee plus gas, what finishing will cost.
- If `readiness.ready` is `false` (the quote's `next` is then `stop`), stop and say what is short:
  `balance` (not enough of the sell token), `gas` (not enough native USDC for gas) or `fees` (the
  paying wallet can't cover the swap fee).
- `readiness.approval.needs` says what the default Permit2 swap will ask for first: `none`,
  `approve`, `sign_permit`, `approve_and_sign_permit`, or `native` (nothing).

## 5. Swap within two minutes

A `quoteId` lives 120 seconds (`ttlSec`). After that `swap` answers `410 quote_expired` (see the end
of this section).

`swap` takes `{ "quoteId", "taker", "approval": "approve" }`:

- **`taker`** is the wallet that will sign and send the transactions. It must hold the sell token,
  plus a little native USDC for gas (native USDC is Arc's gas token), or the answer is
  `422 insufficient_balance`. It isn't necessarily the wallet that pays arcgate's fee; when it is,
  it also needs the swap fee on top, since the fee comes out of the same USDC.
- **`recipient`** (optional) receives the bought tokens; it defaults to `taker`.
- **`approval: "approve"`** is always one call: at most one exact-amount ERC-20 approve, then the
  swap. The default, `"permit2"`, can instead return a permit for the taker to sign
  (`signatures[0].typedData`). After signing it, run `swap-tx` (`POST /trade/v1/swap/tx`) with the same
  `quoteId`, `taker` and `recipient`, plus `permit: { message, signature }` (`message` is
  `typedData.message`), before the quote's 120 seconds run out. That call is free: the /swap call
  paid the swap fee. Use `"approve"` when the taker's wallet can't sign typed data.

The answer's `transactions[]` are unsigned, for Arc mainnet (chain 5042), in order: an approve if
needed, then the swap through arcgate's router. The user's wallet signs and sends each, in order,
waiting for each to confirm. Show the user what they're about to sign.

`swap` re-quotes and re-simulates at the current block, so a price that moved fails loudly
(`409 quote_stale`) instead of executing worse.

On `409 quote_stale` or `410 quote_expired`:

- **The body has `quote`:** a free new quote for the same trade, not executed. Read its price,
  `safety.verdict` and `readiness` as in section 4, tell the user the new price, and swap its
  `quoteId` if they still want it. There is one per paid quote.
- **`next` is `stop`:** a new quote for the trade came back untradeable: no route or not enough
  liquidity, a `cannot_sell` or `illiquid` verdict, a route that can't be executed, or a taker that
  can't finish it. `error.hint` says which. Tell the user the trade can't be done now, and why.
- **No `quote`, `next` is `requote`:** quote again yourself. (That includes a server error while
  arcgate re-quoted: it doesn't mean the trade is impossible.)

## 6. Confirm the fill

Once the user's wallet has sent the transactions, call `receipt` (free) with the `quoteId` and
every transaction hash it sent:

```bash
node scripts/arcgate.mjs receipt '{"quoteId":"q_…","txHashes":["0x…","0x…"]}'
```

- **`pass`**: tell the user what they got: `delivered` of `token`, in base units (divide by
  10^`buy.decimals` from the quote).
- **`fail`**: follow `next`. `requote`: nothing filled (the swap reverted or was never mined);
  quote again if the user still wants the trade. `stop`: a swap for this quote did fill (it
  delivered less than `minAmountOut`, or it filled in a transaction you didn't list); tell the user
  `reason` and don't trade again.
- **`pending`**: a transaction isn't mined yet. Wait a few seconds and ask again.
- **A smart-contract wallet** (a Safe, an ERC-4337 account, or an EIP-7702 wallet that batches):
  `receipt` only reads transactions the taker sends itself, so it answers `invalid_request` for
  these. Check the transaction's own receipt, and the wallet's success event, instead.

It answers for an hour after the `swap` call (`404 swap_not_found` after that), and only for that
swap's own transactions.

## 7. Errors: act on `next`

Every error body has `next` beside `error`: do what `next` says; `code` says why. One exception:
a `quote_stale` or `quote_expired` whose free new quote can't be traded says `stop`, not `requote`
(section 5). Over MCP the tool result's `structuredContent` is the same body, except two results
`@x402/mcp` writes itself, which have no `next`: the payment-required one, and a text-only
`Internal Server Error` when the payment facilitator fails mid-call. A 200 carries `next` when it
needs an action: `sign_permit` on a `swap` answer with a permit to sign, `stop` on a quote whose
verdict is `cannot_sell` or `illiquid`, whose `best.executable` is `false`, or whose
`readiness.ready` is `false`, and on a `receipt`, `retry` while `pending` and, after a `fail`,
`requote` when nothing filled or `stop` when a swap did.

| `next` | Codes | What you do |
| --- | --- | --- |
| `requote` | `quote_not_found`, `quote_stale`, `quote_expired`, `swap_attempts_exhausted` | Swap the free new quote in `quote` if the body has one and the user accepts its price (section 5); otherwise quote again, then swap the new `quoteId`. `swap_attempts_exhausted` means the failed attempts are used up (5 per quote on `swap`, 5 per permit round on `swap-tx`): that call won't run again |
| `retry` | `rpc_unavailable`, `lookup_rate_limited`, `receipt_rate_limited`, `payment_unavailable` | Send the same request again, after `retryAfterSec` seconds when the body has it |
| `fix_request` | `invalid_request`, `ticker_not_allowed`, `invalid_amount`, `unsupported_pair`, `unknown_venue`, `unknown_source`, `taker_required`, `token_not_found`, `payload_too_large`, `no_pending_swap` | The request is wrong (a ticker instead of an address, the amount, a venue): fix it, then send it. For `no_pending_swap`, no permit round is open for that quote, taker and recipient: call paid `/swap` first (or use the same taker and recipient); a round is used once. |
| `stop` | `no_route`, `insufficient_liquidity`, `unsupported_venue`, `buy_reverts`, `insufficient_balance`, `swap_reverts`, `cannot_sell`, `not_executable`, `swap_not_found`, `receipt_reads_exhausted`, `internal`, `client_closed` | Don't retry; tell the user why (`error.message`) |
| `pay` | `payment_required` | Pay the 402; the script does it |
| `sign_permit` | - | Have the taker sign `signatures[0].typedData`, then call `POST /trade/v1/swap/tx` with `permit` (section 5) |

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
5. Swap within 120s with a `taker` that holds the funds. With Permit2, send the signed permit in
   a free `/swap/tx` call. On a `409`/`410`, offer the free new `quote` at its price; on
   `next: stop`, stop.
6. The user's wallet signs and sends the transactions, in order.
7. Confirm with `receipt` (free): pass, tell the user what they got; fail, follow `next`
   (`requote`: nothing filled; `stop`: a swap filled, so tell them `reason` and don't trade again);
   pending, wait and ask again.
