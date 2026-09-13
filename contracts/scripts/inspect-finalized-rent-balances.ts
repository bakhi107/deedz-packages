// @ts-nocheck
import { network } from "hardhat";
import { formatEther, getAddress } from "viem";

const wallets = [
  "0xB174D2D54F30dEdDEcf1ba2a24862E8c2d917662",
  "0xC878Cc072aC3a869A938A99DA404D25850835a20",
  "0x9F641eD89C3583987450117dfe14a8e644b1Ea15",
].map((address) => getAddress(address));
const rentAddress = getAddress(process.env.V6_RENT ?? "");
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const rent = await viem.getContractAt("RentTokenV6", rentAddress);
for (const wallet of wallets) console.log(`${wallet} ${formatEther(await rent.read.balanceOf([wallet]))} RENT`);
