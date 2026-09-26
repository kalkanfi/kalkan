import { createPublicClient, http, webSocket, parseAbi, encodeFunctionData, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { monadTestnet } from "viem/chains";
import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, createSecp256k1SigningSession } from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const SHIELD = import.meta.env.VITE_SHIELD_ADDRESS as Hex;
export const LIVE = import.meta.env.VITE_LIVE_ADDRESS as Hex; // Kalkan Live: real Chainlink USDC/USD trigger
export const SERVER = (import.meta.env.VITE_SERVER_URL as string) ?? "http://localhost:8787";
export const RPC = (import.meta.env.VITE_RPC_URL as string) ?? "https://testnet-rpc.monad.xyz";
export const WSS = (import.meta.env.VITE_WSS_URL as string) ?? "wss://testnet-rpc.monad.xyz";
export const EXPLORER = "https://testnet.monadvision.com";
export const ONE = 100_000_000n;
export const BLOCK_MS = 300;

export const abi = parseAbi([
  "function protect(uint64 trigger) returns (uint256)",
  "function evacuateMany(uint256[] ids) returns (uint256)",
  "function positions(uint256) view returns (address owner, uint64 trigger, bool open, bool demo, uint128 amount, uint128 safe, uint64 evacPrice, uint64 evacBlock)",
  "function positionCount() view returns (uint256)",
  "function price() view returns (uint64)",
  "function rewards(address) view returns (uint256)",
  "event Price(uint64 price)",
  "event Protected(uint256 indexed id, address indexed owner, uint64 trigger, uint128 amount, bool demo)",
  "event Evacuated(uint256 indexed id, address indexed owner, address indexed rescuer, uint64 price, uint128 safe)",
  "event Late(uint256 indexed id, address indexed rescuer)",
]);

export const liveAbi = parseAbi([
  "function protect(uint64 trigger) returns (uint256)",
  "function price() view returns (uint64)",
  "event Protected(uint256 indexed id, address indexed owner, uint64 trigger, uint128 amount)",
  "event Evacuated(uint256 indexed id, address indexed owner, address indexed rescuer, uint64 price, uint128 safe)",
  "event Late(uint256 indexed id, address indexed rescuer)",
]);

export const pub = createPublicClient({ chain: monadTestnet, transport: http(RPC), pollingInterval: 300 });
// Logs are pushed when a block is Proposed (~300 ms), much faster than polling.
export const live = createPublicClient({ chain: monadTestnet, transport: webSocket(WSS) });

// Monad charges the gas LIMIT, not gas used: fixed, measured limits per call.
const FEES = { maxFeePerGas: 150_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
export const gasFor = { protect: 150_000n, evacuateMany: (n: number) => 60_000n + 32_000n * BigInt(n) };

// ---------- Accounts: Mera passkey (Face ID / Touch ID) or guest key ----------
const CRED_KEY = "kalkan.credential";
const GUEST_KEY = "kalkan.guest";
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
      rp: { id: location.hostname, name: "Kalkan" },
      user: { name: `kalkan-${Date.now()}`, displayName: "Kalkan user" },
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
  async call(fn: "protect" | "evacuateMany", args: readonly unknown[], gas: bigint, to: Hex = SHIELD): Promise<Hex> {
    if (this.nonce === null) await this.sync();
    const nonce = this.nonce!;
    this.nonce = nonce + 1;
    const data = encodeFunctionData({ abi, functionName: fn, args } as never);
    const signed = await this.account.signTransaction!({
      chainId: monadTestnet.id, type: "eip1559", to, data, gas, nonce, ...FEES,
    });
    try {
      return await pub.sendRawTransaction({ serializedTransaction: signed });
    } catch (e) {
      await this.sync().catch(() => {});
      throw e;
    }
  }
}
