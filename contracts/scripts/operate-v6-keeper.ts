// @ts-nocheck -- Hardhat's viem augmentation is generated during compilation.
import { network } from "hardhat";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const manifestSetting = process.env.V6_CANDIDATE_MANIFEST;
if (!manifestSetting) throw new Error("Set V6_CANDIDATE_MANIFEST");
const manifest = JSON.parse(await readFile(resolve(process.cwd(), manifestSetting), "utf8"));
if (!String(manifest.status).startsWith("candidate-launched")) throw new Error("Keeper refuses to operate an unlaunched release");
const networkName = manifest.chainId === 4663 ? "robinhoodMainnet" : manifest.chainId === 46630 ? "robinhoodTestnet" : undefined;
if (!networkName) throw new Error("Unsupported chain");
const { viem } = await network.create({ network: networkName, chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
if (wallet.account.address.toLowerCase() !== manifest.governance.keeper.toLowerCase()) throw new Error("Keeper key does not match the manifest");
if (await publicClient.getChainId() !== manifest.chainId) throw new Error("RPC chain mismatch");

async function wait(hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Keeper transaction failed: ${hash}`);
  return hash;
}
const c = manifest.contracts;
const vault = await viem.getContractAt("RentVaultV6", c.vault);
const index = await viem.getContractAt("RentIndexV6", await vault.read.rentIndex());
const ledger = await viem.getContractAt("RentLedgerV6", c.ledger);
const jackpot = await viem.getContractAt("JackpotV6", c.jackpot);
const emitter = await viem.getContractAt("RentEmitterV6", c.emitter);
const buyer = await viem.getContractAt("StockBuyerV6", c.stockBuyer);
const thronePool = await viem.getContractAt("ThronePoolV6", c.thronePool);
const transactions: string[] = [];
transactions.push(await wait(await index.write.sync()));

const now = (await publicClient.getBlock()).timestamp;
const currentWeek = await ledger.read.weekOf([now]);
const maxWeeks = Math.max(1, Math.min(16, Number(process.env.V6_MAX_WEEKS_PER_RUN ?? "4")));
let processed = 0;
while (processed < maxWeeks) {
  const week = await emitter.read.nextWeek();
  if (week >= currentWeek) break;
  while (!(await ledger.read.sealedWeek([week]))) {
    const before = await vault.read.weekCursor([week]);
    transactions.push(await wait(await vault.write.checkpointWeek([week, 100n])));
    const after = await vault.read.weekCursor([week]);
    if (after === before && !(await ledger.read.sealedWeek([week]))) throw new Error(`Week ${week} settlement made no progress`);
  }
  if (await jackpot.read.nextWeek() === week) transactions.push(await wait(await jackpot.write.settleWeek()));
  transactions.push(await wait(await emitter.write.finalizeWeek()));
  ++processed;
}

transactions.push(await wait(await buyer.write.pullAndAllocateTradingFees()));
transactions.push(await wait(await thronePool.write.checkpoint()));
console.log("V6_KEEPER_CHECKPOINT_COMPLETE");
console.log(`Processed weeks: ${processed}`);
console.log(`Transactions: ${transactions.length}`);
console.log("Price-sensitive Stock Token purchases, RENT burns, and liquidity reinvestment require separately quoted minimum-output transactions.");
