// @ts-nocheck
import { network } from "hardhat";
import { getAddress } from "viem";

const keeperAddress = getAddress(process.env.V6_REWARD_KEEPER ?? "");
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const keeper = await viem.getContractAt("TestRewardKeeperV6", keeperAddress);
const hash = await keeper.write.runCycle();
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error("Reward cycle failed");
console.log(`TEST_REWARD_CYCLE_OK ${hash}`);
console.log(`NEXT_RUN_AT ${await keeper.read.nextRunAt()}`);
