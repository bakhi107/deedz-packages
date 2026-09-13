import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { network } from "hardhat";
import { getAddress, stringToHex } from "viem";

const deployment = JSON.parse(
  await readFile(resolve(import.meta.dirname, "../../../deployments/robinhood-testnet.json"), "utf8"),
);
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const { core, testAssets } = deployment;

for (const [name, address] of Object.entries({ ...core, ...testAssets })) {
  const code = await publicClient.getCode({ address: address as `0x${string}` });
  if (!code || code === "0x") throw new Error(`${name} has no deployed bytecode`);
}

const taxVault = await viem.getContractAt("TaxVault", core.taxVault);
const landlords = await viem.getContractAt("LandlordRegistry", core.landlordRegistry);
const registry = await viem.getContractAt("TickerRegistry", core.tickerRegistry);
const geoGate = await viem.getContractAt("GeoGate", core.geoGate);
const controller = await viem.getContractAt("FeeController", core.feeController);
const ticker = stringToHex("NVDA", { size: 32 });

if (getAddress(await taxVault.read.owner()) !== getAddress(core.deed)) throw new Error("TaxVault owner mismatch");
if (getAddress(await landlords.read.owner()) !== getAddress(core.deed)) throw new Error("LandlordRegistry owner mismatch");
if (getAddress(await geoGate.read.owner()) !== getAddress(deployment.deployer)) throw new Error("GeoGate owner mismatch");
if ((await controller.read.feeBps([ticker])) !== 5) throw new Error("Default fee mismatch");
const listed = await registry.read.getTicker([ticker]);
if (getAddress(listed.stockToken) !== getAddress(testAssets.nvdaStockToken)) throw new Error("Ticker mismatch");

console.log(`Verified ${Object.keys(core).length} core contracts and ${Object.keys(testAssets).length} test assets.`);
console.log("Ownership and ticker wiring are correct. No transactions were broadcast.");
