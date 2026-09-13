// @ts-nocheck -- One-off Robinhood testnet funding transaction.
import { network } from "hardhat";
import { formatUnits, getAddress, parseUnits } from "viem";

const RENT = getAddress(process.env.V6_RENT ?? "");
const TARGET = getAddress(process.env.V6_TEST_RECIPIENT ?? "");
const AMOUNT = parseUnits(process.env.V6_TEST_RENT_AMOUNT ?? "50000", 18);

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
if ((await publicClient.getChainId()) !== 46630) throw new Error("Expected Robinhood testnet");
const rent = await viem.getContractAt("RentTokenV6", RENT);
const before = await rent.read.balanceOf([TARGET]);
const hash = await rent.write.transfer([TARGET, AMOUNT]);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`Transfer failed: ${hash}`);
const after = await rent.read.balanceOf([TARGET]);
if (after !== before + AMOUNT) throw new Error("Unexpected balance after transfer");

console.log(`Transaction: ${hash}`);
console.log(`Previous balance: ${formatUnits(before, 18)} RENT`);
console.log(`Sent: ${formatUnits(AMOUNT, 18)} RENT`);
console.log(`New balance: ${formatUnits(after, 18)} RENT`);
