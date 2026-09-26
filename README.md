# Maker Arena

**An onchain propAMM league on Monad where anyone can quote every block.**

Built solo at Monad Blitz İstanbul (26 Sep 2026).

- Live app: https://mrvipek259-ui.github.io/maker-arena/
- Contract (Monad testnet): [`0x14e5cCC449B703863D09A5f081130285196Df784`](https://testnet.monadvision.com/address/0x14e5cCC449B703863D09A5f081130285196Df784) (verified, Sourcify exact match)
- Demo video: VIDEO_URL

## The idea

On Monad, most DEX volume goes through venues where a maker sets the price every block: Kuru's CLOB has ~66% of 30-day DEX volume, and propAMMs like Hanji, Metric and LFJ POE did roughly $400M in the same period ([DefiLlama](https://defillama.com/chain/monad)). Only a handful of professional teams play this game.

Maker Arena opens it to everyone and makes the core mechanic of propAMM market making, **the stale-quote race**, playable and visible:

1. A maker quotes a two-sided market (spread + size). The quote is anchored to the oracle price **at the moment of the maker's last refresh**.
2. The oracle moves. The quote is now stale.
3. The race starts: the maker calls `refresh()`, and arbitrageurs call `hit()` on the stale quote. Whichever transaction the chain orders first wins.
4. A hit carries a limit price. If the maker refreshed first, the hit does **not** revert. It emits `Miss`, so lost races are recorded onchain too.
5. Quotes live 100 blocks (~30 s). Makers have to keep refreshing.

The **race board** reconstructs every race from onchain events alone: the block where the quote went stale, the block and transaction index of the hit, and the latency in blocks and ms.

## Why this only works this way on Monad

| Monad property | What it does for the game |
|---|---|
| 300 ms blocks, 600 ms finality ([docs](https://docs.monad.xyz/developer-essentials/summary)) | Races resolve within a few blocks. Reaction time in blocks becomes the game itself. |
| No global mempool; RPC forwards txs to the next leaders ([docs](https://docs.monad.xyz/monad-arch/consensus/local-mempool)) | No one can watch a pending `refresh()` and jump in front of it. Block order decides the race. |
| Gas is charged on the **gas limit** ([docs](https://docs.monad.xyz/developer-essentials/gas-pricing)) | Every call uses a measured, fixed gas limit (`pushPrice` 60k, `refresh` 80k, `hit` 110k), never an estimate. |
| Reserve balance (10 MON) ([docs](https://docs.monad.xyz/developer-essentials/reserve-balance)) | Player transactions never send value, so small, freshly funded accounts can play without reverting on reserve rules. The faucet account keeps itself above 10.5 MON. |
| Newly funded accounts wait ~3 blocks before sending | The onboarding flow waits before the first `register()`. |
| Mera passkey accounts ([docs](https://docs.monad.xyz/guides/mera)) | Face ID / Touch ID login, plain EOAs, and transactions are signed locally, so there is no wallet popup per refresh or hit. |

## Architecture

```
Browser (Mera passkey or guest key) ── signed tx ──▶ Monad testnet: Arena.sol
     ▲  getLogs polling straight from the RPC ◀──────────┘
     └── POST /fund (0.25 MON)          ┌─ server/index.mjs (one file)
                                         ├ keeper: Binance BTC/USDT → pushPrice every block while someone is watching
                                         ├ 4 bot makers (8/15/30/60 bps, 0.4 s → 6 s reflexes)
                                         ├ 1 bot arbitrageur (0.6 s delay, so humans can win races)
                                         └ /fund, /presence, /health
```

- `contracts/`: `Arena.sol` + Foundry tests (`forge test`, Monad execution network enabled in `foundry.toml`).
- `server/`: keeper, bots, faucet. Node 22+, only depends on `viem`.
- `web/`: Vite + React + viem + `@category-labs/mera`. No indexer, no backend reads.

### Honest notes

- **Balances are virtual** (vUSD / vBTC inside the contract). This keeps onboarding to seconds on testnet; the mechanism is unchanged with real tokens.
- **Price source:** Binance BTC/USDT mid (Bybit fallback), the same kind of CEX reference mpamm.wtf benchmarks against. Moves are amplified 50× so races happen within a short demo. Pyth Hermes now requires an API key, and the testnet Pyth price was ~45 h stale, so for mainnet the plan is Pyth pull updates or Chainlink Data Streams, with the update fee paid by the contract (a user sending the fee as `value` from a < 10 MON account could revert under reserve-balance rules).
- **Bots:** 4 maker bots and 1 arbitrage bot keep the arena alive when few humans are online. They play by the same rules as everyone else.

## Run it

```bash
# contracts
cd contracts && forge test
forge create src/Arena.sol:Arena --rpc-url $RPC_URL --private-key $OPS_PK --broadcast --constructor-args $OPS_ADDRESS

# server (reads ../.env: RPC_URL, OPS_PK, ARENA_ADDRESS)
cd server && npm install && npm start

# web
cd web && npm install
VITE_ARENA_ADDRESS=0x... VITE_SERVER_URL=http://localhost:8787 npm run dev
```

## Onchain proof

First ~8 minutes on testnet (1,500 blocks): 57 price pushes, 69 quotes/refreshes, 6 players, **5 won races (`Fill`) and 2 lost races (`Miss`)**. Recount any time with `python3 scripts/count_events.py 1500`.

| Event | Example tx |
|---|---|
| `Fill`: stale quote hit, race won by the taker | [0x16bd…12ac](https://testnet.monadvision.com/tx/0x16bd2b1bbe01e4bdf06de662b376029d4744d93052bb8c34c823eb3f4ece12ac) |
| `Miss`: maker refreshed first, race lost by the taker (recorded, not reverted) | [0xae9d…c532](https://testnet.monadvision.com/tx/0xae9def1b9e56cd10602ae8a703f36797febe254631f47b813e62eb48b881c532) |
| `Quote`: maker refresh | [0xd6f8…f7ba](https://testnet.monadvision.com/tx/0xd6f8b250a3ea4cc279c61c6b89b0a3f6709bff102c6b844fa9de59699a43f7ba) |
| `Price`: keeper push | [0xe7ee…7372](https://testnet.monadvision.com/tx/0xe7ee5ddccc66a83c57714016033025be5ff09a36c08b6983458d239ac4e97372) |
| `Registered`: guest player joined from the live site | [0xa351…bbb6](https://testnet.monadvision.com/tx/0xa3513b093d21136db457afe333bafc023b530ec7ef0f73d2f122e2a85b60bbb6) |

A race from the live race board: quote went stale at block 65809837, the arbitrage hit landed at block 65809840 (tx index 1): **3 blocks ≈ 900 ms**.

**Gas-limit charging, observed:** a `pushPrice` sent with `gasLimit = 100,000` shows `gasUsed = 100,000` in its receipt, although `eth_estimateGas` returns ~35,600 for a warm push. That is why every call here uses a measured, fixed limit (keeper `pushPrice` runs at 45k).

## What's next (Metropolis, Onchain Finance & Trading)

- Mainnet deploy with real assets and a pull oracle.
- Maker vaults: LPs allocate capital to the makers with the best onchain track record.
- A venue adapter for [mpamm.wtf](https://github.com/haythemsellami/mpamm.wtf) and a capability package for [moss](https://github.com/nishuzumi/moss) (MOST pool repos).
