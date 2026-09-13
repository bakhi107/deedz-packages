// @ts-nocheck
import { network } from "hardhat";
import { getAddress } from "viem";

const buyerAddress = getAddress(process.env.V6_STOCK_BUYER ?? "");
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const keeper = await viem.deployContract("TestRewardKeeperV6", [buyerAddress]);
const buyer = await viem.getContractAt("StockBuyerV6", buyerAddress);
const hash = await buyer.write.setExecutor([keeper.address]);
if ((await publicClient.waitForTransactionReceipt({ hash })).status !== "success") throw new Error("Keeper assignment failed");
if ((await buyer.read.executor()).toLowerCase() !== keeper.address.toLowerCase()) throw new Error("Keeper mismatch");
console.log(`TEST_REWARD_KEEPER_DEPLOYED ${keeper.address}`);
console.log(`ASSIGNMENT_TRANSACTION ${hash}`);
