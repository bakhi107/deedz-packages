// @ts-nocheck
import { network } from "hardhat";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAddress, isAddress } from "viem";

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const client = await viem.getPublicClient(); const [wallet] = await viem.getWalletClients();
const deed = await viem.getContractAt("contracts/final/Deed.sol:Deed", env("FINAL_DEED"));
const processor = await viem.getContractAt("FeeProcessor", env("FINAL_PROCESSOR"));
const rewards = await viem.getContractAt("StockRewards", env("FINAL_REWARDS"));
const exchange = await viem.getContractAt("TestExchange", env("FINAL_EXCHANGE"));
const liquidity = await viem.getContractAt("ProtocolLiquidityManager", env("FINAL_LIQUIDITY_MANAGER"));
if ((await processor.read.keeper()).toLowerCase() !== wallet.account.address.toLowerCase()) throw new Error("Configured key is not the keeper");

const block = await client.getBlock(); const last = await processor.read.lastCycleAt(); const interval = await processor.read.INTERVAL();
const fees = await processor.read.queuedTradingFees();
if (block.timestamp < last + interval) { console.log(`SKIP: cycle ready at ${last + interval}`); process.exit(0); }
if (fees === 0n) { console.log("SKIP: no trading fees queued"); process.exit(0); }

const groups = new Map<string, { ticker: `0x${string}`; tokens: { id: bigint; owner: `0x${string}` }[] }>();
const totalMinted = await deed.read.totalMinted();
for (let id = 1n; id <= totalMinted; ++id) {
  if (await deed.read.stateOf([id]) !== 1) continue;
  const [data, owner] = await Promise.all([deed.read.deedData([id]), deed.read.ownerOf([id])]);
  const ticker = data.ticker;
  if (!ticker) throw new Error(`Deed ${id}: ticker missing from deedData`);
  const key = ticker.toLowerCase(); const group = groups.get(key) ?? { ticker, tokens: [] };
  group.tokens.push({ id, owner }); groups.set(key, group);
}
const active = [...groups.values()].reduce((sum, group) => sum + group.tokens.length, 0);
if (active === 0) { console.log("SKIP: no Lit DEEDZ; fees remain queued"); process.exit(0); }

const rewardEth = fees * 70n / 100n; const firstBatch = await rewards.read.batchCount();
let allocatedEth = 0n; let nextBatch = firstBatch;
const allocations = []; const manifests = [];
const populated = [...groups.values()];
for (let index = 0; index < populated.length; ++index) {
  const group = populated[index];
  const ethAmount = index === populated.length - 1 ? rewardEth - allocatedEth : rewardEth * BigInt(group.tokens.length) / BigInt(active);
  allocatedEth += ethAmount;
  const rate = await exchange.read.stockPerEth([group.ticker]); const stockTotal = ethAmount * rate / 10n ** 18n;
  let allocatedStock = 0n;
  const values = group.tokens.map((token, tokenIndex) => {
    const amount = tokenIndex === group.tokens.length - 1 ? stockTotal - allocatedStock : stockTotal / BigInt(group.tokens.length);
    allocatedStock += amount; return [nextBatch.toString(), token.id.toString(), getAddress(token.owner), amount.toString()];
  });
  const tree = StandardMerkleTree.of(values, ["uint256", "uint256", "address", "uint256"]);
  const claims = [...tree.entries()].map(([leafIndex, value]) => ({ batchId: value[0], tokenId: value[1], account: value[2], amount: value[3], proof: tree.getProof(leafIndex) }));
  allocations.push({ ticker: group.ticker, ethAmount, minimumStockOut: stockTotal, merkleRoot: tree.root });
  manifests.push({ id: nextBatch.toString(), ticker: group.ticker, root: tree.root, claims }); nextBatch += 1n;
}

const hash = await processor.write.processCycle([allocations]);
const receipt = await client.waitForTransactionReceipt({ hash }); if (receipt.status !== "success") throw new Error(`Cycle failed: ${hash}`);
await reinvestLiquidity();
const path = resolve(process.cwd(), "keeper-data/rewards.json"); await mkdir(resolve(process.cwd(), "keeper-data"), { recursive: true });
let history = { chainId: 46630, rewards: rewards.address.toLowerCase(), batches: [] as any[] };
try { const stored = JSON.parse(await readFile(path, "utf8")); if (stored.rewards === history.rewards) history = stored; } catch {}
history.batches.push(...manifests.map((batch) => ({ ...batch, transaction: hash, createdAt: new Date().toISOString() })));
await writeFile(path, JSON.stringify(history, null, 2) + "\n");
console.log(`CYCLE_OK ${hash}; batches ${firstBatch}-${nextBatch - 1n}`);

function env(name: string) { const value = process.env[name]; if (!value || !isAddress(value)) throw new Error(`${name} missing`); return getAddress(value); }
async function reinvestLiquidity() {
  const eth = await client.getBalance({ address: liquidity.address }); if (eth < 1_000n) return;
  const token = await viem.getContractAt("RentToken", env("FINAL_RENT")); const rentBalance = await token.read.balanceOf([liquidity.address]); if (rentBalance === 0n) return;
  const block = await client.getBlock(); const tx = await liquidity.write.reinvest([eth / 2n, 1n, eth, rentBalance, 1n, block.timestamp + 900n]);
  const receipt = await client.waitForTransactionReceipt({ hash: tx }); if (receipt.status !== "success") throw new Error(`Liquidity reinvest failed: ${tx}`);
}
