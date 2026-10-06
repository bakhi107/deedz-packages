// @ts-nocheck
import { artifacts } from "hardhat";
import { createPublicClient, createWalletClient, getContract, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, mkdirSync, existsSync, openSync, writeFileSync, closeSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { withRpcReadRetry } from "./rpc-read-retry.mjs";
import { planCycle, planSunday, planLiquidity, registerRewardClaims } from "./keeper.js";
import { createRewardJournal, waitForKeeperReceipt } from "../testnet-keeper-state.mjs";

const path = process.env.DEEDZ_STOCK_MANIFEST;
if (!path) throw Error("Set DEEDZ_STOCK_MANIFEST to the deployed suite manifest");
const manifest = JSON.parse(readFileSync(path, "utf8"));
if (manifest.status !== "deployed") throw Error("Deployment is incomplete");
const execute = process.env.DEEDZ_KEEPER_EXECUTE === "1";
const rpc = http(manifest.rpcUrl, { timeout: 20_000, retryCount: 2 });
const client = createPublicClient({ cacheTime: 0, transport: options => {
  const transport = rpc(options); return { ...transport, request: withRpcReadRetry(transport.request) };
} });
if (await client.getChainId() !== manifest.chainId || ![4663, 46630].includes(manifest.chainId)) throw Error("Wrong Robinhood chain");
if (manifest.fork || manifest.localChainId === 31337) throw Error("Refusing fork manifest on a live network");
if (manifest.chainId === 4663 && manifest.testnet) throw Error("Refusing testnet dependencies on mainnet");
const contract = async (name, key) => {
  const artifact = await artifacts.readArtifact(name), address = getAddress(manifest.contracts[key]);
  if (!await client.getCode({ address })) throw Error("Missing code: " + key);
  return getContract({ address, abi: artifact.abi, client });
};
const deed = await contract("contracts/final/Deed.sol:Deed", "deed"), processor = await contract("FeeProcessor", "processor"), rewards = await contract("StockRewards", "rewards"), adapter = await contract("PonsStockAdapter", "adapter"), treasury = await contract("RentTreasury", "treasury"), settlement = await contract("SundaySettlement", "settlement"), liquidity = await contract("ProtocolLiquidityManager", "liquidity"), router = await contract("TradingRouter", "router"), rent = await contract("RentToken", "rent");
const keeper = getAddress(await processor.read.keeper());
if (getAddress(await settlement.read.keeper()) !== keeper || getAddress(await treasury.read.keeper()) !== keeper || getAddress(await liquidity.read.executor()) !== keeper) throw Error("Keeper roles disagree");
if (getAddress(await processor.read.exchange()) !== adapter.address || getAddress(await settlement.read.exchange()) !== adapter.address) throw Error("Adapter wiring disagrees");
if (getAddress(await processor.read.rewards()) !== rewards.address || getAddress(await settlement.read.rewards()) !== rewards.address) throw Error("Rewards wiring disagrees");
let wallet;
if (execute) {
  const key = process.env.DEEDZ_KEEPER_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!key) throw Error("Missing keeper key");
  const account = privateKeyToAccount(key);
  if (getAddress(account.address) !== keeper) throw Error("Signer is not current keeper");
  wallet = createWalletClient({ account, transport: http(manifest.rpcUrl) });
}
const directory = resolve(process.env.DEEDZ_KEEPER_DATA ?? "keeper-data/stock");
const historyPath = resolve(directory, "rewards.json"), lock = resolve(directory, "keeper.lock");
mkdirSync(directory, { recursive: true });
const fd = openSync(lock, "wx"); writeFileSync(fd, String(process.pid));
const journal = createRewardJournal({ rewardsAddress: rewards.address, chainId: manifest.chainId, directory });
const slippage = Number(process.env.DEEDZ_SLIPPAGE_BPS ?? 50);
async function send(c, functionName, args) {
  const simulation = await client.simulateContract({ address: c.address, abi: c.abi, functionName, args, account: keeper });
  const hash = await wallet.writeContract({ ...simulation.request, account: wallet.account, chain: null });
  if ((await waitForKeeperReceipt(client, hash)).status !== "success") throw Error("Transaction reverted: " + hash);
  console.log("CONFIRMED " + functionName + " " + hash);
}
async function register() {
  if (!execute || !existsSync(historyPath)) return;
  const history = JSON.parse(readFileSync(historyPath, "utf8"));
  if (history.chainId !== manifest.chainId || history.rewards !== rewards.address.toLowerCase()) throw Error("Reward history identity mismatch");
  await registerRewardClaims(rewards, history.batches, send);
}
async function processPlan(target, functionName, plan) {
  if (plan.skip) { console.log("SKIP: " + plan.skip); return; }
  const simulation = await client.simulateContract({ address: target.address, abi: target.abi, functionName, args: plan.args, account: keeper });
  console.log(JSON.stringify({ mode: plan.kind, execute, batches: plan.manifests.length, outputs: simulation.result }, (_, v) => typeof v === "bigint" ? v.toString() : v));
  if (!execute) return;
  const hash = await journal.execute({ client, rewards,
    batches: plan.manifests.map(batch => ({ ...batch, snapshotBlock: plan.snapshotBlock })),
    submit: () => wallet.writeContract({ ...simulation.request, account: wallet.account, chain: null }),
  });
  console.log("STOCK_CYCLE_CONFIRMED " + hash);
  await register();
}
try {
  // Simulation mode never broadcasts or changes pending transaction state.
  if (execute) { await journal.recover(client, rewards); await register(); }
  const mode = process.env.DEEDZ_KEEPER_ACTION ?? "cycle";
  if (mode === "cycle") await processPlan(processor, "processStockCycle", await planCycle(client, deed, processor, rewards, adapter, slippage));
  else if (mode === "sunday") {
    const current = await treasury.read.weekOf([(await client.getBlock()).timestamp]);
    if (current === 0n) console.log("SKIP: First week still active");
    const first = process.env.DEEDZ_SETTLE_WEEK === undefined ? 0n : BigInt(process.env.DEEDZ_SETTLE_WEEK);
    const end = process.env.DEEDZ_SETTLE_WEEK === undefined ? current : first + 1n;
    if (first < 0n || (process.env.DEEDZ_SETTLE_WEEK !== undefined && first >= current)) throw Error("Week has not ended");
    for (let week = first; week < end; week++) {
      if (await settlement.read.settled([week])) continue;
      if (execute && !await treasury.read.weekFinalized([week])) {
        const count = await treasury.read.positionCount();
        while (await treasury.read.checkpointCursor([week]) < count) await send(treasury, "checkpointWeek", [week, 250n]);
        await send(treasury, "finalizeWeek", [week]);
      }
      await processPlan(settlement, "settleStocks", await planSunday(client, deed, treasury, settlement, rewards, adapter, week, slippage));
    }
  } else throw Error("Unknown keeper action");
  if (execute) {
    const lp = await planLiquidity(client, liquidity, router, rent, keeper, slippage);
    if (!lp.skip) await send(liquidity, "reinvest", lp.args);
  }
} finally { closeSync(fd); unlinkSync(lock); }
