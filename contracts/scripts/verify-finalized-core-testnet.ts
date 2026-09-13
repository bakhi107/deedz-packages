// @ts-nocheck
import { network } from "hardhat";
import { getAddress, stringToHex, zeroAddress } from "viem";

const addresses = {
  rent: getAddress("0xeb2f5feb934310b4e81b82d980099d67ac10082a"),
  vault: getAddress("0x21f1f62936426a97747346b8b83a99e9382dadda"),
  ledger: getAddress("0x5383d2deae5a35f35bd13a94eec1cea98c7c6977"),
  rewards: getAddress("0xc2a8cee0cafb59737c64f7d2841798cfd547b7d0"),
  deed: getAddress("0x212203eb2d9568897144f662a7590fbf495e2d76"),
};
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const client = await viem.getPublicClient();
for (const [name, address] of Object.entries(addresses)) {
  const code = await client.getCode({ address });
  if (!code || code === "0x") throw new Error(`${name} has no bytecode`);
}
const vault = await viem.getContractAt("RentVaultV6", addresses.vault);
const ledger = await viem.getContractAt("RentLedgerV6", addresses.ledger);
const rewards = await viem.getContractAt("StockRewardsV6", addresses.rewards);
const deed = await viem.getContractAt("DeedV6", addresses.deed);
if (getAddress(await vault.read.deed()) !== addresses.deed) throw new Error("Vault -> Deed mismatch");
if (getAddress(await vault.read.ledger()) !== addresses.ledger) throw new Error("Vault -> Ledger mismatch");
if (getAddress(await ledger.read.vault()) !== addresses.vault) throw new Error("Ledger -> Vault mismatch");
if (getAddress(await rewards.read.deed()) !== addresses.deed) throw new Error("Rewards -> Deed mismatch");
if (getAddress(await deed.read.rentVault()) !== addresses.vault) throw new Error("Deed -> Vault mismatch");
if (await rewards.read.stockToken([stringToHex("NFLX", { size: 32 })]) === zeroAddress) throw new Error("NFLX token missing");
console.log("FINALIZED_DEEDZ_CORE_VERIFIED");
