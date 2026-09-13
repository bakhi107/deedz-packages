// @ts-nocheck -- Hardhat's viem augmentation is generated during compilation.
import { network } from "hardhat";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadV6ReleaseConfig } from "./lib/v6-release-config.js";

const manifestSetting = process.env.V6_CANDIDATE_MANIFEST;
if (!manifestSetting) throw new Error("Set V6_CANDIDATE_MANIFEST");
const { config } = await loadV6ReleaseConfig();
if (!config.testOnlyMocks || config.chainId !== 46630) throw new Error("Only explicit testnet mock releases may use deterministic conversion");
const manifest = JSON.parse(await readFile(resolve(process.cwd(), manifestSetting), "utf8"));
if (manifest.release !== config.release || !String(manifest.status).startsWith("candidate-launched")) throw new Error("Manifest/config mismatch or release not launched");

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
if (wallet.account.address.toLowerCase() !== manifest.governance.keeper.toLowerCase()) throw new Error("Keeper key does not match manifest");
const rewards = await viem.getContractAt("StockRewardsV6", manifest.contracts.rewards);
const buyer = await viem.getContractAt("StockBuyerV6", manifest.contracts.stockBuyer);
const count = await rewards.read.batchCount();
const hashes: string[] = [];

for (let id = 0n; id < count; id++) {
  const batch = await rewards.read.batches([id]);
  const ethRemaining = batch[3];
  const converted = batch[7];
  if (converted || ethRemaining === 0n) continue;
  const deadline = (await publicClient.getBlock()).timestamp + 300n;
  // Test router deterministically returns two token units per wei; retain 5% test slippage room.
  const minimum = ethRemaining * 19n / 10n;
  const hash = await buyer.write.buyBatch([id, minimum, deadline, "0x"]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Conversion failed for batch ${id}`);
  hashes.push(hash);
}

console.log("V6_MOCK_REWARD_CONVERSION_COMPLETE");
console.log(`Converted batches: ${hashes.length}`);
for (const hash of hashes) console.log(`Transaction: ${hash}`);
