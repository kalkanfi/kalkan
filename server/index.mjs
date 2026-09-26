// Kalkan server: depeg stress-test scenario, rescuer bots, scenario stats, and a small faucet.
// One file on purpose. The frontend reads the chain directly; this only drives the demo.
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
const SHIELD = env("SHIELD_ADDRESS");
const OPS_PK = env("OPS_PK");
const RPC_URL = env("RPC_URL", "https://testnet-rpc.monad.xyz");
const PORT = Number(env("PORT", 8787));
const FUND_AMOUNT = parseEther(env("FUND_AMOUNT", "0.25"));
const OPS_FLOOR = parseEther("10.5"); // Monad reserve balance: keep ops above 10 MON after value transfers
const SEED_COUNT = Number(env("SEED_COUNT", 120));
const COOLDOWN_MS = Number(env("COOLDOWN_MS", 60_000));
if (!SHIELD || !OPS_PK) throw new Error("SHIELD_ADDRESS and OPS_PK are required");

const abi = parseAbi([
  "function pushPrice(uint64 px)",
  "function seed(uint256 count, uint64 lowTrigger, uint64 highTrigger)",
  "function evacuateMany(uint256[] ids) returns (uint256)",
  "function price() view returns (uint64)",
  "event Price(uint64 price)",
  "event Protected(uint256 indexed id, address indexed owner, uint64 trigger, uint128 amount, bool demo)",
  "event Evacuated(uint256 indexed id, address indexed owner, address indexed rescuer, uint64 price, uint128 safe)",
  "event Late(uint256 indexed id, address indexed rescuer)",
]);

