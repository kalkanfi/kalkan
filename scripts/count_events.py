# Count Arena events over the last N blocks: python3 scripts/count_events.py [blocks]
import json, os, subprocess, sys, collections, urllib.request
R = os.environ["RPC_URL"]; A = os.environ["ARENA_ADDRESS"]
N = int(sys.argv[1]) if len(sys.argv) > 1 else 300
def rpc(m, p):
    r = subprocess.run(["curl", "-s", "-X", "POST", "-H", "Content-Type: application/json",
        "--data", json.dumps({"jsonrpc": "2.0", "id": 1, "method": m, "params": p}), R], capture_output=True, text=True)
    return json.loads(r.stdout)["result"]
sigs = {"Price": "Price(uint64)", "Quote": "Quote(address,uint64,uint32,uint64)",
        "Fill": "Fill(address,address,bool,uint64,uint64,uint64)", "Miss": "Miss(address,address,bool,uint64,uint64)",
        "Registered": "Registered(address)"}
t2n = {subprocess.run(["cast", "keccak", v], capture_output=True, text=True).stdout.strip(): k for k, v in sigs.items()}
h = int(rpc("eth_blockNumber", []), 16)
c = collections.Counter(); ex = {}
for s in range(h - N, h, 100):
    for l in rpc("eth_getLogs", [{"address": A, "fromBlock": hex(s), "toBlock": hex(min(s + 99, h))}]):
        k = t2n.get(l["topics"][0], "?"); c[k] += 1; ex[k] = l["transactionHash"]
print(f"last {N} blocks:", dict(c))
for k, v in ex.items(): print(f"  example {k}: https://testnet.monadvision.com/tx/{v}")
