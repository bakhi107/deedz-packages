// @ts-nocheck -- Hardhat 3's generated viem augmentations are loaded at runtime by the plugin.
import { artifacts, network } from "hardhat";
import {
  concatHex,
  encodeAbiParameters,
  encodeDeployData,
  formatEther,
  getAddress,
  getContractAddress,
  keccak256,
  maxUint256,
  numberToHex,
  parseEther,
  zeroAddress,
  zeroHash,
} from "viem";

function envAddress(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return getAddress(value);
}
const POOL_MANAGER = envAddress("V6_POOL_MANAGER");
const STATE_VIEW = envAddress("V6_STATE_VIEW");
const CREATE2_FACTORY = envAddress("V6_CREATE2_FACTORY");
const SWAP_ROUTER = envAddress("V6_SWAP_ROUTER");
const LIQUIDITY_ROUTER = envAddress("V6_LIQUIDITY_ROUTER");
const TEST_WALLET = envAddress("V6_TEST_WALLET");
const HOOK_FLAGS = 0x80n; // beforeSwap
const ALL_HOOK_FLAGS_MASK = (1n << 14n) - 1n;

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const deployer = wallet.account.address;
if ((await publicClient.getChainId()) !== 46630) throw new Error("Expected Robinhood testnet chain ID 46630");

for (const [name, address] of Object.entries({ POOL_MANAGER, STATE_VIEW, CREATE2_FACTORY, SWAP_ROUTER, LIQUIDITY_ROUTER })) {
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(`${name} has no bytecode at ${address}`);
}

async function wait(hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
  console.log(`confirmed ${hash}`);
  return receipt;
}

console.log(`Deploying DEEDS v6 development contracts from ${deployer}`);
console.log(`Starting gas balance: ${formatEther(await publicClient.getBalance({ address: deployer }))} ETH`);
const chainTimestamp = (await publicClient.getBlock()).timestamp;

const rent = await viem.deployContract("RentTokenV6", [deployer]);
const oracle = await viem.deployContract("MockPriceOracle");
const geoGate = await viem.deployContract("GeoGate", [deployer]);
await wait(await oracle.write.setPrice([2_000_000_000n, chainTimestamp]));
const vault = await viem.deployContract("RentVaultV6", [
  deployer,
  oracle.address,
  deployer,
  deployer,
  deployer,
  deployer,
]);
const rewards = await viem.deployContract("StockRewardsV6", [deployer]);
const launchTickers = ["NVDA", "TSLA", "AAPL", "AMZN", "META", "MSFT", "GOOGL", "HOOD", "COIN", "AMD"];
const testStockTokens: Record<string, `0x${string}`> = {};
for (const symbol of launchTickers) {
  const token = await viem.deployContract("MockStockToken");
  const ticker = `0x${Buffer.from(symbol).toString("hex").padEnd(64, "0")}` as `0x${string}`;
  await wait(await rewards.write.configureTicker([ticker, token.address]));
  testStockTokens[symbol] = token.address;
}
const launchedAt = chainTimestamp;
const deed = await viem.deployContract("DeedV6", [
  rent.address,
  geoGate.address,
  vault.address,
  rewards.address,
  deployer,
  deployer,
  launchedAt,
]);
await wait(await vault.write.configureDeed([deed.address]));
await wait(await rewards.write.configureDeed([deed.address]));
const eligibilityExpiry = 18_446_744_073_709_551_615n;
await wait(await geoGate.write.setEligibility([deployer, eligibilityExpiry]));
await wait(await geoGate.write.setEligibility([TEST_WALLET, eligibilityExpiry]));
await wait(await rent.write.transfer([TEST_WALLET, 100_000n * 10n ** 18n]));

