// @ts-nocheck
import { artifacts, network } from "hardhat";
import {
  concatHex, encodeAbiParameters, encodeDeployData, formatEther, getContractAddress,
  keccak256, maxUint256, numberToHex, parseEther, stringToHex, zeroAddress,
} from "viem";

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const deployer = wallet.account.address;
if ((await publicClient.getChainId()) !== 46630) throw new Error("Expected Robinhood testnet 46630");
const env = (name: string) => {
  const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value as `0x${string}`;
};
const POOL_MANAGER = env("V6_POOL_MANAGER");
const CREATE2_FACTORY = env("V6_CREATE2_FACTORY");
const TICKERS = ["NVDA", "TSLA", "AAPL", "AMZN", "META", "MSFT", "GOOGL", "NFLX", "COIN", "AMD"];
async function wait(hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
  return receipt;
}

console.log(`COMPLETE_DEPLOYMENT_START ${deployer} ${formatEther(await publicClient.getBalance({ address: deployer }))} ETH`);
const launchedAt = (await publicClient.getBlock()).timestamp;
const rent = await viem.deployContract("RentTokenV6", [deployer]);
const oracle = await viem.deployContract("MockPriceOracle");
await wait(await oracle.write.setPrice([2_000_000_000n, launchedAt]));
const ledger = await viem.deployContract("RentLedgerV6", [deployer, launchedAt]);
const rewards = await viem.deployContract("StockRewardsV6", [deployer]);
const liquidity = await viem.deployContract("LiquidityV6", [deployer, deployer]);
const buyer = await viem.deployContract("StockBuyerV6", [deployer, deployer, rewards.address]);
const burn = await viem.deployContract("RentBuyBurnV6", [deployer, deployer]);
const thronePool = await viem.deployContract("ThronePoolV6", [deployer, rewards.address]);

const nonce = BigInt(await publicClient.getTransactionCount({ address: deployer, blockTag: "pending" }));
const predictedJackpot = getContractAddress({ from: deployer, nonce: nonce + 1n });
const vault = await viem.deployContract("RentVaultV6", [deployer, oracle.address, burn.address, liquidity.address, predictedJackpot, deployer]);
const jackpot = await viem.deployContract("JackpotV6", [vault.address, ledger.address, rewards.address]);
if (jackpot.address.toLowerCase() !== predictedJackpot.toLowerCase()) throw new Error("Jackpot prediction mismatch");
const deed = await viem.deployContract("DeedV6", [rent.address, vault.address, rewards.address, deployer, deployer, launchedAt]);

const hookArtifact = await artifacts.readArtifact("RentHookV6");
const hookInitCode = encodeDeployData({ abi: hookArtifact.abi, bytecode: hookArtifact.bytecode, args: [POOL_MANAGER, deployer] });
const mask = (1n << 14n) - 1n; const flags = 0x80n;
let hookAddress: `0x${string}`; let hookSalt: `0x${string}`;
for (let i = 0n;; ++i) {
  hookSalt = numberToHex(i, { size: 32 });
  hookAddress = getContractAddress({ opcode: "CREATE2", from: CREATE2_FACTORY, salt: hookSalt, bytecode: hookInitCode });
  if ((BigInt(hookAddress) & mask) !== flags) continue;
  const code = await publicClient.getCode({ address: hookAddress }); if (!code || code === "0x") break;
}
await wait(await wallet.sendTransaction({ to: CREATE2_FACTORY, data: concatHex([hookSalt, hookInitCode]) }));
const hook = await viem.getContractAt("RentHookV6", hookAddress);
const router = await viem.deployContract("RentFeeRouterV6", [POOL_MANAGER, rent.address, hookAddress, buyer.address, liquidity.address, deployer]);
const poolKey = { currency0: zeroAddress, currency1: rent.address, fee: 0, tickSpacing: 60, hooks: hookAddress } as const;
const poolId = keccak256(encodeAbiParameters([{ type: "tuple", components: [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
] }], [poolKey]));
await wait(await hook.write.configurePool([poolKey, router.address]));

