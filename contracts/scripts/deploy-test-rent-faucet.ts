// @ts-nocheck
import { network } from "hardhat";
import { formatUnits, getAddress, parseUnits } from "viem";

const rentAddress = getAddress(process.env.V6_RENT ?? "");
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const client = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const rent = await viem.getContractAt("RentTokenV6", rentAddress);
const faucet = await viem.deployContract("TestRentFaucetV6", [rentAddress, wallet.account.address]);
const funding = parseUnits("5000000", 18);
const hash = await rent.write.transfer([faucet.address, funding]);
const receipt = await client.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error("Faucet funding failed");
console.log(`V6_RENT_FAUCET=${faucet.address}`);
console.log(`FAUCET_FUNDED=${formatUnits(await rent.read.balanceOf([faucet.address]), 18)} RENT`);
console.log(`DEPLOYER=${wallet.account.address}`);
