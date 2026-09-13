// @ts-nocheck -- Hardhat's viem augmentation is generated during compilation.
import { network } from "hardhat";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stringToHex } from "viem";
import { loadV6ReleaseConfig } from "./lib/v6-release-config.js";

const manifestSetting = process.env.V6_CANDIDATE_MANIFEST;
if (!manifestSetting) throw new Error("Set V6_CANDIDATE_MANIFEST");
const { config } = await loadV6ReleaseConfig();
if (!config.testOnlyMocks || config.chainId !== 46630) throw new Error("Only explicit testnet mock releases may use this smoke test");
const manifest = JSON.parse(await readFile(resolve(process.cwd(), manifestSetting), "utf8"));
if (manifest.release !== config.release) throw new Error("Manifest/config mismatch");

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const deedAbi = [{
  type: "function",
  name: "mintDark",
  stateMutability: "nonpayable",
  inputs: [{ name: "ticker", type: "bytes32" }],
  outputs: [{ name: "tokenId", type: "uint256" }],
}] as const;

const ticker = stringToHex("TSLA", { size: 32 });
const hash = await wallet.writeContract({ address: manifest.contracts.deed, abi: deedAbi, functionName: "mintDark", args: [ticker] });
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error("Open-mint smoke test failed");
console.log("V6_OPEN_MINT_PASSED");
console.log(`Transaction: ${hash}`);
