// @ts-nocheck -- Hardhat 3 generated viem augmentation is loaded at runtime.
import { network } from "hardhat";
import { formatUnits, getAddress } from "viem";

function envAddress(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return getAddress(value);
}

const RENT = envAddress("V6_RENT");
const LEDGER = envAddress("V6_RENT_LEDGER");
const DEED = envAddress("V6_DEED");
const ALLOCATION = 400_000_000n * 10n ** 18n;

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
if ((await publicClient.getChainId()) !== 46630) throw new Error("Expected Robinhood testnet chain ID 46630");

const rent = await viem.getContractAt("RentTokenV6", RENT);
const deed = await viem.getContractAt("DeedV6", DEED);
const launch = await deed.read.launchedAt();
const available = await rent.read.balanceOf([wallet.account.address]);
if (available < ALLOCATION) throw new Error(`Deployer has only ${formatUnits(available, 18)} RENT; 400000000 required`);

const emitter = await viem.deployContract("RentEmitterV6", [RENT, LEDGER, launch]);
const hash = await rent.write.transfer([emitter.address, ALLOCATION]);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") throw new Error(`Emitter funding failed: ${hash}`);

if (getAddress(await emitter.read.token()) !== RENT) throw new Error("Emitter RENT wiring mismatch");
if (getAddress(await emitter.read.ledger()) !== LEDGER) throw new Error("Emitter Ledger wiring mismatch");
if (await rent.read.balanceOf([emitter.address]) !== ALLOCATION) throw new Error("Emitter allocation mismatch");

console.log("V6_TEST_EMITTER_DEPLOYED");
console.log(`Emitter: ${emitter.address}`);
console.log(`Launch: ${launch}`);
console.log(`First claim at: ${await emitter.read.firstClaimAt()}`);
console.log(`Funding transaction: ${hash}`);
console.log(`Allocation: ${formatUnits(ALLOCATION, 18)} RENT`);