// Monad charges the gas LIMIT, not gas used: measured, fixed limits (one evacuation ~30k gas).
const FEES = { maxFeePerGas: 120_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const gasFor = {
  pushPrice: () => 70_000n, // first write to priceBlock costs more than later pushes
  seed: (n) => 80_000n + 55_000n * BigInt(n),
  evacuateMany: (n) => 70_000n + 36_000n * BigInt(n),
};
const ONE = 100_000_000n;

const pub = createPublicClient({ chain: monadTestnet, transport: httpTransport(RPC_URL) });
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  async call(fn, args, gas) {
    return this.raw({ to: SHIELD, data: encodeFunctionData({ abi, functionName: fn, args }), gas });
  }
  async transfer(to, value) {
    return this.raw({ to, value, gas: 21_000n });
  }
  async raw({ to, data, value = 0n, gas }) {
    if (this.nonce === null) await this.sync();
    const nonce = this.nonce++;
    const signed = await this.account.signTransaction({ chainId: monadTestnet.id, type: "eip1559", to, data, value, gas, nonce, ...FEES });
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
// Three independent rescuers with different reflexes: they race each other for the bounties.
const RESCUERS = [150, 450].map((delay, i) => ({ s: new Sender(botKey(`rescuer-${i}`), `rescuer${i}`), delay }));

// ---------- Chain mirror: positions and scenario events ----------
const positions = new Map(); // id -> { id, owner, trigger, open, demo }
const prices = []; // { price, block }
const evacs = []; // { id, owner, rescuer, price, safe, block, demo }
let lateCount = 0;
let fromBlock = null;
let head = 0n;
let polling = false;

async function pollLogs() {
  if (polling) return;
  polling = true;
  try {
    head = await pub.getBlockNumber();
    if (fromBlock === null) fromBlock = BigInt(env("DEPLOY_BLOCK", String(head - 50n)));
    while (fromBlock <= head) {
      const to = head - fromBlock > 99n ? fromBlock + 99n : head; // stay under RPC log range limits
      const logs = await pub.getContractEvents({ address: SHIELD, abi, fromBlock, toBlock: to });
      for (const l of logs) {
        const a = l.args;
        if (l.eventName === "Protected") positions.set(a.id, { id: a.id, owner: a.owner, trigger: a.trigger, open: true, demo: a.demo });
        else if (l.eventName === "Evacuated") {
          const p = positions.get(a.id);
          if (p) Object.assign(p, { open: false, evacPrice: a.price, evacBlock: l.blockNumber, safe: a.safe, rescuer: a.rescuer });
          evacs.push({ id: a.id, owner: a.owner, rescuer: a.rescuer, price: a.price, safe: a.safe, block: l.blockNumber, demo: p?.demo ?? true });
        } else if (l.eventName === "Price") prices.push({ price: a.price, block: l.blockNumber });
        else if (l.eventName === "Late") lateCount++;
      }
      fromBlock = to + 1n;
    }
  } catch (e) {
    log("pollLogs:", e.shortMessage ?? e.message);
  }
  polling = false;
}

// ---------- Scenario: a depeg, block by block ----------
const PATH = [0.999, 0.996, 0.992, 0.987, 0.98, 0.97, 0.96, 0.945, 0.93, 0.91, 0.89, 0.87];
const RECOVERY = [0.9, 0.94, 0.97, 0.99, 1.0];
let scenario = { state: "idle", startedAt: 0, endedAt: 0, startBlock: null, lateAtStart: 0, evacsAtStart: 0 };
let current = ONE; // what we last pushed
const toPx = (x) => BigInt(Math.round(x * 1e8));
const openDemo = () => [...positions.values()].filter((p) => p.open && p.demo).length;

async function push(px) {
  current = px;
  sentBy.clear(); // new price: every rescuer may retry what is still open
  await ops.call("pushPrice", [px], gasFor.pushPrice());
  for (const r of RESCUERS) setTimeout(() => rescue(r), r.delay);
}

const sentBy = new Map(); // rescuer -> Set(ids) already attempted in this scenario
async function rescue(r) {
  const sent = sentBy.get(r) ?? new Set();
  sentBy.set(r, sent);
  const ids = [...positions.values()].filter((p) => p.open && current < p.trigger && !sent.has(p.id)).map((p) => p.id).slice(0, 150);
  if (!ids.length) return;
  for (const id of ids) sent.add(id);
  await r.s.call("evacuateMany", [ids], gasFor.evacuateMany(ids.length));
}

async function runScenario() {
  scenario = { state: "seeding", startedAt: Date.now(), endedAt: 0, startBlock: head, lateAtStart: lateCount, evacsAtStart: evacs.length };
  sentBy.clear();
  if (openDemo() < SEED_COUNT / 2) {
    await ops.call("seed", [BigInt(SEED_COUNT), toPx(0.95), toPx(0.995)], gasFor.seed(SEED_COUNT));
    for (let i = 0; i < 30 && openDemo() < SEED_COUNT / 2; i++) await sleep(300);
  }
  scenario.state = "crash";
  scenario.startBlock = head;
  for (const x of PATH) {
    await push(toPx(x));
    await sleep(320); // ~one Monad block per step
  }
  scenario.state = "bottom";
  await sleep(8_000);
  scenario.state = "recovery";
  for (const x of RECOVERY) {
    await push(toPx(x));
    await sleep(600);
  }
  scenario.state = "idle";
  scenario.endedAt = Date.now();
  log("scenario done:", JSON.stringify(stats(), (_, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 300));
}

// ---------- Stats for the latest scenario ----------
function stats() {
  const since = scenario.startBlock ?? 0n;
  const scPrices = prices.filter((p) => p.block >= since);
  const depeg = scPrices.find((p) => p.price < ONE);
  const bottom = scPrices.reduce((m, p) => (p.price < m ? p.price : m), ONE);
  const scEvacs = evacs.slice(scenario.evacsAtStart);
  const perBlock = new Map();
  const lats = [];
  let saved = 0n;
  const rows = [];
  for (const e of scEvacs) {
    perBlock.set(e.block, (perBlock.get(e.block) ?? 0) + 1);
    const pos = positions.get(e.id);
    const cross = pos ? scPrices.find((p) => p.price < pos.trigger) : undefined;
    const lat = cross ? Number(e.block - cross.block) : null;
    if (lat !== null) lats.push(lat);
    saved += e.safe - 10_000n * bottom; // vs riding the depeg to the bottom
    rows.push({ id: e.id, owner: e.owner, rescuer: e.rescuer, price: e.price, block: e.block, latency: lat, demo: e.demo, trigger: pos?.trigger });
  }
  return {
    state: scenario.state,
    price: current,
    head,
    depegBlock: depeg?.block ?? null,
    bottom,
    evacuated: scEvacs.length,
    stillOpen: [...positions.values()].filter((p) => p.open).length,
    latency: lats.length
      ? { avg: lats.reduce((a, b) => a + b, 0) / lats.length, min: Math.min(...lats), max: Math.max(...lats) }
      : { avg: null, min: null, max: null },
    maxPerBlock: Math.max(0, ...perBlock.values()),
    blocksUsed: perBlock.size,
    savedUsd: Number(saved) / 1e8,
    late: lateCount - scenario.lateAtStart,
    rescuers: RESCUERS.map((r) => r.s.address),
    open: [...positions.values()].filter((p) => p.open).slice(0, 400).map((p) => [p.id, p.trigger]),
    recent: rows.slice(-25).reverse(),
    cooldownMs: scenario.endedAt ? Math.max(0, COOLDOWN_MS - (Date.now() - scenario.endedAt)) : 0,
  };
}

// ---------- Bootstrapping ----------
async function ensureFunded(to, min, amount) {
  const bal = await pub.getBalance({ address: to });
  if (bal >= min) return;
  const opsBal = await pub.getBalance({ address: ops.address });
  if (opsBal - amount < OPS_FLOOR) return log(`ops too low to fund ${to}`);
  await ops.transfer(to, amount);
  log(`funded ${to} with ${formatEther(amount)} MON`);
}

async function bootstrap() {
  await ops.sync();
  for (const r of RESCUERS) await ensureFunded(r.s.address, parseEther("1.5"), parseEther("2"));
  await sleep(1500); // funding must land before rescuers send (Monad: ~3 block delay)
  for (const r of RESCUERS) await r.s.sync();
  current = await pub.readContract({ address: SHIELD, abi, functionName: "price" });
  log("rescuers ready:", RESCUERS.map((r) => r.s.address).join(", "));
}

// ---------- HTTP ----------
const funded = new Set();
const fundsByIp = new Map();
function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" });
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
    if (url.pathname === "/status") return json(res, 200, stats());
    if (url.pathname === "/mine") {
      const who = (url.searchParams.get("owner") ?? "").toLowerCase();
      return json(res, 200, [...positions.values()].filter((p) => p.owner.toLowerCase() === who).slice(-20).reverse());
    }
    if (url.pathname === "/scenario" && req.method === "POST") {
      if (scenario.state !== "idle") return json(res, 409, { error: "running", state: scenario.state });
      if (scenario.endedAt && Date.now() - scenario.endedAt < COOLDOWN_MS) return json(res, 429, { error: "cooldown" });
      runScenario().catch((e) => {
        log("scenario failed:", e);
        scenario.state = "idle";
        scenario.endedAt = Date.now();
      });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/health") {
      const opsBal = await pub.getBalance({ address: ops.address }).catch(() => null);
      return json(res, 200, {
        ops: ops.address, opsBalance: opsBal === null ? null : formatEther(opsBal), positions: positions.size, head,
        errors: { ops: ops.errors, rescuers: RESCUERS.map((r) => r.s.errors) },
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
      funded.add(address.toLowerCase());
      fundsByIp.set(ip, (fundsByIp.get(ip) ?? 0) + 1);
      const hash = await ops.transfer(address, FUND_AMOUNT);
      return json(res, 200, { ok: !!hash, hash });
    }
    json(res, 404, { error: "not found" });
  })
  .listen(PORT, () => log(`server on :${PORT}, shield ${SHIELD}, ops ${ops.address}`));

setInterval(pollLogs, 400);
bootstrap().catch((e) => log("bootstrap failed:", e));
