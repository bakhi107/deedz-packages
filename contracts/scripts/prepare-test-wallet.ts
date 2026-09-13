import { network } from "hardhat";
import { formatUnits, getAddress, type Address } from "viem";

const targetValue = process.env.TARGET_WALLET;
if (!targetValue) throw new Error("Set TARGET_WALLET");
const target = getAddress(targetValue) as Address;

const addresses = {
  geoGate: "0x0023451fd98fdc26a599f25b698e744f52bd9f08",
  usdg: "0x9b1ed94f8b943a2b142793a90527bc419c5548cc",
  stock: "0x2987c3e0eafaa52684c943c3233e165dac4e94f8",
  oracle: "0x0bf65702ab1eaea217b90f5e7fb7d8c484f5c96b",
} as const;

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const geoGate = await viem.getContractAt("GeoGate", addresses.geoGate);
const usdg = await viem.getContractAt("MockUSDG", addresses.usdg);
const stock = await viem.getContractAt("MockStockToken", addresses.stock);
const oracle = await viem.getContractAt("MockPriceOracle", addresses.oracle);

async function wait(hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
}

await wait(await geoGate.write.setEligibility([target, 18_446_744_073_709_551_615n]));
await wait(await usdg.write.mint([target, 100_000_000n]));
await wait(await stock.write.mint([target, 10n * 10n ** 18n]));
const block = await publicClient.getBlock();
await wait(await oracle.write.setPrice([50_000_000n, block.timestamp]));

console.log(`Prepared ${target}`);
console.log(`Test USDG: ${formatUnits(await usdg.read.balanceOf([target]), 6)}`);
console.log(`Test NVDA: ${formatUnits(await stock.read.balanceOf([target]), 18)}`);
