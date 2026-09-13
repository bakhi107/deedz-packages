// @ts-nocheck -- Hardhat 3's generated viem augmentations are loaded at runtime by the plugin.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { network } from "hardhat";
import { encodeAbiParameters, getAddress, keccak256, stringToHex } from "viem";

const deployment = JSON.parse(
  await readFile(resolve(import.meta.dirname, "../../../deployments/robinhood-testnet.json"), "utf8"),
);
const { uniswapV4, testAssets, core } = deployment;

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
if ((await publicClient.getChainId()) !== 46630) throw new Error("Expected Robinhood testnet chain ID 46630");

for (const [name, address] of Object.entries({
  poolManager: uniswapV4.poolManager,
  hook: uniswapV4.deedHook,
  swapRouter: uniswapV4.testSwapRouter,
  liquidityRouter: uniswapV4.testLiquidityRouter,
})) {
  const code = await publicClient.getCode({ address: address as `0x${string}` });
  if (!code || code === "0x") throw new Error(`${name} has no bytecode`);
}

const poolKey = {
  currency0: getAddress(uniswapV4.pool.currency0),
  currency1: getAddress(uniswapV4.pool.currency1),
  fee: 0x800000,
  tickSpacing: 60,
  hooks: getAddress(uniswapV4.deedHook),
} as const;
const encodedKey = encodeAbiParameters(
  [{ type: "tuple", components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ] }],
  [poolKey],
);
const poolId = keccak256(encodedKey);

const hookAbi = [
  { type: "function", name: "poolManager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "feeController", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "poolTicker", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
] as const;
const [manager, controller, configuredTicker] = await Promise.all([
  publicClient.readContract({ address: poolKey.hooks, abi: hookAbi, functionName: "poolManager" }),
  publicClient.readContract({ address: poolKey.hooks, abi: hookAbi, functionName: "feeController" }),
  publicClient.readContract({ address: poolKey.hooks, abi: hookAbi, functionName: "poolTicker", args: [poolId] }),
]);
if (getAddress(manager) !== getAddress(uniswapV4.poolManager)) throw new Error("Hook PoolManager mismatch");
if (getAddress(controller) !== getAddress(core.feeController)) throw new Error("Hook FeeController mismatch");
if (configuredTicker !== stringToHex("NVDA", { size: 32 })) throw new Error("Hook ticker mismatch");

const stateViewAbi = [{
  type: "function",
  name: "getSlot0",
  stateMutability: "view",
  inputs: [{ type: "bytes32" }],
  outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }],
}] as const;
const [sqrtPriceX96, tick] = await publicClient.readContract({
  address: getAddress(uniswapV4.stateView),
  abi: stateViewAbi,
  functionName: "getSlot0",
  args: [poolId],
});
if (sqrtPriceX96 === 0n) throw new Error("Pool is not initialized");

const balanceAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
const surchargeBalance = await publicClient.readContract({
  address: getAddress(testAssets.usdg),
  abi: balanceAbi,
  functionName: "balanceOf",
  args: [poolKey.hooks],
});
if (surchargeBalance === 0n) throw new Error("Hook has no USDG surcharge balance");

console.log("LIVE_V4_VERIFIED");
console.log(`Pool ID: ${poolId}`);
console.log(`Hook: ${poolKey.hooks}`);
console.log(`sqrtPriceX96: ${sqrtPriceX96}`);
console.log(`Current tick: ${tick}`);
console.log(`Hook surcharge balance (raw mUSDG): ${surchargeBalance}`);
