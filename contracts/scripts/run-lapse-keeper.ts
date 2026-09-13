// @ts-nocheck
import { network } from "hardhat";
import { getAddress } from "viem";

const deedAddress = getAddress(process.env.V6_DEED ?? "");
const vaultAddress = getAddress(process.env.V6_RENT_VAULT ?? "");
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const client = await viem.getPublicClient();
const deed = await viem.getContractAt("DeedV6", deedAddress);
const vault = await viem.getContractAt("RentVaultV6", vaultAddress);
const block = await client.getBlock();
const count = await vault.read.knownPositionCount();
let eligible = 0;
let lapsed = 0;

for (let index = 0n; index < count; index++) {
  const tokenId = await vault.read.knownPositionAt([index]);
  try {
    const data = await deed.read.deedData([tokenId]);
    if (!data[2]) continue;
    const availableAt = await vault.read.lapseAvailableAt([tokenId]);
    if (availableAt === 0n || block.timestamp < availableAt) continue;
    eligible++;
    const hash = await deed.write.lapse([tokenId]);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status === "success") {
      lapsed++;
      console.log(`DEED_LAPSED token=${tokenId} tx=${hash}`);
    }
  } catch (error) {
    console.error(`LAPSE_FAILED token=${tokenId}`, error instanceof Error ? error.message.split("\n")[0] : error);
  }
}

console.log(`LAPSE_KEEPER_COMPLETE positions=${count} eligible=${eligible} lapsed=${lapsed}`);
