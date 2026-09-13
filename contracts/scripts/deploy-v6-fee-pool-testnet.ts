// @ts-nocheck -- Hardhat 3 generated viem augmentation is loaded at runtime.
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
const RENT = envAddress("V6_RENT");
const POOL_MANAGER = envAddress("V6_POOL_MANAGER");
const STATE_VIEW = envAddress("V6_STATE_VIEW");
const CREATE2_FACTORY = envAddress("V6_CREATE2_FACTORY");
const LIQUIDITY_ROUTER = envAddress("V6_LIQUIDITY_ROUTER");
const HOOK_FLAGS = 0x80n;
const ALL_HOOK_FLAGS_MASK = (1n << 14n) - 1n;

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const deployer = wallet.account.address;
if ((await publicClient.getChainId()) !== 46630) throw new Error("Expected Robinhood testnet");

async function wait(hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
  console.log(`confirmed ${hash}`);
  return receipt;
}

console.log(`Deploying fee-routed RENT/ETH pool from ${deployer}`);
console.log(`Starting balance: ${formatEther(await publicClient.getBalance({ address: deployer }))} ETH`);

const stockBuyerReceiver = await viem.deployContract("FeeBucketReceiverV6", [deployer]);
const liquidityReceiver = await viem.deployContract("FeeBucketReceiverV6", [deployer]);
const teamReceiver = await viem.deployContract("FeeBucketReceiverV6", [deployer]);
const throneReceiver = await viem.deployContract("FeeBucketReceiverV6", [deployer]);

const hookArtifact = await artifacts.readArtifact("RentHookV6");
const hookInitCode = encodeDeployData({ abi: hookArtifact.abi, bytecode: hookArtifact.bytecode, args: [POOL_MANAGER, deployer] });
let saltNonce = 0n;
let hookAddress: `0x${string}`;
let hookSalt: `0x${string}`;
for (;;) {
  hookSalt = numberToHex(saltNonce, { size: 32 });
  hookAddress = getContractAddress({ opcode: "CREATE2", from: CREATE2_FACTORY, salt: hookSalt, bytecode: hookInitCode });
  if ((BigInt(hookAddress) & ALL_HOOK_FLAGS_MASK) === HOOK_FLAGS) break;
  saltNonce += 1n;
}
const existing = await publicClient.getCode({ address: hookAddress });
if (!existing || existing === "0x") {
  await wait(await wallet.sendTransaction({ to: CREATE2_FACTORY, data: concatHex([hookSalt, hookInitCode]) }));
}
const deployedHookCode = await publicClient.getCode({ address: hookAddress });
if (!deployedHookCode || deployedHookCode === "0x") throw new Error("Hook deployment failed");
console.log(`Fee hook: ${hookAddress}`);

const feeRouter = await viem.deployContract("RentFeeRouterV6", [
  POOL_MANAGER,
  RENT,
  hookAddress,
  stockBuyerReceiver.address,
  liquidityReceiver.address,
  teamReceiver.address,
  throneReceiver.address,
]);
const poolKey = { currency0: zeroAddress, currency1: RENT, fee: 0, tickSpacing: 60, hooks: hookAddress } as const;
const encodedKey = encodeAbiParameters([{ type: "tuple", components: [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] }], [poolKey]);
const poolId = keccak256(encodedKey);
const hook = await viem.getContractAt("RentHookV6", hookAddress);
await wait(await hook.write.configurePool([poolKey, feeRouter.address]));
const manager = await viem.getContractAt("V4PoolManager", POOL_MANAGER);
const sqrtPriceX96 = 1_000n * (2n ** 96n);
await wait(await manager.write.initialize([poolKey, sqrtPriceX96]));

const rent = await viem.getContractAt("RentTokenV6", RENT);
await wait(await rent.write.approve([LIQUIDITY_ROUTER, maxUint256]));
const liquidityHelper = await viem.getContractAt("V4LiquidityRouter", LIQUIDITY_ROUTER);
await wait(await liquidityHelper.write.modifyLiquidity([
  poolKey,
  { tickLower: -887_220, tickUpper: 887_220, liquidityDelta: 10n ** 15n, salt: zeroHash },
  "0x",
], { value: parseEther("0.001") }));

const block = await publicClient.getBlock();
const deadline = block.timestamp + 3600n;
const rentBefore = await rent.read.balanceOf([deployer]);
const ethToRentTx = await feeRouter.write.swapExactInputEthForRent([0n, deadline], { value: 10n ** 12n });
await wait(ethToRentTx);
const receivedRent = await rent.read.balanceOf([deployer]) - rentBefore;
if (receivedRent <= 0n) throw new Error("ETH to RENT swap returned no RENT");
const rentBack = receivedRent / 10n;
await wait(await rent.write.approve([feeRouter.address, rentBack]));
const rentToEthTx = await feeRouter.write.swapExactInputRentForEth([rentBack, 0n, deadline]);
await wait(rentToEthTx);

const buckets = {
  stockBuyer: await feeRouter.read.stockBuyerAccrued(),
  liquidity: await feeRouter.read.liquidityAccrued(),
  team: await feeRouter.read.teamAccrued(),
  throne: await feeRouter.read.throneAccrued(),
};
const totalFees = await feeRouter.read.totalFeesCollected();
if (buckets.stockBuyer + buckets.liquidity + buckets.team + buckets.throne !== totalFees || totalFees === 0n) {
  throw new Error("Fee conservation failed");
}
const stateViewAbi = [{ type: "function", name: "getSlot0", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint160" }, { type: "int24" }, { type: "uint24" }, { type: "uint24" }] }] as const;
const slot0 = await publicClient.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] });
if (slot0[0] === 0n) throw new Error("Pool is not initialized");

console.log("V6_FEE_ROUTED_POOL_DEPLOYMENT_OK");
console.log(`Ending balance: ${formatEther(await publicClient.getBalance({ address: deployer }))} ETH`);
console.log(`DEPLOYMENT_JSON=${JSON.stringify({
  status: "development-fee-routing",
  deployedAtBlock: Number(await publicClient.getBlockNumber()),
  poolManager: POOL_MANAGER,
  stateView: STATE_VIEW,
  rent: RENT,
  rentHook: hookAddress,
  hookSalt,
  feeRouter: feeRouter.address,
  receivers: {
    stockBuyer: stockBuyerReceiver.address,
    liquidity: liquidityReceiver.address,
    team: teamReceiver.address,
    throne: throneReceiver.address,
  },
  poolId,
  pool: { currency0: zeroAddress, currency1: RENT, fee: 0, tickSpacing: 60, initialSqrtPriceX96: sqrtPriceX96.toString(), initialLiquidity: "1000000000000000" },
  fee: { totalBps: 500, stockBuyerPercent: 70, liquidityPercent: 20, teamPercent: 9, thronePercent: 1 },
  smokeTransactions: { ethToRent: ethToRentTx, rentToEth: rentToEthTx },
  totalFeesCollected: totalFees.toString(),
})}`);
