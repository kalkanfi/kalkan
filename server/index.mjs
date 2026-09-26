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
const LIVE = env("LIVE_ADDRESS"); // Kalkan Live: trigger checked against the real Chainlink USDC/USD feed
const LIVE_FROM = BigInt(env("LIVE_DEPLOY_BLOCK", "0"));
const OPS_PK = env("OPS_PK");
const RPC_URL = env("RPC_URL", "https://testnet-rpc.monad.xyz");
const PORT = Number(env("PORT", 8787));
const FUND_AMOUNT = parseEther(env("FUND_AMOUNT", "0.1"));
const OPS_FLOOR = parseEther("1"); // keep gas for price pushes (reserve rules only restrict value transfers, not gas)
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
  pushPrice: () => 40_000n, // warm push measured at ~35.6k (the first-ever push needed more)
  seed: (n) => 60_000n + 45_000n * BigInt(n), // measured ~42k per position
  evacuateMany: (n) => 60_000n + 32_000n * BigInt(n), // measured ~30k per evacuation
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
  async call(fn, args, gas, to = SHIELD) {
    return this.raw({ to, data: encodeFunctionData({ abi, functionName: fn, args }), gas });
  }
  async transfer(to, value) {
    return this.raw({ to, value, gas: 21_000n });
  }
  async raw({ to, data, value = 0n, gas }) {
    if (this.nonce === null) await this.sync();
    const nonce = this.nonce++;
    const signed = await this.account.signTransaction({ chainId: monadTestnet.id, type: "eip1559", to, data, value, gas, nonce, ...FEES });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await pub.sendRawTransaction({ serializedTransaction: signed });
      } catch (e) {
        const msg = e.shortMessage ?? e.message ?? "";
        // Public RPC sometimes drops a request: resend the same signed tx (same nonce, so no double spend).
        if (attempt < 2 && /HTTP request failed|fetch failed|timed out|429/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
          continue;
        }
        if (/already known|nonce too low/i.test(msg) && attempt > 0) return null;
        this.errors++;
        log(`[${this.name}] send failed (nonce ${nonce}):`, msg);
        await this.sync().catch(() => {});
        return null;
      }
    }
    return null;
  }
}

const ops = new Sender(OPS_PK, "ops");
const botKey = (label) => keccak256(concat([OPS_PK, toHex(label)]));
// Three independent rescuers with different reflexes: they race each other for the bounties.
const RESCUERS = [350, 600].map((delay, i) => ({ s: new Sender(botKey(`rescuer-${i}`), `rescuer${i}`), delay }));

// ---------- Chain mirror: positions and scenario events ----------
const positions = new Map(); // id -> { id, owner, trigger, open, demo }
const prices = []; // { price, block }
const evacs = []; // { id, owner, rescuer, price, safe, block, demo }
let lateCount = 0;
const lates = []; // blocks of Late events
let synced = false; // initial backfill done
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
        else if (l.eventName === "Late") {
          lateCount++;
          lates.push(l.blockNumber);
        }
      }
      fromBlock = to + 1n;
    }
    if (!synced && scenario.startBlock === null) {
      // After a restart, show the most recent stress test (it starts with a 0.999 step).
      const last = [...prices].reverse().find((p) => p.price === 99_900_000n);
      if (last) scenario.startBlock = last.block - 1n;
    }
    synced = true;
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
  await ops.call("pushPrice", [px], gasFor.pushPrice());
  RESCUERS.forEach((r, i) => setTimeout(() => rescue(r, i), r.delay));
}

// Cost control (Monad charges the gas LIMIT): each due position is assigned to one rescuer and
// only retried if it is still open 0.7 s later. The second rescuer shadows a few ids so the race stays visible.
const attempted = new Map(); // id -> ts
async function rescue(r, idx) {
  const now = Date.now();
  const due = [...positions.values()].filter((p) => p.open && current < p.trigger);
  const fresh = due.filter((p) => now - (attempted.get(p.id) ?? 0) > 700).map((p) => p.id);
  const shadow = idx > 0 ? due.filter((p) => now - (attempted.get(p.id) ?? 0) <= 700).slice(0, 2).map((p) => p.id) : [];
  const ids = [...fresh, ...shadow].slice(0, 80);
  if (!ids.length) return;
  for (const id of fresh) attempted.set(id, now);
  await r.s.call("evacuateMany", [ids], gasFor.evacuateMany(ids.length));
}

