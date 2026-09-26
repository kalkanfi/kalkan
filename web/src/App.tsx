import { useEffect, useRef, useState } from "react";
import type { Hex, LocalAccount } from "viem";
import { formatEther } from "viem";
import { SHIELD, LIVE, SERVER, EXPLORER, BLOCK_MS, abi, liveAbi, pub, live, gasFor, passkeyAccount, guestAccount, Sender } from "./chain";
import "./App.css";

type Row = { id: string; owner: string; rescuer: string; price: string; block: string; latency: number | null; demo: boolean; trigger?: string };
type Status = {
  state: "idle" | "seeding" | "crash" | "bottom" | "recovery";
  price: string;
  head: string;
  depegBlock: string | null;
  bottom: string;
  evacuated: number;
  stillOpen: number;
  latency: { avg: number | null; min: number | null; max: number | null };
  maxPerBlock: number;
  blocksUsed: number;
  savedUsd: number;
  late: number;
  rescuers: string[];
  open: [string, string][];
  recent: Row[];
  cooldownMs: number;
  avgEvacPrice: number | null;
  record: { evacuatedInTx: number; block: string; tx: string } | null;
};
type Mine = { id: string; trigger: string; open: boolean; evacPrice?: string; evacBlock?: string; safe?: string; rescuer?: string };
type Notice = { id: number; tone: "win" | "lose" | "info" | "warn"; title: string; text: string; hash?: Hex };

const px = (p?: string | bigint | null, d = 4) => (p == null ? "—" : (Number(p) / 1e8).toFixed(d));
const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const STATE: Record<Status["state"], string> = {
  idle: "Normal · USDX dolara sabit",
  seeding: "Stres testi hazırlanıyor…",
  crash: "💥 DEPEG! Fiyat blok blok düşüyor",
  bottom: "Dip · 0,87 $",
  recovery: "Toparlanıyor",
};

