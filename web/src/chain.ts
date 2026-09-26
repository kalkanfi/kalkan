import { createPublicClient, http, parseAbi, encodeFunctionData, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, createSecp256k1SigningSession } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const ARENA = import.meta.env.VITE_ARENA_ADDRESS as Hex;
export const SERVER = (import.meta.env.VITE_SERVER_URL as string) ?? "http://localhost:8787";
export const RPC = (import.meta.env.VITE_RPC_URL as string) ?? "https://testnet-rpc.monad.xyz";
export const EXPLORER = "https://testnet.monadvision.com";
export const ONE = 100_000_000n;
export const QUOTE_TTL = 100n;
export const BLOCK_MS = 300;

export const abi = parseAbi([
  "function register()",
  "function setQuote(uint32 spreadBps, uint64 size)",
  "function refresh()",
  "function hit(address maker, bool takerBuys, uint64 qty, uint64 limitPrice) returns (bool)",
  "function players(address) view returns (int128 usd, int128 base, uint64 mid, uint32 spreadBps, uint64 size, uint64 refreshedAt, bool registered)",
  "function price() view returns (uint64)",
  "function playerCount() view returns (uint256)",
  "function equityOf(address) view returns (int256)",
  "event Registered(address indexed player)",
  "event Price(uint64 price)",
  "event Quote(address indexed maker, uint64 mid, uint32 spreadBps, uint64 size)",
  "event Fill(address indexed maker, address indexed taker, bool takerBuys, uint64 qty, uint64 execPrice, uint64 oraclePrice)",
  "event Miss(address indexed maker, address indexed taker, bool takerBuys, uint64 quotePrice, uint64 limitPrice)",
]);

export const pub = createPublicClient({ chain: monadTestnet, transport: http(RPC) });

// Monad charges the gas limit, not gas used: fixed, measured limits per call.
const GAS: Record<string, bigint> = { register: 120_000n, setQuote: 90_000n, refresh: 80_000n, hit: 110_000n };
const FEES = { maxFeePerGas: 150_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

// ---------- Accounts: Mera passkey (Face ID / Touch ID) or guest key ----------
const CRED_KEY = "arena.credential";
const GUEST_KEY = "arena.guest";
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

function deriveEvmKey(prfOutput: Uint8Array, index = 0): Uint8Array {
  const seed = mnemonicToSeedSync(entropyToMnemonic(prfOutput, wordlist));
  const node = HDKey.fromMasterSeed(seed).derive(`m/44'/60'/0'/0/${index}`);
  if (!node.privateKey) throw new Error("derivation produced no key");
  return node.privateKey;
}

export async function passkeyAccount(): Promise<LocalAccount> {
  const stored = store.get(CRED_KEY);
  let prf: Uint8Array;
  if (stored) {
    const known = JSON.parse(stored);
    const r = await getPasskeyPrfOutput({ rpId: location.hostname, credential: known });
    prf = r.prfOutput;
    store.set(CRED_KEY, JSON.stringify(known?.credentialId === r.credentialId ? known : { credentialId: r.credentialId }));
  } else {
    const c = await createPasskeyWithPrfOutput({
      rp: { id: location.hostname, name: "Maker Arena" },
      user: { name: `maker-${Date.now()}`, displayName: "Arena Maker" },
    });
    prf = c.prfOutput;
    store.set(CRED_KEY, JSON.stringify({ credentialId: c.credentialId, transports: c.transports }));
  }
  const session = createSecp256k1SigningSession({ privateKey: deriveEvmKey(prf) });
  return toViemAccount(session) as LocalAccount;
}

export function guestAccount(): LocalAccount {
  let pk = store.get(GUEST_KEY) as Hex | null;
  if (!pk) {
    pk = generatePrivateKey();
    store.set(GUEST_KEY, pk);
  }
  return privateKeyToAccount(pk);
}

// ---------- Sender: local nonce, sign in the browser, no wallet popups ----------
export class Sender {
  nonce: number | null = null;
  account: LocalAccount;
  constructor(account: LocalAccount) {
    this.account = account;
  }
  async sync() {
    this.nonce = await pub.getTransactionCount({ address: this.account.address, blockTag: "latest" });
  }
  async call(fn: "register" | "setQuote" | "refresh" | "hit", args: readonly unknown[] = []): Promise<Hex> {
    if (this.nonce === null) await this.sync();
    const nonce = this.nonce!;
    this.nonce = nonce + 1;
    const data = encodeFunctionData({ abi, functionName: fn, args } as never);
    const signed = await this.account.signTransaction!({
      chainId: monadTestnet.id, type: "eip1559", to: ARENA, data, gas: GAS[fn], nonce, ...FEES,
    });
    try {
      return await pub.sendRawTransaction({ serializedTransaction: signed });
    } catch (e) {
      await this.sync().catch(() => {});
      throw e;
    }
  }
}
