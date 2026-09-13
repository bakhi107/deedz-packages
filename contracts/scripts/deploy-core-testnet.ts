import { network } from "hardhat";
import { formatEther, stringToHex } from "viem";

const { viem } = await network.create({
  network: "robinhoodTestnet",
  chainType: "generic",
});

const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const deployer = wallet.account.address;

if ((await publicClient.getChainId()) !== 46630) throw new Error("Wrong network: expected Robinhood testnet");

async function wait(hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
  return receipt;
}

console.log(`Deploying Core v1 from ${deployer}`);
console.log(`Starting balance: ${formatEther(await publicClient.getBalance({ address: deployer }))} ETH`);

const registry = await viem.deployContract("TickerRegistry", [deployer]);
const geoGate = await viem.deployContract("GeoGate", [deployer]);

// Robinhood testnet has no published canonical launch assets yet. These are explicit testnet substitutes.
const testUsdg = await viem.deployContract("MockUSDG");
const testStock = await viem.deployContract("MockStockToken");
const testOracle = await viem.deployContract("MockPriceOracle");

const taxVault = await viem.deployContract("TaxVault", [deployer, deployer, deployer]);
const landlords = await viem.deployContract("LandlordRegistry", [deployer, registry.address]);
const latestBlock = await publicClient.getBlock();
const floors = await viem.deployContract("FloorManager", [
  deployer,
  registry.address,
  deployer,
  Number(latestBlock.timestamp),
]);
const deed = await viem.deployContract("Deed", [
  registry.address,
  geoGate.address,
  taxVault.address,
  landlords.address,
  floors.address,
  testUsdg.address,
  deployer,
]);
const feeController = await viem.deployContract("FeeController", [landlords.address]);

const ticker = stringToHex("NVDA", { size: 32 });
await wait(await testOracle.write.setPrice([50_000_000n, latestBlock.timestamp]));
await wait(await registry.write.listTicker([ticker, testStock.address, testOracle.address, 250]));
await wait(await geoGate.write.setEligibility([deployer, 18_446_744_073_709_551_615n]));
await wait(await testUsdg.write.mint([deployer, 1_000_000_000_000n]));
await wait(await testStock.write.mint([deployer, 1_000n * 10n ** 18n]));
await wait(await taxVault.write.transferOwnership([deed.address]));
await wait(await landlords.write.transferOwnership([deed.address]));

const deployment = {
  network: "robinhoodTestnet",
  chainId: 46630,
  deployer,
  deployedAtBlock: Number(await publicClient.getBlockNumber()),
  core: {
    tickerRegistry: registry.address,
    geoGate: geoGate.address,
    taxVault: taxVault.address,
    landlordRegistry: landlords.address,
    floorManager: floors.address,
    deed: deed.address,
    feeController: feeController.address,
  },
  testAssets: {
    usdg: testUsdg.address,
    nvdaStockToken: testStock.address,
    nvdaPriceOracle: testOracle.address,
  },
};

console.log(`DEPLOYMENT_JSON=${JSON.stringify(deployment)}`);
console.log(`Ending balance: ${formatEther(await publicClient.getBalance({ address: deployer }))} ETH`);