export default function App() {
  const [st, setSt] = useState<Status | null>(null);
  const [account, setAccount] = useState<LocalAccount | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("");
  const [trigger, setTrigger] = useState(0.99);
  const [mine, setMine] = useState<Mine[]>([]);
  const [earned, setEarned] = useState(0);
  const [notices, setNotices] = useState<Notice[]>([]);
  const sender = useRef<Sender | null>(null);
  const meRef = useRef<string | null>(null);
  const [crashAt, setCrashAt] = useState<number | null>(null);
  const [livePx, setLivePx] = useState<bigint | null>(null);
  const [liveTrigger, setLiveTrigger] = useState(0.9999);
  const [liveMine, setLiveMine] = useState<Mine[]>([]);
  useEffect(() => {
    if (!LIVE) return;
    const load = () => pub.readContract({ address: LIVE, abi: liveAbi, functionName: "price" }).then(setLivePx).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (st?.state === "crash" && crashAt === null) setCrashAt(Date.now());
    if (st?.state === "seeding") setCrashAt(null);
  }, [st?.state]);

  const notify = (n: Omit<Notice, "id">) => setNotices((prev) => [{ ...n, id: Date.now() + Math.random() }, ...prev].slice(0, 4));

  // ---------- Scenario stats (the server mirrors the chain) ----------
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`${SERVER}/status`);
        if (r.ok) setSt(await r.json());
      } catch {}
      if (!stop) setTimeout(tick, 700);
    };
    tick();
    return () => {
      stop = true;
    };
  }, []);

  // ---------- My positions ----------
  useEffect(() => {
    if (!account) return;
    const load = () =>
      fetch(`${SERVER}/mine?owner=${account.address}`)
        .then((r) => r.json())
        .then(setMine)
        .catch(() => {});
    const loadLive = () =>
      fetch(`${SERVER}/mine?owner=${account.address}&live=1`)
        .then((r) => r.json())
        .then(setLiveMine)
        .catch(() => {});
    load();
    loadLive();
    const id2 = setInterval(loadLive, 2000);
    const id = setInterval(load, 1500);
    return () => {
      clearInterval(id);
      clearInterval(id2);
    };
  }, [account]);

  // ---------- Personal results straight from chain events (WebSocket) ----------
  useEffect(() => {
    let unwatch = () => {};
    try {
      unwatch = live.watchContractEvent({
        address: SHIELD,
        abi,
        onError: () => {},
        onLogs: (logs: any[]) => {
          const me = meRef.current;
          if (!me) return;
          const byTx = new Map<string, any[]>();
          for (const l of logs) byTx.set(l.transactionHash, [...(byTx.get(l.transactionHash) ?? []), l]);
          for (const [hash, ls] of byTx) {
            for (const l of ls)
              if (l.eventName === "Evacuated" && l.args.owner.toLowerCase() === me)
                notify({
                  tone: "win", title: "KURTARILDIN! 🛡️", hash: hash as Hex,
                  text: `Pozisyon #${l.args.id}, ${px(l.args.price, 3)} fiyatından güvenli varlığa geçti: ${usd(Number(l.args.safe) / 1e8)} korundu. Blok #${l.blockNumber}, kurtaran ${short(l.args.rescuer)}.`,
                });
            const saved = ls.filter((l) => l.eventName === "Evacuated" && l.args.rescuer.toLowerCase() === me).length;
            const late = ls.filter((l) => l.eventName === "Late" && l.args.rescuer.toLowerCase() === me).length;
            if (saved) {
              setEarned((e) => e + saved * 5);
              notify({ tone: "win", title: `${saved} POZİSYON KURTARDIN! +$${saved * 5}`, hash: hash as Hex,
                text: `Blok #${ls[0].blockNumber}: ${saved} kişinin parası senin işleminle güvene alındı.${late ? ` ${late} pozisyona başka kurtarıcı senden önce yetişti.` : ""}` });
            } else if (late) {
              notify({ tone: "lose", title: "GEÇ KALDIN", hash: hash as Hex,
                text: `${late} pozisyonu başka kurtarıcılar senden önce kurtardı. Denemen blok #${ls[0].blockNumber}'da zincire yazıldı. Bir sonraki fiyat düşüşünde tekrar dene.` });
            }
          }
        },
      });
    } catch {}
    let unwatchLive = () => {};
    try {
      if (LIVE)
        unwatchLive = live.watchContractEvent({
          address: LIVE,
          abi: liveAbi,
          eventName: "Evacuated",
          onError: () => {},
          onLogs: (logs: any[]) => {
            for (const l of logs)
              if (meRef.current && l.args.owner.toLowerCase() === meRef.current)
                notify({
                  tone: "win", title: "GERÇEK FİYATLA KURTARILDIN! 🛡️", hash: l.transactionHash,
                  text: `Canlı pozisyon #${l.args.id}, Chainlink USDC/USD fiyatı ${px(l.args.price, 5)} $ ile güvene alındı (blok #${l.blockNumber}). Bu sefer fiyatı kimse yazmadı: kontrat Chainlink'i kendisi okudu.`,
                });
          },
        });
    } catch {}
    return () => {
      unwatch();
      unwatchLive();
    };
  }, []);

  // ---------- Onboarding ----------
  async function start(kind: "passkey" | "guest") {
    try {
      setStatus(kind === "passkey" ? "Passkey bekleniyor…" : "Misafir hesabı hazırlanıyor…");
      const acct = kind === "passkey" ? await passkeyAccount() : guestAccount();
      setAccount(acct);
      meRef.current = acct.address.toLowerCase();
      sender.current = new Sender(acct);
      let bal = await pub.getBalance({ address: acct.address });
      if (bal < 50_000_000_000_000_000n) {
        setStatus("Test MON gönderiliyor…");
        await fetch(`${SERVER}/fund`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: acct.address }) });
        for (let i = 0; i < 30 && bal < 50_000_000_000_000_000n; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          bal = await pub.getBalance({ address: acct.address });
        }
        await new Promise((r) => setTimeout(r, 1200)); // Monad: newly funded accounts wait ~3 blocks before sending
      }
      setStatus(`Hazır · ${Number(formatEther(bal)).toFixed(2)} MON`);
      setReady(true);
    } catch (e: any) {
      const msg = String(e?.code ?? e?.message ?? e);
      setStatus(msg.includes("PRF") ? "Bu tarayıcı passkey PRF desteklemiyor. Misafir olarak devam et." : `Hata: ${msg.slice(0, 120)}`);
    }
  }

  async function protect() {
    if (!sender.current) return;
    try {
      setStatus("Kalkan açılıyor…");
      const t = BigInt(Math.round(trigger * 1e8));
      const hash = await sender.current.call("protect", [t], gasFor.protect);
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 15_000 });
      setStatus("");
      notify(
        r.status === "success"
          ? { tone: "info", title: "KALKAN AÇIK", hash, text: `10.000 USDX korumada. USDX ${trigger.toFixed(3)} $'ın altına düşerse pozisyonun otomatik olarak güvene alınacak. Şimdi "Depeg simüle et"e bas.` }
          : { tone: "warn", title: "İŞLEM REVERT OLDU", hash, text: "Tekrar dene." },
      );
    } catch (e: any) {
      setStatus(`Tx hatası: ${(e?.shortMessage ?? e?.message ?? "").slice(0, 100)}`);
    }
  }

  async function protectLive() {
    if (!sender.current || !LIVE) return;
    try {
      setStatus("Canlı kalkan açılıyor…");
      const t = BigInt(Math.round(liveTrigger * 1e8));
      const hash = await sender.current.call("protect", [t], gasFor.protect, LIVE);
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 15_000 });
      setStatus("");
      const above = livePx !== null && t > livePx;
      notify(
        r.status === "success"
          ? { tone: "info", title: "CANLI KALKAN AÇIK", hash,
              text: above
                ? `Tetiğin (${liveTrigger.toFixed(4)}) gerçek USDC fiyatının (${px(livePx, 5)}) üstünde: kurtarıcılar birkaç saniye içinde seni gerçek Chainlink fiyatından çıkaracak.`
                : `Gerçek USDC ${liveTrigger.toFixed(4)} $'ın altına düşerse, gerçek dünyadaki bir depeg'de herkes seni kurtarabilir.` }
          : { tone: "warn", title: "İŞLEM REVERT OLDU", hash, text: "Tekrar dene." },
      );
    } catch (e: any) {
      setStatus(`Tx hatası: ${(e?.shortMessage ?? e?.message ?? "").slice(0, 100)}`);
    }
  }

  async function rescue() {
    if (!sender.current || !st) return;
    const price = BigInt(st.price);
    const due = st.open.filter(([, t]) => price < BigInt(t)).map(([id]) => BigInt(id)).slice(0, 25);
    if (!due.length) return notify({ tone: "info", title: "KURTARILACAK POZİSYON YOK", text: "Fiyat henüz kimsenin tetiğinin altına inmedi. Depeg başlayınca tekrar bas." });
    try {
      setStatus(`${due.length} pozisyon için kurtarma gönderildi…`);
      await sender.current.call("evacuateMany", [due], gasFor.evacuateMany(due.length));
    } catch (e: any) {
      setStatus(`Tx hatası: ${(e?.shortMessage ?? e?.message ?? "").slice(0, 100)}`);
    }
  }

  async function depeg() {
    try {
      const r = await fetch(`${SERVER}/scenario`, { method: "POST" });
      if (!r.ok) notify({ tone: "info", title: "BİRAZ BEKLE", text: "Bir stres testi zaten çalışıyor, yeni bitti ya da testnet bütçesi dolmak üzere. Bir dakika sonra tekrar dene." });
    } catch {}
  }

  const price = st ? BigInt(st.price) : null;
  const danger = price !== null && price < 100_000_000n;
  const due = st && price !== null ? st.open.filter(([, t]) => price < BigInt(t)).length : 0;
  const me = account?.address.toLowerCase();
  const lat = st?.latency.avg;

  return (
    <div className="page">
      <header>
        <h1>🛡️ Kalkan</h1>
        <p className="lede">
          Stablecoin depeg olduğunda paranı <b>1 saniyenin altında</b> güvene alan protokol. Bir tetik seçersin. Fiyat onun altına
          düştüğü an <b>herkes</b> seni kurtarabilir ve ödül alır. Monad'ın 300 ms'lik bloklarında kurtarıcılar yarışır, sen ekran başında olmasan bile.
        </p>
      </header>

      <section className={`hero ${danger ? "danger" : ""}`}>
        <div>
          <div className="big">USDX {px(st?.price)} $</div>
          <div className="muted">{st ? STATE[st.state] : "Bağlanıyor…"}</div>
        </div>
        <button className="crash" disabled={!st || st.state !== "idle" || st.cooldownMs > 0} onClick={depeg}>
          💥 Depeg simüle et
        </button>
      </section>

      <section className="vs">
        <div className="col monad">
          <h3>Monad (canlı, onchain)</h3>
          <div className="row2"><span>Blok süresi</span><b>0,3 sn</b></div>
          <div className="row2"><span>Tetikten tahliyeye</span><b>{lat != null ? `${Math.round(lat * BLOCK_MS)} ms` : "—"}</b></div>
          <div className="row2"><span>Ortalama tahliye fiyatı</span><b>{st?.avgEvacPrice ? px(String(Math.round(st.avgEvacPrice)), 3) : "—"} $</b></div>
          <div className="row2"><span>Kurtarılan değer</span><b className="fresh">{st ? usd(st.savedUsd) : "—"}</b></div>
        </div>
        <div className="col eth">
          <h3>Aynı depeg Ethereum'da (model)</h3>
          <div className="row2"><span>Blok süresi</span><b>12 sn</b></div>
          <div className="row2"><span>İlk çıkış en erken</span><b>
            {crashAt && st && st.state !== "idle"
              ? now - crashAt < 12_000 ? `${((12_000 - (now - crashAt)) / 1000).toFixed(1)} sn kaldı…` : "12 sn (fiyat dipte)"
              : "12.000 ms"}
          </b></div>
          <div className="row2"><span>O anki fiyat</span><b>0,870 $ (dip)</b></div>
          <div className="row2"><span>Kurtarılan değer</span><b className="stale">≈ $0</b></div>
        </div>
      </section>
      {st?.record?.evacuatedInTx ? (
        <p className="record">
          🏆 Sınır testi: <b>{st.record.evacuatedInTx} kişi tek işlemde, tek blokta</b> kurtarıldı (blok #{st.record.block}).{" "}
          <a href={`${EXPLORER}/tx/${st.record.tx}`} target="_blank">explorer ↗</a>
        </p>
      ) : (
        <p className="record">
          🏆 Sınır testi: <b>500 kişi tek işlemde, tek blokta</b> kurtarıldı (blok #65826682).{" "}
          <a href={`${EXPLORER}/tx/0x7b099e5b26643abb1220c0ed37d36abbeae7a9f8712d0af9787b457d1e3d810f`} target="_blank">explorer ↗</a>
        </p>
      )}

      <section className="stats">
        <Stat label="Tahliye edilen pozisyon" value={st ? String(st.evacuated) : "—"} />
        <Stat label="Tetikten tahliyeye ort." value={lat != null ? `${lat.toFixed(1)} blok ≈ ${Math.round(lat * BLOCK_MS)} ms` : "—"} />
        <Stat label="Tek blokta en çok tahliye" value={st ? String(st.maxPerBlock) : "—"} />
        <Stat label="Kurtarılan değer (dibe göre)" value={st ? usd(st.savedUsd) : "—"} />
        <Stat label="Geç kalan kurtarıcı denemesi" value={st ? String(st.late) : "—"} />
        <Stat label="Şu an risk altında" value={String(due)} />
      </section>

      {!ready ? (
        <section className="card join">
          <button className="primary" onClick={() => start("passkey")}>Face ID / Touch ID ile gir (Mera)</button>
          <button onClick={() => start("guest")}>Misafir olarak gir</button>
          <p className="muted">{status || "Seed phrase yok, cüzdan eklentisi yok, her işlemde onay yok. İzlemek için giriş gerekmiyor."}</p>
        </section>
      ) : (
        <>
          <section className={`result ${notices[0]?.tone ?? "idle"}`}>
            {notices[0] ? (
              <>
                <div className="rt">{notices[0].title}</div>
                <div className="rx">
                  {notices[0].text} {notices[0].hash && <a href={`${EXPLORER}/tx/${notices[0].hash}`} target="_blank">explorer ↗</a>}
                </div>
                {notices.slice(1).map((n) => (
                  <div key={n.id} className={`rprev ${n.tone}`}>{n.title}</div>
                ))}
              </>
            ) : (
              <div className="rx">1) Kalkanını aç → 2) <b>Depeg simüle et</b>'e bas → 3) Paranın blok blok kurtarılmasını izle ya da kurtarıcı olup başkalarını kurtar.</div>
            )}
          </section>
          <div className="grid">
            <section className="card">
              <h2>1 · Paranı koru</h2>
              <label>
                Tetik: USDX <b>{trigger.toFixed(3)} $</b>'ın altına düşerse beni çıkar
                <input type="range" min={0.95} max={0.999} step={0.001} value={trigger} onChange={(e) => setTrigger(+e.target.value)} />
              </label>
              <button className="primary wide" onClick={protect}>Kalkanı aç (10.000 USDX)</button>
              {mine.length > 0 && (
                <table>
                  <tbody>
                    {mine.slice(0, 5).map((m) => (
                      <tr key={m.id}>
                        <td>#{m.id}</td>
                        <td>tetik {px(m.trigger, 3)}</td>
                        <td className={m.open ? "muted" : "fresh"}>
                          {m.open ? "korumada" : `kurtarıldı @ ${px(m.evacPrice, 3)} · blok #${m.evacBlock}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="muted hint">Bakiyeler testnet'te sanal. Mekanizma gerçek tokenlarla aynı çalışır.</p>
            </section>

            <section className="card">
              <h2>2 · Kurtarıcı ol</h2>
              <p>
                Şu an <b>{due}</b> pozisyon tetiğinin altında. Onları kurtar, pozisyon başına <b>$5</b> ödül kazan.
              </p>
              <button className={due > 0 ? "danger wide" : "wide"} onClick={rescue}>🚑 Kurtar ({due})</button>
              <p className="muted">Kazandığın ödül: ${earned}</p>
              <p className="muted hint">2 kurtarıcı bot da yarışıyor. Mempool olmadığı için kimse senin işlemini görüp önüne geçemez. Kazananı blok sırası belirler.</p>
              <p className="muted">{status}</p>
            </section>
          </div>
          {LIVE && (
            <section className="card live">
              <h2>3 · Canlı mod: gerçek USDC fiyatı (Chainlink)</h2>
              <p>
                Burada fiyatı kimse yazmıyor. Kalkan Live, Monad testnet'teki gerçek <b>Chainlink USDC/USD</b> feed'ini okuyor. Şu an:{" "}
                <b>{px(livePx, 5)} $</b>. Tetiği bu fiyatın üstüne koyarsan, kurtarma yolunun gerçek oracle ile uçtan uca çalıştığını
                birkaç saniyede görürsün.
              </p>
              <label>
                Tetik: <b>{liveTrigger.toFixed(4)} $</b>
                <input type="range" min={0.995} max={0.99999} step={0.00001} value={liveTrigger} onChange={(e) => setLiveTrigger(+e.target.value)} />
              </label>
              <button className="primary wide" onClick={protectLive}>Gerçek fiyata karşı koru</button>
              {liveMine.length > 0 && (
                <table>
                  <tbody>
                    {liveMine.slice(0, 3).map((m) => (
                      <tr key={m.id}>
                        <td>canlı #{m.id}</td>
                        <td>tetik {px(m.trigger, 4)}</td>
                        <td className={m.open ? "muted" : "fresh"}>{m.open ? "korumada" : `kurtarıldı @ ${px(m.evacPrice, 5)} · blok #${m.evacBlock}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="muted hint">
                Kontrat: <a href={`${EXPLORER}/address/${LIVE}`} target="_blank">{short(LIVE)}</a> · feed:{" "}
                <a href={`${EXPLORER}/address/0x39820e7965e29DC86b94F20eD04e9c5cCf9aFf95`} target="_blank">Chainlink USDC/USD</a>
              </p>
            </section>
          )}
        </>
      )}

      <section className="card">
        <h2>Son tahliyeler (onchain)</h2>
        <p className="muted">
          {st?.depegBlock ? `Depeg #${st.depegBlock} bloğunda başladı. ` : ""}Tepki = pozisyonun tetiği geçildikten kaç blok sonra kurtarıldığı.
        </p>
        <table>
          <thead>
            <tr><th>Pozisyon</th><th className="hide-sm">Tetik</th><th>Fiyat</th><th>Blok</th><th>Tepki</th><th className="hide-sm">Kurtaran</th></tr>
          </thead>
          <tbody>
            {(st?.recent ?? []).slice(0, 15).map((r) => (
              <tr key={r.id} className={r.owner.toLowerCase() === me ? "me" : ""}>
                <td>#{r.id} {r.owner.toLowerCase() === me ? "(sen)" : r.demo ? <span className="muted">demo</span> : ""}</td>
                <td className="hide-sm">{px(r.trigger, 3)}</td>
                <td>{px(r.price, 3)}</td>
                <td><a href={`${EXPLORER}/block/${r.block}`} target="_blank">#{r.block}</a></td>
                <td className="fresh">{r.latency != null ? `${r.latency} blok ≈ ${r.latency * BLOCK_MS} ms` : "—"}</td>
                <td className="hide-sm">{r.rescuer.toLowerCase() === me ? "sen" : st?.rescuers.map((x) => x.toLowerCase()).includes(r.rescuer.toLowerCase()) ? "bot" : short(r.rescuer)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <footer className="muted">
        Monad testnet · kontrat <a href={`${EXPLORER}/address/${SHIELD}`} target="_blank">{SHIELD ? short(SHIELD) : "—"}</a> · depeg bir stres testi
        simülasyonudur (fiyat 1,00'dan 0,87'ye blok blok iner) · "demo" pozisyonlar yük testi içindir · 2 kurtarıcı bot aynı kurallarla yarışır
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
