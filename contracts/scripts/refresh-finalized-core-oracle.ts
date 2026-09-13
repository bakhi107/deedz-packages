// @ts-nocheck
import { network } from "hardhat";
import { getAddress } from "viem";

const oracle = getAddress(process.env.V6_ORACLE ?? "");
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const block = await publicClient.getBlock();
const abi = [{
  type: "function", name: "setPrice", stateMutability: "nonpayable",
  inputs: [{ type: "uint256" }, { type: "uint256" }], outputs: [],
}] as const;
const hash = await wallet.writeContract({
  address: oracle, abi, functionName: "setPrice", args: [2_000_000_000n, block.timestamp],
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`Oracle refresh failed: ${hash}`);
console.log(`FINALIZED_CORE_ORACLE_REFRESHED ${hash}`);
