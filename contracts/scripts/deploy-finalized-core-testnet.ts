// @ts-nocheck -- Hardhat's viem augmentation is generated during compilation.
import { network } from "hardhat";
import { formatEther, getAddress, stringToHex, zeroAddress } from "viem";

function envAddress(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return getAddress(value);
}

const ORACLE = envAddress("V6_ORACLE");
const OLD_REWARDS = envAddress("V6_STOCK_REWARDS");
const TICKERS = ["NVDA", "TSLA", "AAPL", "AMZN", "META", "MSFT", "GOOGL", "NFLX", "COIN", "AMD"];

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const deployer = wallet.account.address;
if ((await publicClient.getChainId()) !== 46630) throw new Error("Expected Robinhood testnet chain ID 46630");

async function wait(hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
  return receipt;
}

console.log(`Deploying finalized DEEDZ core from ${deployer}`);
console.log(`Starting balance: ${formatEther(await publicClient.getBalance({ address: deployer }))} ETH`);

const rent = await viem.deployContract("RentTokenV6", [deployer]);
const rewards = await viem.deployContract("StockRewardsV6", [deployer]);
const oldRewards = await viem.getContractAt("StockRewardsV6", OLD_REWARDS);
for (const ticker of TICKERS) {
  const key = stringToHex(ticker, { size: 32 });
  let token = await oldRewards.read.stockToken([key]);
  if (token === zeroAddress && ticker === "NFLX") {
    const nflx = await viem.deployContract("TestStockTokenV6", ["NFLX"]);
    token = nflx.address;
    console.log(`Created NFLX test reward token: ${token}`);
  }
  if (token === zeroAddress) throw new Error(`Old deployment has no ${ticker} reward token`);
  await wait(await rewards.write.configureTicker([key, token]));
}

const vault = await viem.deployContract("RentVaultV6", [deployer, ORACLE, deployer, deployer, deployer, deployer]);
const launchedAt = (await publicClient.getBlock()).timestamp;
const ledger = await viem.deployContract("RentLedgerV6", [deployer, launchedAt]);
await wait(await ledger.write.configureVault([vault.address]));
await wait(await vault.write.configureLedger([ledger.address]));
const deed = await viem.deployContract("DeedV6", [rent.address, vault.address, rewards.address, deployer, deployer, launchedAt]);
await wait(await vault.write.configureDeed([deed.address]));
await wait(await rewards.write.configureDeed([deed.address]));

console.log("FINALIZED_DEEDZ_CORE_TESTNET_DEPLOYMENT_OK");
console.log(`Ending balance: ${formatEther(await publicClient.getBalance({ address: deployer }))} ETH`);
console.log(`DEPLOYMENT_JSON=${JSON.stringify({
  network: "robinhoodTestnet", chainId: 46630, deployedAtBlock: Number(await publicClient.getBlockNumber()),
  launchedAt: launchedAt.toString(),
  contracts: { rent: rent.address, oracle: ORACLE, rentVault: vault.address, rentLedger: ledger.address, stockRewards: rewards.address, deed: deed.address },
})}`);
