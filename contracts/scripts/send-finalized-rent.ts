// @ts-nocheck
import { network } from "hardhat";
import { formatEther, getAddress, parseEther } from "viem";

const recipient = getAddress(process.env.RENT_RECIPIENT ?? "");
const amount = parseEther(process.env.RENT_AMOUNT ?? "100000");
const rent = getAddress(process.env.V6_RENT ?? "");
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const token = await viem.getContractAt("RentTokenV6", rent);
const hash = await token.write.transfer([recipient, amount]);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`RENT transfer failed: ${hash}`);
const balance = await token.read.balanceOf([recipient]);
console.log(`FINALIZED_RENT_SENT ${formatEther(amount)} RENT`);
console.log(`RECIPIENT_BALANCE ${formatEther(balance)} RENT`);
console.log(`TRANSACTION ${hash}`);
