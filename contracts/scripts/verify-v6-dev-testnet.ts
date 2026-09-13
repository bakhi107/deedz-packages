// @ts-nocheck -- Read-only independent verification of the recorded v6 development deployment.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { network } from "hardhat";
import { getAddress } from "viem";

const deployment = JSON.parse(await readFile(resolve(import.meta.dirname, "../../../deployments/robinhood-testnet-v6-dev.json"), "utf8"));
const { contracts, uniswapV4, feeRoutedUniswapV4, testWallet } = deployment;
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
if ((await publicClient.getChainId()) !== 46630) throw new Error("Wrong chain");

for (const [name, address] of Object.entries({
  ...contracts,
  poolManager: uniswapV4.poolManager,
  stateView: uniswapV4.stateView,
  archivedRentHook: uniswapV4.rentHookPrototype,
  rentHook: feeRoutedUniswapV4.rentHook,
  feeRouter: feeRoutedUniswapV4.feeRouter,
  ...feeRoutedUniswapV4.receivers,
})) {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(`${name} has no bytecode`);
}

const rent = await viem.getContractAt("RentTokenV6", contracts.rent);
const gate = await viem.getContractAt("GeoGate", contracts.geoGate);
const vault = await viem.getContractAt("RentVaultV6", contracts.rentVault);
const deed = await viem.getContractAt("DeedV6", contracts.deed);
const hook = await viem.getContractAt("RentHookV6Prototype", uniswapV4.rentHookPrototype);
if (await rent.read.totalSupply() > 1_000_000_000n * 10n ** 18n) throw new Error("RENT exceeds fixed maximum supply");
if (await rent.read.balanceOf([testWallet.address]) > BigInt(testWallet.rentFunded) * 10n ** 18n) throw new Error("Test wallet RENT balance exceeds recorded funding");
if (!(await gate.read.isAllowed([testWallet.address]))) throw new Error("Test wallet is not eligible");
if (getAddress(await vault.read.deed()) !== getAddress(contracts.deed)) throw new Error("Vault Deed wiring mismatch");
if (getAddress(await deed.read.rent()) !== getAddress(contracts.rent)) throw new Error("Deed RENT wiring mismatch");
if (getAddress(await deed.read.rentVault()) !== getAddress(contracts.rentVault)) throw new Error("Deed vault wiring mismatch");
if (getAddress(await hook.read.poolManager()) !== getAddress(uniswapV4.poolManager)) throw new Error("Hook manager mismatch");
if (!(await hook.read.configuredPool([uniswapV4.poolId]))) throw new Error("Hook pool is not configured");

const stateViewAbi = [{ type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] }] as const;
const slot0 = await publicClient.readContract({ address: uniswapV4.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [uniswapV4.poolId] });
if (slot0[0] === 0n) throw new Error("Pool is not initialized");
const swapReceipt = await publicClient.getTransactionReceipt({ hash: uniswapV4.transactions.smokeSwap });
if (swapReceipt.status !== "success") throw new Error("Smoke swap failed");

const routedHook = await viem.getContractAt("RentHookV6", feeRoutedUniswapV4.rentHook);
const feeRouter = await viem.getContractAt("RentFeeRouterV6", feeRoutedUniswapV4.feeRouter);
if (getAddress(await routedHook.read.poolManager()) !== getAddress(feeRoutedUniswapV4.poolManager)) throw new Error("Routed hook manager mismatch");
if (getAddress(await routedHook.read.poolRouter([feeRoutedUniswapV4.poolId])) !== getAddress(feeRoutedUniswapV4.feeRouter)) throw new Error("Hook router lock mismatch");
if (getAddress(await feeRouter.read.poolManager()) !== getAddress(feeRoutedUniswapV4.poolManager)) throw new Error("Fee router manager mismatch");
if (getAddress(await feeRouter.read.rent()) !== getAddress(contracts.rent)) throw new Error("Fee router RENT mismatch");
if (getAddress(await feeRouter.read.hook()) !== getAddress(feeRoutedUniswapV4.rentHook)) throw new Error("Fee router hook mismatch");
const feeBuckets = await Promise.all([
  feeRouter.read.stockBuyerAccrued(),
  feeRouter.read.liquidityAccrued(),
  feeRouter.read.teamAccrued(),
  feeRouter.read.throneAccrued(),
]);
const totalFees = await feeRouter.read.totalFeesCollected();
if (feeBuckets.reduce((sum, value) => sum + value, 0n) !== totalFees || totalFees === 0n) throw new Error("Fee conservation mismatch");
const routedSlot0 = await publicClient.readContract({ address: feeRoutedUniswapV4.stateView, abi: stateViewAbi, functionName: "getSlot0", args: [feeRoutedUniswapV4.poolId] });
if (routedSlot0[0] === 0n) throw new Error("Fee-routed pool is not initialized");
for (const hash of [feeRoutedUniswapV4.transactions.ethToRentSwap, feeRoutedUniswapV4.transactions.rentToEthSwap]) {
  if ((await publicClient.getTransactionReceipt({ hash })).status !== "success") throw new Error(`Routed smoke swap failed: ${hash}`);
}

console.log("V6_DEVELOPMENT_TESTNET_VERIFIED");
console.log(`Deed: ${contracts.deed}`);
console.log(`RENT: ${contracts.rent}`);
console.log(`RentVault: ${contracts.rentVault}`);
console.log(`Pool ID: ${uniswapV4.poolId}`);
console.log(`RentHook: ${uniswapV4.rentHookPrototype}`);
console.log(`Current tick: ${slot0[1]}`);
console.log(`Test wallet funded and eligible: ${testWallet.address}`);
console.log(`Fee-routed pool ID: ${feeRoutedUniswapV4.poolId}`);
console.log(`FeeRouter: ${feeRoutedUniswapV4.feeRouter}`);
console.log(`5% fee conservation verified: ${totalFees} wei`);
