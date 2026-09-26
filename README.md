# 🛡️ Kalkan: Depeg Shield on Monad

**When a stablecoin depegs, Kalkan gets your position out in under a second, even if you are asleep.**

Built solo at Monad Blitz İstanbul (26 Sep 2026).

- Live app: https://mrvipek259-ui.github.io/kalkan/
- Contract (Monad testnet): [`0x7b1d3D9CBF45dcB7F175cBE9B18d00749f85E759`](https://testnet.monadvision.com/address/0x7b1d3D9CBF45dcB7F175cBE9B18d00749f85E759) (verified, Sourcify exact match)
- Demo video: VIDEO_URL

## The problem

In March 2023, USDC fell to $0.87. UST went to zero within days. In a depeg, the people who get out are the ones who happen to be watching and who can get a transaction in first. Everyone else rides it down. Stop-losses depend on a bot or server you have to trust. On Ethereum, the earliest your exit can land is the next 12-second block, behind everyone else in the public mempool.

## How Kalkan works

1. **Protect.** You open a position with a trigger: *"get me out if USDX falls below $0.99"*.
2. **Anyone can rescue you.** The moment the oracle price is below your trigger, **any account** can call `evacuate(id)`. Your position moves to the safe asset at the current price, and the rescuer earns a bounty.
3. **Rescuers race.** Many rescuers compete for bounties, so positions get out within a block or two. A rescuer who arrives late is not reverted: the attempt is recorded onchain as `Late`, so every race can be audited.
4. `evacuateMany(ids)` lets a rescuer clear a whole block's worth of positions in one transaction.

There is no keeper company to trust. The incentive does the work.

## Stress test: how many people can Monad get out, and how fast?

The **"Depeg simüle et"** button runs a stress test. It opens 120 labelled demo positions (triggers spread between $0.95 and $0.995), then moves the price down block by block from $1.00 to $0.87 and recovers. Three independent rescuer bots and any human rescuer race for the bounties.

A full run on Monad testnet (depeg started at block 65819148):

| Metric | Result |
|---|---|
| Positions evacuated | **150 / 150** (none left behind) |
| Trigger crossed → position evacuated | **avg 1.23 blocks (~370 ms)**, max 2 blocks |
| Most evacuations in a single block | **34** |
| Value saved vs riding the depeg to $0.87 | **$140,490** |
| Late rescuer attempts, recorded onchain | 1,026 |

One evacuation costs ~30k gas. With a 150M gas block, one Monad block has room for roughly **4,000 evacuations**. In our run, the bottleneck was our bots' batch size, not the chain.

## Why Monad

| Monad property | What it does for Kalkan |
|---|---|
| 300 ms blocks, 600 ms finality ([docs](https://docs.monad.xyz/developer-essentials/summary)) | An exit lands within 1–2 blocks of the trigger and is final in under a second. This is the scenario Port's *[What makes Monad different](https://portdeveloper.github.io/articles/what-makes-monad-different.html)* opens with. |
| No global mempool ([docs](https://docs.monad.xyz/monad-arch/consensus/local-mempool)) | No one can watch a pending rescue and jump ahead of it. Block order decides the race. |
| 150M gas blocks | Mass exits fit in a block (~4,000 evacuations by gas), so a panic does not become a queue. |
| Gas is charged on the **gas limit** ([docs](https://docs.monad.xyz/developer-essentials/gas-pricing)) | Every call uses a measured, fixed limit (`evacuateMany`: 70k + 36k per position). We also hit it for real: our first `pushPrice` limit covered warm writes but not the first write to a fresh slot, so it ran out of gas. |
| Reserve balance (10 MON) ([docs](https://docs.monad.xyz/developer-essentials/reserve-balance)) | User and rescuer transactions never send value. The faucet account keeps itself above 10.5 MON. Rescuer balances are sized for `gasLimit × maxFee`, which the RPC checks up front. |
| Mera passkey accounts ([docs](https://docs.monad.xyz/guides/mera)) | Face ID / Touch ID login, plain EOAs, and transactions are signed locally, with no wallet popup. |

## Architecture

```
Browser (Mera passkey or guest key) ── protect / evacuateMany ──▶ Shield.sol (Monad testnet)
   ▲  WebSocket logs (personal results)  ◀──────────────────────────────┘
   └── GET /status /mine, POST /scenario /fund ──▶ server/index.mjs (one file)
                                               ├ stress-test scenario: price path 1.00 → 0.87 → 1.00, one step per block
                                               ├ 2 rescuer bots (150 / 450 ms reflexes) racing for bounties
                                               ├ chain mirror → scenario stats (latency, per-block exits, value saved)
                                               └ faucet: 0.25 test MON for new users
```

- `contracts/`: `Shield.sol` + Foundry tests (`forge test`, Monad execution network enabled in `foundry.toml`).
- `server/`: scenario, rescuers, stats, faucet. Node 22+, only depends on `viem`.
- `web/`: Vite + React + viem + `@category-labs/mera`.

### Honest notes

- The depeg is a **stress-test simulation**. The price path is pushed by our keeper. Mainnet would read Chainlink or Pyth feeds.
- **Balances are virtual** (USDX amounts and safe value are tracked in the contract), to keep onboarding to seconds on testnet.
- "Demo" positions are labelled onchain (`demo = true`) and exist to measure throughput.
- Two rescuer bots run by us compete with each other and with humans under the same rules. On mainnet, anyone can run a rescuer.

## Onchain proof

Last ~2,500 blocks: 311 positions protected, **311 evacuated**, 51 price steps, 2,545 late rescue attempts recorded. Recount with `python3 scripts/count_events.py 2500`.

| Event | Example |
|---|---|
| `Evacuated` | [0x7147…3bbf](https://testnet.monadvision.com/tx/0x7147799e97555d4be0e1d674024f8f42ccc439abe5b7c10fcb96eda491363bbf) |
| `Late` (lost race, recorded, not reverted) | [0x2e41…39db](https://testnet.monadvision.com/tx/0x2e41d37baac36329c37347fcb8c8639f597b1feb14ab5ec0c9112714521b39db) |
| `Protected` | [0xc24f…70ce](https://testnet.monadvision.com/tx/0xc24f3aa0f14b7a88ea5dd78232a0d2511f541295c7622256341fae92f66b70ce) |
| `Price` (stress-test step) | [0xac0d…6e22](https://testnet.monadvision.com/tx/0xac0d9f5499a51b6b861750ae8d8b2cd68f56047b607e5647f9237f5d541a6e22) |

## Business model

A small protection fee on protected value funds the rescue bounties, and the protocol keeps the spread. The first customers are DAOs and protocol treasuries that hold stablecoins and cannot watch the screen 24/7.

## Run it

```bash
cd contracts && forge test
forge create src/Shield.sol:Shield --rpc-url $RPC_URL --private-key $OPS_PK --broadcast --constructor-args $OPS_ADDRESS

cd server && npm install && npm start          # reads ../.env: RPC_URL, OPS_PK, SHIELD_ADDRESS, DEPLOY_BLOCK

cd web && npm install
VITE_SHIELD_ADDRESS=0x... VITE_SERVER_URL=http://localhost:8787 npm run dev
```

## What's next (Metropolis, Onchain Finance & Trading)

- Mainnet with real stablecoins and LSTs, Chainlink/Pyth triggers, and swaps into the safe asset through Kuru/Uniswap v4.
- Treasury mode for DAOs: protect a Safe with one signature.
- Open rescuer SDK and a [moss](https://github.com/nishuzumi/moss) capability, so any agent can run a rescuer.
