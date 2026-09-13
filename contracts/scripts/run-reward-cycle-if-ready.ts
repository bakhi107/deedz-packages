// @ts-nocheck
import { network } from "hardhat";
import { getAddress } from "viem";

const keeperAddress = getAddress(process.env.V6_REWARD_KEEPER ?? "");
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const keeper = await viem.getContractAt("TestRewardKeeperV6", keeperAddress);
const [block, next] = await Promise.all([publicClient.getBlock(), keeper.read.nextRunAt()]);
if (next !== 0n && block.timestamp < next) {
  console.log(`REWARD_CYCLE_NOT_READY next=${next}`);
  process.exit(0);
}
const hash = await keeper.write.runCycle();
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`Reward cycle failed: ${hash}`);
console.log(`REWARD_CYCLE_COMPLETE ${hash}`);
