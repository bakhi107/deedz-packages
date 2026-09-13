// @ts-nocheck -- Hardhat's viem augmentation is generated during compilation.
import { network } from "hardhat";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encodeFunctionData, getAddress, isAddress, parseEther } from "viem";
import { loadV6ReleaseConfig } from "./lib/v6-release-config.js";

const manifestSetting = process.env.V6_CANDIDATE_MANIFEST;
const recipientSetting = process.env.V6_TEST_RECIPIENT;
if (!manifestSetting || !recipientSetting || !isAddress(recipientSetting)) throw new Error("Set V6_CANDIDATE_MANIFEST and V6_TEST_RECIPIENT");
const { config } = await loadV6ReleaseConfig();
if (!config.testOnlyMocks || config.chainId !== 46630) throw new Error("Only explicit testnet mock releases may use test funding");
const manifest = JSON.parse(await readFile(resolve(process.cwd(), manifestSetting), "utf8"));
if (manifest.release !== config.release) throw new Error("Manifest/config mismatch");
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const tokenAbi = [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const roleAbi = [{ type: "function", name: "execute", stateMutability: "payable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }], outputs: [{ type: "bytes" }] }] as const;
const recipient = getAddress(recipientSetting);
const amount = parseEther("150000");
const data = encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [recipient, amount] });
const hash = await wallet.writeContract({ address: config.roles.multisig, abi: roleAbi, functionName: "execute", args: [manifest.contracts.rent, 0n, data] });
if ((await publicClient.waitForTransactionReceipt({ hash })).status !== "success") throw new Error("Test RENT funding failed");
console.log("V6_TEST_RENT_FUNDED");
console.log(`Transaction: ${hash}`);
