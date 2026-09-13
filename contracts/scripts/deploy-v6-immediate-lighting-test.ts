// @ts-nocheck -- Hardhat 3 generated viem augmentation is loaded at runtime.
import { network } from "hardhat";
import { formatEther, getAddress } from "viem";

function envAddress(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return getAddress(value);
}

const RENT = envAddress("V6_RENT");
const ORACLE = envAddress("V6_ORACLE");
const GEO_GATE = envAddress("V6_GEO_GATE");

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const deployer = wallet.account.address;
if ((await publicClient.getChainId()) !== 46630) throw new Error("Expected Robinhood testnet chain ID 46630");

console.log(`Deploying isolated immediate-lighting test contracts from ${deployer}`);
console.log(`Starting balance: ${formatEther(await publicClient.getBalance({ address: deployer }))} ETH`);

const rewards = await viem.deployContract("StockRewardsV6", [deployer]);
const vault = await viem.deployContract("RentVaultV6", [deployer, ORACLE, deployer, deployer, deployer, deployer]);
const chainTimestamp = (await publicClient.getBlock()).timestamp;
const launchedAt = chainTimestamp;
const ledger = await viem.deployContract("RentLedgerV6", [deployer, launchedAt]);
for (const hash of [await ledger.write.configureVault([vault.address]), await vault.write.configureLedger([ledger.address])]) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Ledger configuration failed: ${hash}`);
}
const deed = await viem.deployContract("DeedV6", [RENT, GEO_GATE, vault.address, rewards.address, deployer, deployer, launchedAt]);

for (const hash of [await vault.write.configureDeed([deed.address]), await rewards.write.configureDeed([deed.address])]) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Configuration failed: ${hash}`);
}

console.log("V6_IMMEDIATE_LIGHTING_TEST_DEPLOYMENT_OK");
console.log(`Ending balance: ${formatEther(await publicClient.getBalance({ address: deployer }))} ETH`);
console.log(`DEPLOYMENT_JSON=${JSON.stringify({
  network: "robinhoodTestnet",
  chainId: 46630,
  status: "temporary-immediate-lighting-test",
  deployedAtBlock: Number(await publicClient.getBlockNumber()),
  launchedAt: launchedAt.toString(),
  contracts: { rent: RENT, oracle: ORACLE, geoGate: GEO_GATE, rentVault: vault.address, rentLedger: ledger.address, stockRewards: rewards.address, deed: deed.address },
})}`);
