// Maker Arena server: price keeper, bot makers, one bot arbitrageur, and a small faucet.
// One file on purpose. Everything else (reads, logs) the frontend gets straight from the RPC.
import http from "node:http";
import { existsSync } from "node:fs";
import {
  createPublicClient,
  http as httpTransport,
  parseAbi,
  encodeFunctionData,
  keccak256,
  concat,
  toHex,
  parseEther,
  formatEther,
  isAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { monadTestnet } from "viem/chains";

if (existsSync(new URL("../.env", import.meta.url))) process.loadEnvFile(new URL("../.env", import.meta.url));

const env = (k, d) => process.env[k] ?? d;
const ARENA = env("ARENA_ADDRESS");
const OPS_PK = env("OPS_PK");
const RPC_URL = env("RPC_URL", "https://testnet-rpc.monad.xyz");
const PORT = Number(env("PORT", 8787));
const VOL_MULT = Number(env("VOL_MULT", 50)); // demo: amplify real BTC moves so races happen in a 90 s video
const ARB_DELAY_MS = Number(env("ARB_DELAY_MS", 600)); // give humans a fair shot at the race
const IDLE_PUSH_MS = Number(env("IDLE_PUSH_MS", 30_000));
const ACTIVE_WINDOW_MS = Number(env("ACTIVE_WINDOW_MS", 90_000));
const FORCE_ACTIVE = env("FORCE_ACTIVE", "0") === "1";
const FUND_AMOUNT = parseEther(env("FUND_AMOUNT", "0.25"));
const OPS_FLOOR = parseEther("10.5"); // Monad reserve balance: keep ops above 10 MON after value transfers
if (!ARENA || !OPS_PK) throw new Error("ARENA_ADDRESS and OPS_PK are required");

const abi = parseAbi([
  "function pushPrice(uint64 px)",
  "function register()",
  "function setQuote(uint32 spreadBps, uint64 size)",
  "function refresh()",
  "function hit(address maker, bool takerBuys, uint64 qty, uint64 limitPrice) returns (bool)",
  "function players(address) view returns (int128 usd, int128 base, uint64 mid, uint32 spreadBps, uint64 size, uint64 refreshedAt, bool registered)",
  "function price() view returns (uint64)",
  "event Quote(address indexed maker, uint64 mid, uint32 spreadBps, uint64 size)",
]);

// Monad charges the gas LIMIT, not gas used, so every call gets a measured, fixed limit.
const GAS = { pushPrice: 45_000n, register: 120_000n, setQuote: 90_000n, refresh: 80_000n, hit: 110_000n, transfer: 21_000n };
const FEES = { maxFeePerGas: 150_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const QUOTE_TTL = 100n;
const ONE = 100_000_000n;

const pub = createPublicClient({ chain: monadTestnet, transport: httpTransport(RPC_URL) });
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// ---------- Sender: local nonce, fire-and-forget (Monad best practice for fast senders) ----------
class Sender {
  constructor(pk, name) {
    this.account = privateKeyToAccount(pk);
    this.name = name;
    this.nonce = null;
    this.errors = 0;
  }
  get address() {
    return this.account.address;
  }
  async sync() {
    this.nonce = await pub.getTransactionCount({ address: this.address, blockTag: "latest" });
  }
  async call(fn, args = []) {
    return this.raw({ to: ARENA, data: encodeFunctionData({ abi, functionName: fn, args }), gas: GAS[fn] });
  }
  async transfer(to, value) {
    return this.raw({ to, value, gas: GAS.transfer });
  }
  async raw({ to, data, value = 0n, gas }) {
    if (this.nonce === null) await this.sync();
    const nonce = this.nonce++;
    const signed = await this.account.signTransaction({
      chainId: monadTestnet.id, type: "eip1559", to, data, value, gas, nonce, ...FEES,
    });
    try {
      return await pub.sendRawTransaction({ serializedTransaction: signed });
    } catch (e) {
      this.errors++;
      log(`[${this.name}] send failed (nonce ${nonce}):`, e.shortMessage ?? e.message);
      await this.sync().catch(() => {});
      return null;
    }
  }
}

const ops = new Sender(OPS_PK, "ops");
const botKey = (label) => keccak256(concat([OPS_PK, toHex(label)]));

// ---------- Presence: run hot only while someone is watching ----------
let lastSeen = 0;
const isActive = () => FORCE_ACTIVE || Date.now() - lastSeen < ACTIVE_WINDOW_MS;

// ---------- Reference price: Binance bookTicker, Bybit fallback ----------
let refMid = null; // real BTC/USD mid
let anchor = null; // slow 2-minute EMA of the real mid
let lastMidAt = 0;
// Demo price = real mid + (short-term move) * (VOL_MULT - 1): short swings are amplified,
// but the price stays centred on the real BTC price instead of drifting away over time.
function onMid(mid) {
  if (!Number.isFinite(mid) || mid <= 0) return;
  const now = Date.now();
  if (anchor === null) anchor = mid;
  else anchor += (mid - anchor) * Math.min(1, (now - lastMidAt) / 120_000);
  lastMidAt = now;
  refMid = mid;
}
const demoPrice = () => (refMid === null ? null : BigInt(Math.round((refMid + (refMid - anchor) * (VOL_MULT - 1)) * 1e8)));

function connectFeed(i = 0) {
  const feeds = [
    { url: "wss://stream.binance.com:9443/ws/btcusdt@bookTicker", parse: (m) => (+m.b + +m.a) / 2 },
    {
      url: "wss://stream.bybit.com/v5/public/spot",
      sub: { op: "subscribe", args: ["orderbook.1.BTCUSDT"] },
      parse: (m) => (m.data?.b?.[0] && m.data?.a?.[0] ? (+m.data.b[0][0] + +m.data.a[0][0]) / 2 : NaN),
    },
  ];
  const f = feeds[i % feeds.length];
  const ws = new WebSocket(f.url);
  ws.onopen = () => {
    log("price feed connected:", f.url);
    if (f.sub) ws.send(JSON.stringify(f.sub));
  };
  ws.onmessage = (ev) => {
    try {
      onMid(f.parse(JSON.parse(ev.data)));
    } catch {}
  };
  ws.onclose = () => {
    log("price feed closed, switching");
    setTimeout(() => connectFeed(i + 1), 1000);
  };
  ws.onerror = () => ws.close();
}

// ---------- Keeper: push the price every block while active ----------
let pushed = null; // last price we pushed onchain
let lastPushAt = 0;
const priceListeners = [];
function keeperTick() {
  const px = demoPrice();
  if (px === null) return;
  const now = Date.now();
  const moved = pushed === null || (px > pushed ? px - pushed : pushed - px) * 10_000n >= pushed; // >= 1 bps
  const due = isActive() ? (moved && now - lastPushAt >= 400) || now - lastPushAt > 5_000 : now - lastPushAt > IDLE_PUSH_MS;
  if (!due) return;
  pushed = px;
  lastPushAt = now;
  ops.call("pushPrice", [px]);
  for (const f of priceListeners) f(px);
}

// ---------- Quote book (all makers, humans included) from Quote events ----------
const quotes = new Map(); // maker -> { mid, spreadBps, size, block }
let head = 0n;
let fromBlock = null;
async function pollQuotes() {
  try {
    head = await pub.getBlockNumber();
    if (fromBlock === null) fromBlock = head > 500n ? head - 500n : 0n;
    if (head < fromBlock) return;
    const to = head - fromBlock > 99n ? fromBlock + 99n : head; // stay under RPC log range limits
    const logs = await pub.getContractEvents({ address: ARENA, abi, eventName: "Quote", fromBlock, toBlock: to });
    for (const l of logs) {
      const { maker, mid, spreadBps, size } = l.args;
      quotes.set(maker.toLowerCase(), { maker, mid, spreadBps: BigInt(spreadBps), size, block: l.blockNumber });
    }
    fromBlock = to + 1n;
  } catch (e) {
    log("pollQuotes:", e.shortMessage ?? e.message);
  }
}

// ---------- Bot makers: same game, different reflexes ----------
const MAKERS = [
  { spread: 8, size: 20_000_000n, reactMs: 400 },
  { spread: 15, size: 30_000_000n, reactMs: 1200 },
  { spread: 30, size: 50_000_000n, reactMs: 2500 },
  { spread: 60, size: 80_000_000n, reactMs: 6000 },
].map((m, i) => ({ ...m, s: new Sender(botKey(`maker-${i}`), `maker${i}`), mid: null, refreshAt: 0, pending: false }));

function makerOnPrice(m, px) {
  if (!isActive() || m.pending || m.mid === null) return;
  const drift = (px > m.mid ? px - m.mid : m.mid - px) * 10_000n;
  if (drift < m.mid * BigInt(m.spread) / 2n) return; // still inside half the spread: no need to move
  m.pending = true;
  setTimeout(async () => {
    m.pending = false;
    m.mid = pushed;
    m.refreshAt = Date.now();
    await m.s.call("refresh");
  }, m.reactMs);
}

async function makerKeepAlive() {
  if (!isActive()) return;
  for (const m of MAKERS) {
    if (Date.now() - m.refreshAt > 20_000 && pushed !== null) {
      m.mid = pushed;
      m.refreshAt = Date.now();
      await m.s.call("refresh");
    }
  }
}

// ---------- Bot arbitrageur: hits stale quotes after a human-sized delay ----------
const arb = { s: new Sender(botKey("arb-0"), "arb"), lastHit: new Map() };
function arbOnPrice(px) {
  if (!isActive()) return;
  setTimeout(() => {
    const cur = pushed;
    for (const q of quotes.values()) {
      if (q.maker.toLowerCase() === arb.s.address.toLowerCase()) continue;
      if (head > q.block + QUOTE_TTL - 2n) continue;
      if (arb.lastHit.get(q.maker) === q.mid) continue; // one shot per quote
      const half = (q.mid * q.spreadBps) / 10_000n;
      const bid = q.mid - half;
      const ask = q.mid + half;
      const qty = q.size < 10_000_000n ? q.size : 10_000_000n; // 0.1 BTC max
      if (cur > ask + ask / 5_000n) {
        arb.lastHit.set(q.maker, q.mid);
        arb.s.call("hit", [q.maker, true, qty, ask]);
      } else if (cur < bid - bid / 5_000n) {
        arb.lastHit.set(q.maker, q.mid);
        arb.s.call("hit", [q.maker, false, qty, bid]);
      }
    }
  }, ARB_DELAY_MS);
}

// ---------- Bootstrapping ----------
async function ensureFunded(to, min, amount) {
  const bal = await pub.getBalance({ address: to });
  if (bal >= min) return;
  const opsBal = await pub.getBalance({ address: ops.address });
  if (opsBal - amount < OPS_FLOOR) return log(`ops too low to fund ${to} (${formatEther(opsBal)} MON)`);
  await ops.transfer(to, amount);
  log(`funded ${to} with ${formatEther(amount)} MON`);
}

async function ensurePlayer(s, spread, size) {
  const p = await pub.readContract({ address: ARENA, abi, functionName: "players", args: [s.address] });
  if (!p[6]) await s.call("register");
  if (spread) await s.call("setQuote", [spread, size]);
}

async function bootstrap() {
  await ops.sync();
  for (const m of MAKERS) await ensureFunded(m.s.address, parseEther("0.5"), parseEther("1.5"));
  await ensureFunded(arb.s.address, parseEther("0.5"), parseEther("1.5"));
  await new Promise((r) => setTimeout(r, 2000)); // funding must land before bots send (Monad: ~3 block delay)
  while (pushed === null) {
    keeperTick();
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 1500));
  for (const m of MAKERS) {
    await m.s.sync();
    await ensurePlayer(m.s, m.spread, m.size);
    m.mid = pushed;
    m.refreshAt = Date.now();
  }
  await arb.s.sync();
  await ensurePlayer(arb.s);
  for (const m of MAKERS) priceListeners.push((px) => makerOnPrice(m, px));
  priceListeners.push(arbOnPrice);
  log("bots ready:", MAKERS.map((m) => m.s.address).join(", "), "arb", arb.s.address);
}

// ---------- HTTP: /health, /presence, /fund ----------
const funded = new Map(); // address -> ts
const fundsByIp = new Map();
function json(res, code, body) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c.length < 2048 ? c : ""));
    req.on("end", () => {
      try {
        resolve(JSON.parse(d || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

http
  .createServer(async (req, res) => {
    if (req.method === "OPTIONS") return json(res, 204, {});
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/presence") {
      lastSeen = Date.now();
      return json(res, 200, { active: true });
    }
    if (url.pathname === "/health") {
      const opsBal = await pub.getBalance({ address: ops.address }).catch(() => null);
      return json(res, 200, {
        active: isActive(), pushed, refMid, anchor, volMult: VOL_MULT, head,
        ops: ops.address, opsBalance: opsBal === null ? null : formatEther(opsBal),
        makers: MAKERS.map((m) => m.s.address), arb: arb.s.address,
        errors: { ops: ops.errors, arb: arb.s.errors, makers: MAKERS.map((m) => m.s.errors) },
      });
    }
    if (url.pathname === "/fund" && req.method === "POST") {
      const { address } = await readBody(req);
      if (!isAddress(address ?? "")) return json(res, 400, { error: "bad address" });
      const ip = (req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim();
      if (funded.has(address.toLowerCase())) return json(res, 200, { ok: true, already: true });
      if ((fundsByIp.get(ip) ?? 0) >= 5) return json(res, 429, { error: "limit" });
      const bal = await pub.getBalance({ address });
      if (bal >= FUND_AMOUNT / 2n) return json(res, 200, { ok: true, already: true });
      const opsBal = await pub.getBalance({ address: ops.address });
      if (opsBal - FUND_AMOUNT < OPS_FLOOR) return json(res, 503, { error: "faucet empty" });
      funded.set(address.toLowerCase(), Date.now());
      fundsByIp.set(ip, (fundsByIp.get(ip) ?? 0) + 1);
      const hash = await ops.transfer(address, FUND_AMOUNT);
      return json(res, 200, { ok: !!hash, hash });
    }
    json(res, 404, { error: "not found" });
  })
  .listen(PORT, () => log(`server on :${PORT}, arena ${ARENA}, ops ${ops.address}`));

connectFeed();
setInterval(keeperTick, 300);
setInterval(pollQuotes, 1000);
setInterval(makerKeepAlive, 2000);
bootstrap().catch((e) => log("bootstrap failed:", e));
