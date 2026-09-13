// @ts-nocheck -- Hardhat's viem augmentation is generated during compilation.
import { network } from "hardhat";
import { loadV6ReleaseConfig } from "./lib/v6-release-config.js";

const { config } = await loadV6ReleaseConfig();
if (!config.testOnlyMocks || config.chainId !== 46630) throw new Error("Only an explicit testnet mock release may update this feed");
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const feedAbi = [{ type: "function", name: "setAnswer", stateMutability: "nonpayable", inputs: [{ type: "int256" }], outputs: [] }] as const;
const hash = await wallet.writeContract({ address: config.external.ethUsdFeed, abi: feedAbi, functionName: "setAnswer", args: [3_000_000n * 10n ** 8n] });
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error("Mock feed update failed");
console.log("V6_TESTNET_MOCK_FEED_SET");
console.log(`Transaction: ${hash}`);