const hookArtifact = await artifacts.readArtifact("RentHookV6Prototype");
const hookInitCode = encodeDeployData({
  abi: hookArtifact.abi,
  bytecode: hookArtifact.bytecode,
  args: [POOL_MANAGER, deployer],
});
let saltNonce = 0n;
let hookAddress: `0x${string}`;
let hookSalt: `0x${string}`;
for (;;) {
  hookSalt = numberToHex(saltNonce, { size: 32 });
  hookAddress = getContractAddress({ opcode: "CREATE2", from: CREATE2_FACTORY, salt: hookSalt, bytecode: hookInitCode });
  if ((BigInt(hookAddress) & ALL_HOOK_FLAGS_MASK) === HOOK_FLAGS) break;
  saltNonce += 1n;
}
console.log(`Mined v6 hook salt ${saltNonce} -> ${hookAddress}`);
const existingHookCode = await publicClient.getCode({ address: hookAddress });
if (!existingHookCode || existingHookCode === "0x") {
  await wait(await wallet.sendTransaction({ to: CREATE2_FACTORY, data: concatHex([hookSalt, hookInitCode]) }));
}
const hookCode = await publicClient.getCode({ address: hookAddress });
if (!hookCode || hookCode === "0x") throw new Error("V6 hook deployment produced no bytecode");

const poolKey = {
  currency0: zeroAddress,
  currency1: rent.address,
  fee: 50_000,
  tickSpacing: 60,
  hooks: hookAddress,
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
const hook = await viem.getContractAt("RentHookV6Prototype", hookAddress);
await wait(await hook.write.configurePool([poolKey]));
const manager = await viem.getContractAt("V4PoolManager", POOL_MANAGER);
const sqrtPriceX96 = 1_000n * (2n ** 96n); // Development price: 1 ETH = 1,000,000 RENT.
await wait(await manager.write.initialize([poolKey, sqrtPriceX96]));

await wait(await rent.write.approve([LIQUIDITY_ROUTER, maxUint256]));
await wait(await rent.write.approve([SWAP_ROUTER, maxUint256]));
const liquidityRouter = await viem.getContractAt("V4LiquidityRouter", LIQUIDITY_ROUTER);
await wait(await liquidityRouter.write.modifyLiquidity([
  poolKey,
  { tickLower: -887_220, tickUpper: 887_220, liquidityDelta: 10n ** 15n, salt: zeroHash },
  "0x",
], { value: parseEther("0.001") }));

const swapRouter = await viem.getContractAt("V4SwapRouter", SWAP_ROUTER);
const rentBefore = await rent.read.balanceOf([deployer]);
const smokeSwap = await swapRouter.write.swap([
  poolKey,
  { zeroForOne: true, amountSpecified: -(10n ** 12n), sqrtPriceLimitX96: 4_295_128_740n },
  { takeClaims: false, settleUsingBurn: false },
  "0x",
], { value: parseEther("0.00001") });
await wait(smokeSwap);
const rentAfter = await rent.read.balanceOf([deployer]);
if (rentAfter <= rentBefore) throw new Error("RENT/ETH smoke swap did not deliver RENT");

const stateViewAbi = [{
  type: "function",
  name: "getSlot0",
  stateMutability: "view",
  inputs: [{ type: "bytes32" }],
  outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }],
}] as const;
const slot0 = await publicClient.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] });
if (slot0[0] === 0n) throw new Error("RENT/ETH pool is not initialized in StateView");

console.log("V6_DEVELOPMENT_TESTNET_DEPLOYMENT_OK");
console.log(`Ending gas balance: ${formatEther(await publicClient.getBalance({ address: deployer }))} ETH`);
console.log(`DEPLOYMENT_JSON=${JSON.stringify({
  network: "robinhoodTestnet",
  chainId: 46630,
  status: "development-not-production",
  deployedAtBlock: Number(await publicClient.getBlockNumber()),
  deployer,
  contracts: {
    rent: rent.address,
    ethUsdOracle: oracle.address,
    geoGate: geoGate.address,
    rentVault: vault.address,
    stockRewards: rewards.address,
    deed: deed.address,
  },
  testAssets: { stockTokens: testStockTokens },
  testWallet: { address: TEST_WALLET, rentFunded: "100000" },
  uniswapV4: {
    poolManager: POOL_MANAGER,
    stateView: STATE_VIEW,
    rentHookPrototype: hookAddress,
    hookSalt,
    swapRouter: SWAP_ROUTER,
    liquidityRouter: LIQUIDITY_ROUTER,
    poolId,
    pool: {
      currency0: zeroAddress,
      currency1: rent.address,
      fee: 50_000,
      tickSpacing: 60,
      initialSqrtPriceX96: sqrtPriceX96.toString(),
      initialLiquidity: "1000000000000000",
    },
    smokeSwap,
  },
})}`);