async function runScenario() {
  scenario = { state: "seeding", startedAt: Date.now(), endedAt: 0, startBlock: head, lateAtStart: lateCount, evacsAtStart: evacs.length };
  attempted.clear();
  // Budget guard: fewer demo positions when the ops wallet runs low.
  const opsBal = await pub.getBalance({ address: ops.address });
  const seedN = opsBal > parseEther("25") ? SEED_COUNT : 40;
  if (openDemo() < seedN / 2) {
    await ops.call("seed", [BigInt(seedN), toPx(0.95), toPx(0.995)], gasFor.seed(seedN));
    for (let i = 0; i < 30 && openDemo() < seedN / 2; i++) await sleep(300);
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

// ---------- Kalkan Live: a rescuer that watches the real Chainlink price ----------
const liveAbi = parseAbi([
  "function price() view returns (uint64)",
  "event Protected(uint256 indexed id, address indexed owner, uint64 trigger, uint128 amount)",
  "event Evacuated(uint256 indexed id, address indexed owner, address indexed rescuer, uint64 price, uint128 safe)",
]);
const livePositions = new Map();
let liveFrom = null;
let livePrice = null;
let liveBusy = false;
async function liveTick() {
  if (!LIVE || liveBusy) return;
  liveBusy = true;
  try {
    const h = await pub.getBlockNumber();
    if (liveFrom === null) liveFrom = LIVE_FROM || h - 50n;
    while (liveFrom <= h) {
      const to = h - liveFrom > 99n ? liveFrom + 99n : h;
      for (const l of await pub.getContractEvents({ address: LIVE, abi: liveAbi, fromBlock: liveFrom, toBlock: to })) {
        const a = l.args;
        if (l.eventName === "Protected") livePositions.set(a.id, { id: a.id, owner: a.owner, trigger: a.trigger, open: true });
        else if (l.eventName === "Evacuated") {
          const p = livePositions.get(a.id);
          if (p) Object.assign(p, { open: false, evacPrice: a.price, evacBlock: l.blockNumber, safe: a.safe, rescuer: a.rescuer });
        }
      }
      liveFrom = to + 1n;
    }
    livePrice = await pub.readContract({ address: LIVE, abi: liveAbi, functionName: "price" });
    const now = Date.now();
    const due = [...livePositions.values()].filter((p) => p.open && livePrice < p.trigger && now - (p.tried ?? 0) > 3000);
    if (due.length) {
      for (const p of due) p.tried = now;
      const r = RESCUERS[RESCUERS.length - 1];
      await r.s.call("evacuateMany", [due.map((p) => p.id).slice(0, 40)], 170_000n + 45_000n * BigInt(Math.min(due.length, 40)), LIVE); // measured ~150k for one: cold Chainlink proxy + aggregator reads
    }
  } catch (e) {
    log("liveTick:", e.shortMessage ?? e.message);
  }
  liveBusy = false;
}

// ---------- One-off capacity record: N exits in ONE transaction, ONE block (local only) ----------
let record = null;
async function runRecord(n) {
  scenario.state = "seeding";
  const r = RESCUERS[0];
  await ensureFunded(r.s.address, parseEther("3"), parseEther("2.5")); // gasLimit x maxFee is checked up front
  await sleep(1500);
  await r.s.sync();
  const before = positions.size;
  await ops.call("seed", [BigInt(n), toPx(0.95), toPx(0.995)], gasFor.seed(n));
  for (let i = 0; i < 60 && positions.size < before + n; i++) await sleep(400);
  const ids = [...positions.values()].filter((p) => p.open).map((p) => p.id);
  current = toPx(0.94);
  await ops.call("pushPrice", [current], gasFor.pushPrice());
  await sleep(1200);
  const hash = await r.s.call("evacuateMany", [ids], gasFor.evacuateMany(ids.length));
  const rc = hash ? await pub.waitForTransactionReceipt({ hash, timeout: 30_000 }).catch(() => null) : null;
  const evacuatedInTx = rc ? rc.logs.filter((l) => l.address.toLowerCase() === SHIELD.toLowerCase()).length : 0;
  record = { attempted: ids.length, evacuatedInTx, block: rc?.blockNumber, gasLimit: gasFor.evacuateMany(ids.length), tx: hash, status: rc?.status };
  log("RECORD", JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  current = ONE;
  await ops.call("pushPrice", [current], gasFor.pushPrice());
  scenario.state = "idle";
  scenario.endedAt = Date.now();
}

// ---------- Stats for the latest scenario ----------
function stats() {
  const since = scenario.startBlock ?? 0n;
  const depeg = prices.find((p) => p.block >= since && p.price < ONE);
  const end = depeg ? prices.find((p) => p.block > depeg.block && p.price === ONE) : undefined;
  const until = end && scenario.state === "idle" ? end.block : 1n << 62n; // the stress test window ends when the peg is back
  const scPrices = prices.filter((p) => p.block >= since && p.block <= until);
  const bottom = scPrices.reduce((m, p) => (p.price < m ? p.price : m), ONE);
  const scEvacs = evacs.filter((e) => e.block >= since && e.block <= until);
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
    perBlock: depeg ? [...perBlock.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([b, n]) => [Number(b - depeg.block), n]) : [],
    path: scPrices.slice(-40).map((p) => [depeg ? Number(p.block - depeg.block) : 0, Number(p.price)]),
    blocksUsed: perBlock.size,
    savedUsd: Number(saved) / 1e8,
    avgEvacPrice: scEvacs.length ? Number(scEvacs.reduce((a, e) => a + e.price, 0n) / BigInt(scEvacs.length)) : null,
    record,
    late: lates.filter((b) => b >= since && b <= until).length,
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
  for (const r of RESCUERS) await ensureFunded(r.s.address, parseEther("1.5"), parseEther("3"));
  await sleep(1500); // funding must land before rescuers send (Monad: ~3 block delay)
  for (const r of RESCUERS) await r.s.sync();
  current = await pub.readContract({ address: SHIELD, abi, functionName: "price" });
  log("rescuers ready:", RESCUERS.map((r) => r.s.address).join(", "));
}

// ---------- HTTP ----------
const funded = new Map(); // address -> last funding time
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
    if (url.pathname === "/record" && req.method === "POST") {
      // Local only: tunnel requests carry cf-connecting-ip, direct localhost calls do not.
      if (req.headers["cf-connecting-ip"] || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) return json(res, 403, { error: "local only" });
      if (scenario.state !== "idle" || !synced) return json(res, 409, { error: "busy" });
      runRecord(Number(url.searchParams.get("n") ?? 500)).catch((e) => {
        log("record failed:", e);
        scenario.state = "idle";
      });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/record") return json(res, 200, record ?? {});
    if (url.pathname === "/mine") {
      const who = (url.searchParams.get("owner") ?? "").toLowerCase();
      const src = url.searchParams.get("live") ? livePositions : positions;
      return json(res, 200, [...src.values()].filter((p) => p.owner.toLowerCase() === who).slice(-20).reverse());
    }
    if (url.pathname === "/live") return json(res, 200, { price: livePrice, positions: livePositions.size, address: LIVE });
    if (url.pathname === "/scenario" && req.method === "POST") {
      if (!synced) return json(res, 503, { error: "syncing" });
      if (scenario.state !== "idle") return json(res, 409, { error: "running", state: scenario.state });
      if (scenario.endedAt && Date.now() - scenario.endedAt < COOLDOWN_MS) return json(res, 429, { error: "cooldown" });
      const opsBal = await pub.getBalance({ address: ops.address });
      if (opsBal < parseEther("2")) return json(res, 503, { error: "budget" });
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
      // Event Wi-Fi puts everyone behind one IP: generous per-IP cap; top up an address again once it runs low.
      if ((fundsByIp.get(ip) ?? 0) >= 200) return json(res, 429, { error: "limit" });
      const bal = await pub.getBalance({ address });
      if (bal >= FUND_AMOUNT / 2n) return json(res, 200, { ok: true, already: true });
      const last = funded.get(address.toLowerCase()) ?? 0;
      if (Date.now() - last < 20_000) return json(res, 200, { ok: true, pending: true });
      const opsBal = await pub.getBalance({ address: ops.address });
      if (opsBal - FUND_AMOUNT < OPS_FLOOR) return json(res, 503, { error: "faucet empty" });
      funded.set(address.toLowerCase(), Date.now());
      fundsByIp.set(ip, (fundsByIp.get(ip) ?? 0) + 1);
      const hash = await ops.transfer(address, FUND_AMOUNT);
      return json(res, 200, { ok: !!hash, hash });
    }
    json(res, 404, { error: "not found" });
  })
  .listen(PORT, () => log(`server on :${PORT}, shield ${SHIELD}, ops ${ops.address}`));

setInterval(pollLogs, 400);
setInterval(liveTick, 1500);
bootstrap().catch((e) => log("bootstrap failed:", e));
