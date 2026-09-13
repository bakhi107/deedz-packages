import { network } from "hardhat";
import { formatEther } from "viem";

const reused = {
  tickerRegistry: "0x9eb26d21d5f8cc54e15add8a7bbbb3532d5a29b1",
  geoGate: "0x0023451fd98fdc26a599f25b698e744f52bd9f08",
  floorManager: "0x80d0bbd2dd0c37ad291caff97367ba55c532f90f",
  usdg: "0x9b1ed94f8b943a2b142793a90527bc419c5548cc",
  stock: "0x2987c3e0eafaa52684c943c3233e165dac4e94f8",
  oracle: "0x0bf65702ab1eaea217b90f5e7fb7d8c484f5c96b",
} as const;

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const deployer = wallet.account.address;
if ((await publicClient.getChainId()) !== 46630) throw new Error("Wrong network");

async function wait(hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
}

console.log(`Deploying metadata-enabled Core v2 from ${deployer}`);
const taxVault = await viem.deployContract("TaxVault", [deployer, deployer, deployer]);
const landlords = await viem.deployContract("LandlordRegistry", [deployer, reused.tickerRegistry]);
const deed = await viem.deployContract("Deed", [
  reused.tickerRegistry,
  reused.geoGate,
  taxVault.address,
  landlords.address,
  reused.floorManager,
  reused.usdg,
  deployer,
]);
const feeController = await viem.deployContract("FeeController", [landlords.address]);
await wait(await taxVault.write.transferOwnership([deed.address]));
await wait(await landlords.write.transferOwnership([deed.address]));

console.log(`DEPLOYMENT_JSON=${JSON.stringify({
  deployedAtBlock: Number(await publicClient.getBlockNumber()),
  taxVault: taxVault.address,
  landlordRegistry: landlords.address,
  deed: deed.address,
  feeController: feeController.address,
})}`);
console.log(`Balance remaining: ${formatEther(await publicClient.getBalance({ address: deployer }))} ETH`);
