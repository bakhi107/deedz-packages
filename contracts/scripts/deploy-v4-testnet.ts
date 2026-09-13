// @ts-nocheck -- Hardhat 3's generated viem augmentations are loaded at runtime by the plugin.
import { artifacts, network } from "hardhat";
import {
  concatHex,
  encodeDeployData,
  formatUnits,
  getAddress,
  getContractAddress,
  maxUint256,
  numberToHex,
  stringToHex,
  zeroHash,
} from "viem";

const POOL_MANAGER = getAddress("0x8366a39cc670b4001a1121b8f6a443a643e40951");
const CREATE2_FACTORY = getAddress("0x4e59b44847b379578588920ca78fbf26c0b4956c");
const USDG = getAddress("0x9b1ed94f8b943a2b142793a90527bc419c5548cc");
const NVDA = getAddress("0x2987c3e0eafaa52684c943c3233e165dac4e94f8");
const FEE_CONTROLLER = getAddress("0xf04973c45f9a2cab594573b44ae512b2f823bd91");
const HOOK_FLAGS = 0xc4n; // beforeSwap | afterSwap | afterSwapReturnDelta
const ALL_HOOK_FLAGS_MASK = (1n << 14n) - 1n;

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const deployer = wallet.account.address;

if ((await publicClient.getChainId()) !== 46630) throw new Error("Expected Robinhood testnet chain ID 46630");
for (const [name, address] of Object.entries({ POOL_MANAGER, CREATE2_FACTORY, USDG, NVDA, FEE_CONTROLLER })) {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(`${name} has no deployed bytecode at ${address}`);
}

async function wait(hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
  console.log(`confirmed ${hash}`);
  return receipt;
}

function integerSqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("square root of negative value");
  if (value < 2n) return value;
  let x0 = value;
  let x1 = (x0 + value / x0) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) >> 1n;
  }
  return x0;
}

const hookArtifact = await artifacts.readArtifact("DeedHookPrototype");
const hookInitCode = encodeDeployData({
  abi: hookArtifact.abi,
  bytecode: hookArtifact.bytecode,
  args: [POOL_MANAGER, FEE_CONTROLLER, deployer],
});

let saltNonce = 0n;
let hookAddress: `0x${string}`;
let salt: `0x${string}`;
for (;;) {
  salt = numberToHex(saltNonce, { size: 32 });
  hookAddress = getContractAddress({ opcode: "CREATE2", from: CREATE2_FACTORY, salt, bytecode: hookInitCode });
  if ((BigInt(hookAddress) & ALL_HOOK_FLAGS_MASK) === HOOK_FLAGS) break;
  saltNonce += 1n;
}
console.log(`Mined hook salt ${saltNonce} -> ${hookAddress}`);

let hookCode = await publicClient.getCode({ address: hookAddress });
if (!hookCode || hookCode === "0x") {
  await wait(await wallet.sendTransaction({ to: CREATE2_FACTORY, data: concatHex([salt, hookInitCode]) }));
  hookCode = await publicClient.getCode({ address: hookAddress });
  if (!hookCode || hookCode === "0x") throw new Error("CREATE2 hook deployment produced no bytecode");
}

// These two stateless test routers settle directly against the real PoolManager. They are deliberately
// used for a deterministic integration smoke test; the public UI will use canonical periphery later.
const swapRouter = await viem.deployContract("V4SwapRouter", [POOL_MANAGER]);
const liquidityRouter = await viem.deployContract("V4LiquidityRouter", [POOL_MANAGER]);
console.log(`Swap test router: ${swapRouter.address}`);
console.log(`Liquidity test router: ${liquidityRouter.address}`);

const [currency0, currency1] = BigInt(NVDA) < BigInt(USDG) ? [NVDA, USDG] : [USDG, NVDA];
const poolKey = {
  currency0,
  currency1,
  fee: 0x800000,
  tickSpacing: 60,
  hooks: hookAddress,
} as const;

const hook = await viem.getContractAt("DeedHookPrototype", hookAddress);
await wait(await hook.write.setPoolTicker([poolKey, stringToHex("NVDA", { size: 32 })]));

// 50 USDG per NVDA, normalized for NVDA's 18 decimals and USDG's 6 decimals.
const q192 = 1n << 192n;
const sqrtPriceX96 = currency0 === NVDA
  ? integerSqrt((50_000_000n * q192) / 10n ** 18n)
  : integerSqrt((10n ** 18n * q192) / 50_000_000n);

const manager = await viem.getContractAt("V4PoolManager", POOL_MANAGER);
await wait(await manager.write.initialize([poolKey, sqrtPriceX96]));

const erc20Abi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
for (const token of [NVDA, USDG]) {
  await wait(await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [liquidityRouter.address, maxUint256] }));
  await wait(await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [swapRouter.address, maxUint256] }));
}

await wait(await liquidityRouter.write.modifyLiquidity([
  poolKey,
  { tickLower: -887220, tickUpper: 887220, liquidityDelta: 10n ** 15n, salt: zeroHash },
  "0x",
]));

const hookUsdgBefore = await publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [hookAddress] });
const swapHash = await swapRouter.write.swap([
  poolKey,
  { zeroForOne: currency0 === NVDA, amountSpecified: -(10n ** 16n), sqrtPriceLimitX96: currency0 === NVDA ? 4_295_128_740n : 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341n },
  { takeClaims: false, settleUsingBurn: false },
  "0x",
]);
await wait(swapHash);
const hookUsdgAfter = await publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [hookAddress] });
if (hookUsdgAfter <= hookUsdgBefore) throw new Error("Live swap did not deliver the DEEDS surcharge to the hook");

console.log("LIVE_V4_INTEGRATION_OK");
console.log(`Hook: ${hookAddress}`);
console.log(`PoolManager: ${POOL_MANAGER}`);
console.log(`Pool currencies: ${currency0} / ${currency1}`);
console.log(`Hook USDG surcharge from smoke swap: ${formatUnits(hookUsdgAfter - hookUsdgBefore, 6)} mUSDG`);
console.log(`Swap transaction: ${swapHash}`);
console.log(`DEPLOYMENT_JSON=${JSON.stringify({ chainId: 46630, poolManager: POOL_MANAGER, hook: hookAddress, hookSalt: salt, swapRouter: swapRouter.address, liquidityRouter: liquidityRouter.address, currency0, currency1, dynamicFee: true, tickSpacing: 60, sqrtPriceX96: sqrtPriceX96.toString(), liquidity: "1000000000000000", smokeSwapTransaction: swapHash })}`);