const stockTokens: Record<string, string> = {}; const adapters: Record<string, string> = {};
for (const ticker of TICKERS) {
  const token = await viem.deployContract("TestStockTokenV6", [ticker]);
  const adapter = await viem.deployContract("MockStockSwapAdapter", [100n * 10n ** 18n]);
  const key = stringToHex(ticker, { size: 32 });
  await wait(await rewards.write.configureTicker([key, token.address]));
  await wait(await buyer.write.configureRoute([key, adapter.address]));
  stockTokens[ticker] = token.address; adapters[ticker] = adapter.address;
}

const auction = await viem.deployContract("ThroneAuctionV6", [deployer, deed.address, liquidity.address]);
const discount = await viem.deployContract("RentDiscountV6", [deployer, router.address, vault.address, launchedAt]);
await wait(await ledger.write.configureVault([vault.address]));
await wait(await vault.write.configureLedger([ledger.address]));
await wait(await vault.write.configureDeed([deed.address]));
await wait(await vault.write.configureRentDiscount([discount.address]));
await wait(await rewards.write.configureDeed([deed.address]));
await wait(await rewards.write.configureStockBuyer([buyer.address]));
await wait(await rewards.write.configureRewardSource([jackpot.address, true]));
await wait(await rewards.write.configureRewardSource([thronePool.address, true]));
await wait(await buyer.write.configureFeeSource([router.address]));
await wait(await liquidity.write.configureRouter([router.address]));
await wait(await liquidity.write.configureSource([router.address, 1]));
await wait(await liquidity.write.configureSource([vault.address, 1]));
await wait(await burn.write.configure([router.address, vault.address]));
await wait(await thronePool.write.configure([deed.address]));
await wait(await deed.write.configureThronePool([thronePool.address]));
await wait(await deed.write.configureThroneAuction([auction.address]));

const manager = await viem.getContractAt("V4PoolManager", POOL_MANAGER);
const sqrtPriceX96 = 1_000n * (2n ** 96n);
await wait(await manager.write.initialize([poolKey, sqrtPriceX96]));
const seedRent = 1_000n * 10n ** 18n; const seedEth = parseEther("0.001");
await wait(await rent.write.transfer([liquidity.address, seedRent]));
await wait(await wallet.sendTransaction({ to: liquidity.address, value: seedEth }));
const seedDeadline = (await publicClient.getBlock()).timestamp + 600n;
await wait(await liquidity.write.reinvest([0n, 0n, seedEth, seedRent, 1n, seedDeadline]));

for (const recipient of ["0xC878Cc072aC3a869A938A99DA404D25850835a20", "0x9F641eD89C3583987450117dfe14a8e644b1Ea15"] as const) {
  await wait(await rent.write.transfer([recipient, 100_000n * 10n ** 18n]));
}
const result = {
  chainId: 46630, deployedAtBlock: Number(await publicClient.getBlockNumber()), launchedAt: launchedAt.toString(),
  contracts: { rent: rent.address, oracle: oracle.address, ledger: ledger.address, rewards: rewards.address,
    liquidity: liquidity.address, stockBuyer: buyer.address, rentBuyBurn: burn.address, thronePool: thronePool.address,
    vault: vault.address, jackpot: jackpot.address, deed: deed.address, artwork: await deed.read.artwork(),
    rentIndex: await vault.read.rentIndex(), hook: hookAddress, feeRouter: router.address,
    throneAuction: auction.address, rentDiscount: discount.address },
  pool: { poolId, poolManager: POOL_MANAGER, hookSalt }, stockTokens, adapters,
};
console.log("COMPLETE_DEEDZ_TESTNET_DEPLOYMENT_OK");
console.log(`DEPLOYMENT_JSON=${JSON.stringify(result)}`);
