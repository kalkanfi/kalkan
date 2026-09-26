import { useEffect, useMemo, useRef, useState } from "react";
import type { Hex, LocalAccount } from "viem";
import { formatEther } from "viem";
import { ARENA, SERVER, EXPLORER, ONE, QUOTE_TTL, BLOCK_MS, abi, pub, passkeyAccount, guestAccount, Sender } from "./chain";
import "./App.css";

type Ev = {
  kind: "Registered" | "Price" | "Quote" | "Fill" | "Miss";
  block: bigint;
  txIndex: number;
  hash: Hex;
  args: Record<string, any>;
  seenAt: number;
};
type Q = { maker: Hex; mid: bigint; spreadBps: bigint; size: bigint; block: bigint };

const fmtPx = (p?: bigint | null) => (p ? (Number(p) / 1e8).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const bps = (a: bigint, b: bigint) => (b === 0n ? 0 : Number(((a - b) * 100_000n) / b) / 10);

export default function App() {
  const [account, setAccount] = useState<LocalAccount | null>(null);
  const [status, setStatus] = useState("");
  const [ready, setReady] = useState(false);
  const sender = useRef<Sender | null>(null);

  const [events, setEvents] = useState<Ev[]>([]);
  const [head, setHead] = useState(0n);
  const [players, setPlayers] = useState(0n);
  const [board, setBoard] = useState<{ who: Hex; pnl: number }[]>([]);
  const [spread, setSpread] = useState(15);
  const [size, setSize] = useState(0.3);
  const [myTxs, setMyTxs] = useState<{ hash: Hex; label: string }[]>([]);
  const cursor = useRef<bigint | null>(null);

  // ---------- Event stream straight from the RPC (no indexer, no backend) ----------
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const h = await pub.getBlockNumber();
        if (cursor.current === null) cursor.current = h > 300n ? h - 300n : 0n;
        const from = cursor.current;
        if (h >= from) {
          const to = h - from > 99n ? from + 99n : h;
          const logs = await pub.getContractEvents({ address: ARENA, abi, fromBlock: from, toBlock: to });
          cursor.current = to + 1n;
          if (logs.length) {
            const now = Date.now();
            const evs = logs.map((l: any) => ({
              kind: l.eventName, block: l.blockNumber, txIndex: l.transactionIndex, hash: l.transactionHash, args: l.args, seenAt: now,
            })) as Ev[];
            setEvents((prev) => [...prev, ...evs].slice(-3000));
          }
        }
        setHead(h);
      } catch {}
      if (!stop) setTimeout(tick, 600);
    };
    tick();
    return () => {
      stop = true;
    };
  }, []);

  // Tell the server someone is watching: keeper and bots run hot only then.
  useEffect(() => {
    const ping = () => fetch(`${SERVER}/presence`).catch(() => {});
    ping();
    const id = setInterval(ping, 20_000);
    return () => clearInterval(id);
  }, []);

  const price = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === "Price") return events[i].args.price as bigint;
    return null;
  }, [events]);

  const quotes = useMemo(() => {
    const m = new Map<string, Q>();
    for (const e of events) if (e.kind === "Quote") m.set(e.args.maker.toLowerCase(), { ...e.args, spreadBps: BigInt(e.args.spreadBps), block: e.block } as Q);
    return m;
  }, [events]);

  // ---------- Stats: every Arena tx emits exactly one event ----------
  const stats = useMemo(() => {
    const now = Date.now();
    const recent = events.filter((e) => e.block + 34n >= head).length; // ~10 s of blocks
    const fills = events.filter((e) => e.kind === "Fill").length;
    const misses = events.filter((e) => e.kind === "Miss").length;
    return { total: events.length, tps: recent / 10, fills, misses, now };
  }, [events, head]);

  // ---------- Races: for each hit, when did the quote go stale, and who got there first ----------
  const races = useMemo(() => {
    const priceEvs = events.filter((e) => e.kind === "Price");
    const quoteHist = new Map<string, Ev[]>();
    for (const e of events) if (e.kind === "Quote") {
      const k = e.args.maker.toLowerCase();
      quoteHist.set(k, [...(quoteHist.get(k) ?? []), e]);
    }
    const rows = [];
    for (const e of events) {
      if (e.kind !== "Fill" && e.kind !== "Miss") continue;
      const hist = quoteHist.get(e.args.maker.toLowerCase()) ?? [];
      const q = [...hist].reverse().find((x) => x.block < e.block || (x.block === e.block && x.txIndex < e.txIndex));
      let staleAt: bigint | null = null;
      if (q && e.kind === "Fill") {
        const half = (q.args.mid * BigInt(q.args.spreadBps)) / 10_000n;
        const p = priceEvs.find(
          (x) => x.block >= q.block && x.block <= e.block && (e.args.takerBuys ? x.args.price > q.args.mid + half : x.args.price < q.args.mid - half),
        );
        staleAt = p ? p.block : null;
      }
      const refreshedFirst = e.kind === "Miss" ? hist.find((x) => x.block <= e.block && x.block >= e.block - 20n) : undefined;
      rows.push({ e, staleAt, refreshedFirst });
    }
    return rows.slice(-12).reverse();
  }, [events]);

  // ---------- Leaderboard (PnL vs just holding the starting bag) ----------
  useEffect(() => {
    if (!price) return;
    const who = [...new Set([...quotes.values()].map((q) => q.maker))].slice(0, 16);
    const id = setTimeout(async () => {
      try {
        const [eq, pc] = await Promise.all([
          Promise.all(who.map((w) => pub.readContract({ address: ARENA, abi, functionName: "equityOf", args: [w] }))),
          pub.readContract({ address: ARENA, abi, functionName: "playerCount" }),
        ]);
        const baseline = 100_000n * ONE + price;
        setBoard(who.map((w, i) => ({ who: w, pnl: Number((eq[i] as bigint) - baseline) / 1e8 })).sort((a, b) => b.pnl - a.pnl));
        setPlayers(pc as bigint);
      } catch {}
    }, 400);
    return () => clearTimeout(id);
  }, [price, quotes]);

  // ---------- Onboarding ----------
  async function start(kind: "passkey" | "guest") {
    try {
      setStatus(kind === "passkey" ? "Passkey bekleniyor…" : "Misafir hesabı hazırlanıyor…");
      const acct = kind === "passkey" ? await passkeyAccount() : guestAccount();
      setAccount(acct);
      sender.current = new Sender(acct);
      let bal = await pub.getBalance({ address: acct.address });
      if (bal < 50_000_000_000_000_000n) {
        setStatus("Test MON gönderiliyor…");
        await fetch(`${SERVER}/fund`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: acct.address }),
        });
        for (let i = 0; i < 30 && bal < 50_000_000_000_000_000n; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          bal = await pub.getBalance({ address: acct.address });
        }
      }
      await new Promise((r) => setTimeout(r, 1200)); // Monad: newly funded accounts wait ~3 blocks before sending
      const p = await pub.readContract({ address: ARENA, abi, functionName: "players", args: [acct.address] });
      if (!p[6]) {
        setStatus("Arenaya kaydolunuyor…");
        track(await sender.current.call("register"), "kayıt");
      }
      setStatus(`Hazır · bakiye ${Number(formatEther(bal)).toFixed(2)} MON`);
      setReady(true);
    } catch (e: any) {
      const msg = String(e?.code ?? e?.message ?? e);
      setStatus(
        msg.includes("PRF")
          ? "Bu tarayıcı passkey PRF desteklemiyor (masaüstü Chrome yerel profil). Misafir olarak devam et."
          : `Hata: ${msg.slice(0, 120)}`,
      );
    }
  }

  function track(hash: Hex, label: string) {
    setMyTxs((t) => [{ hash, label }, ...t].slice(0, 6));
  }
  async function act(fn: "setQuote" | "refresh" | "hit", args: readonly unknown[], label: string) {
    if (!sender.current) return;
    try {
      track(await sender.current.call(fn, args), label);
    } catch (e: any) {
      setStatus(`Tx hatası: ${(e?.shortMessage ?? e?.message ?? "").slice(0, 100)}`);
    }
  }

  const me = account?.address.toLowerCase();
  const myQuote = me ? quotes.get(me) : undefined;
  const myHalf = myQuote ? (myQuote.mid * myQuote.spreadBps) / 10_000n : 0n;
  const myDrift = myQuote && price ? bps(price, myQuote.mid) : 0;
  const myStale = !!(myQuote && price && (price > myQuote.mid + myHalf || price < myQuote.mid - myHalf));
  const myAge = myQuote ? head - myQuote.block : 0n;

  const targets = [...quotes.values()]
    .filter((q) => q.maker.toLowerCase() !== me && head <= q.block + QUOTE_TTL)
    .map((q) => {
      const half = (q.mid * q.spreadBps) / 10_000n;
      const bid = q.mid - half;
      const ask = q.mid + half;
      const buyEdge = price ? bps(price, ask) : 0;
      const sellEdge = price ? bps(bid, price) : 0;
      return { q, bid, ask, buyEdge, sellEdge, edge: Math.max(buyEdge, sellEdge) };
    })
    .sort((a, b) => b.edge - a.edge);

  return (
    <div className="page">
      <header>
        <h1>Maker Arena</h1>
        <p className="lede">
          Herkesin her blokta market maker olabildiği onchain bir propAMM ligi. Fiyat sıçrayınca quote'lar bayatlar:
          maker <b>YENİLE</b>'ye, arbitrajcı <b>VUR</b>'a basar. Monad'da mempool yok. Yarışı blok sırası belirler.
        </p>
        <ol className="steps">
          <li>Face ID ya da misafir olarak gir</li>
          <li>Maker ol: spread seç, quote ver, bayatlayınca yenile</li>
          <li>Ya da arbitrajcı ol: bayat quote'ları vur</li>
        </ol>
      </header>

      <section className="stats">
        <Stat label="BTC/USD (demo, 25× volatilite)" value={fmtPx(price)} />
        <Stat label="Blok" value={head ? head.toString() : "—"} />
        <Stat label="Arena tx / sn" value={stats.tps.toFixed(1)} />
        <Stat label="Arena tx (bu oturum)" value={stats.total.toLocaleString()} />
        <Stat label="Oyuncu" value={players.toString()} />
        <Stat label="Kazanılan / kaçırılan vuruş" value={`${stats.fills} / ${stats.misses}`} />
      </section>

      {!ready ? (
        <section className="card join">
          <button className="primary" onClick={() => start("passkey")}>Face ID / Touch ID ile gir (Mera)</button>
          <button onClick={() => start("guest")}>Misafir olarak oyna</button>
          <p className="muted">{status || "Seed phrase yok, cüzdan eklentisi yok, her işlemde onay yok."}</p>
        </section>
      ) : (
        <div className="grid">
          <section className="card">
            <h2>Maker</h2>
            <label>Spread: {spread} bps<input type="range" min={2} max={100} value={spread} onChange={(e) => setSpread(+e.target.value)} /></label>
            <label>Boyut: {size.toFixed(2)} BTC<input type="range" min={0.05} max={1} step={0.05} value={size} onChange={(e) => setSize(+e.target.value)} /></label>
            <div className="row">
              <button onClick={() => act("setQuote", [spread, BigInt(Math.round(size * 1e8))], "quote")}>Quote ver</button>
              <button className={myStale ? "danger big" : "big"} disabled={!myQuote} onClick={() => act("refresh", [], "yenile")}>YENİLE</button>
            </div>
            {myQuote ? (
              <p className={myStale ? "stale" : "fresh"}>
                Mid {fmtPx(myQuote.mid)} · fark {myDrift > 0 ? "+" : ""}{myDrift} bps · {myStale ? "BAYAT: vurulabilirsin!" : "taze"} · yaş {myAge.toString()}/{QUOTE_TTL.toString()} blok
              </p>
            ) : (
              <p className="muted">Henüz quote yok.</p>
            )}
          </section>

          <section className="card">
            <h2>Arbitrajcı</h2>
            <table>
              <thead><tr><th>Maker</th><th>Bid</th><th>Ask</th><th>Kâr</th><th /></tr></thead>
              <tbody>
                {targets.slice(0, 8).map(({ q, bid, ask, buyEdge, sellEdge, edge }) => {
                  const takerBuys = buyEdge >= sellEdge;
                  const qty = q.size < 10_000_000n ? q.size : 10_000_000n;
                  return (
                    <tr key={q.maker}>
                      <td>{short(q.maker)}</td>
                      <td>{fmtPx(bid)}</td>
                      <td>{fmtPx(ask)}</td>
                      <td className={edge > 0 ? "fresh" : "muted"}>{edge > 0 ? `+${edge} bps` : "—"}</td>
                      <td>
                        <button className={edge > 0 ? "danger" : ""} disabled={edge <= 0}
                          onClick={() => act("hit", [q.maker, takerBuys, qty, takerBuys ? ask : bid], "vur")}>VUR</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted">{status}</p>
          </section>
        </div>
      )}

      <div className="grid">
        <section className="card">
          <h2>Yarış tablosu</h2>
          <p className="muted">Her satır onchain bir yarış. Quote hangi blokta bayatladı, vuruş kaç blok sonra geldi, maker yetişti mi?</p>
          <table>
            <thead><tr><th>Sonuç</th><th>Taker → Maker</th><th>Bayatladı</th><th>Vuruş</th><th>Gecikme</th></tr></thead>
            <tbody>
              {races.map(({ e, staleAt, refreshedFirst }) => (
                <tr key={`${e.hash}`}>
                  <td className={e.kind === "Fill" ? "stale" : "fresh"}>{e.kind === "Fill" ? "VURULDU" : "MAKER YETİŞTİ"}</td>
                  <td>{short(e.args.taker)} → {short(e.args.maker)}</td>
                  <td>{staleAt !== null ? `#${staleAt}` : refreshedFirst ? `yenilendi #${refreshedFirst.block}` : "—"}</td>
                  <td><a href={`${EXPLORER}/tx/${e.hash}`} target="_blank">#{e.block.toString()} · tx {e.txIndex}</a></td>
                  <td>{staleAt !== null ? `${(e.block - staleAt).toString()} blok ≈ ${Number(e.block - staleAt) * BLOCK_MS} ms` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Maker ligi (PnL, USD)</h2>
          <table>
            <tbody>
              {board.map((b, i) => (
                <tr key={b.who} className={b.who.toLowerCase() === me ? "me" : ""}>
                  <td>{i + 1}</td><td>{short(b.who)}{b.who.toLowerCase() === me ? " (sen)" : ""}</td>
                  <td className={b.pnl >= 0 ? "fresh" : "stale"}>{b.pnl >= 0 ? "+" : ""}{b.pnl.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {myTxs.length > 0 && (
            <>
              <h3>Senin işlemlerin</h3>
              <ul className="txs">
                {myTxs.map((t) => (
                  <li key={t.hash}><a href={`${EXPLORER}/tx/${t.hash}`} target="_blank">{t.label} · {short(t.hash)}</a></li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <footer className="muted">
        Monad testnet · kontrat <a href={`${EXPLORER}/address/${ARENA}`} target="_blank">{ARENA ? short(ARENA) : "—"}</a> · referans fiyat Binance BTC/USDT, hareketler demo için 25× büyütüldü · bot maker ve bir bot arbitrajcı arenayı canlı tutuyor
      </footer>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="v">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}
