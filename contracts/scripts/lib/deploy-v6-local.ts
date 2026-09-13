// @ts-nocheck -- Hardhat's runtime viem augmentation is generated during compilation.
import { network } from "hardhat";
import { getAddress, getContractAddress, parseEther, stringToHex, zeroAddress, encodeAbiParameters, keccak256 } from "viem";

export const tickers = ["NVDA", "TSLA", "AAPL", "AMZN", "META", "MSFT", "GOOGL", "HOOD", "COIN", "AMD"];
export async function deployConnectedV6(connection?: Awaited<ReturnType<typeof network.create>>) {
  connection ??= await network.create();
  const { viem, networkHelpers } = connection;
  const client = await viem.getPublicClient();
  const chainId = await client.getChainId();
  if (chainId !== 31337) throw new Error("This fixture uses valueless mocks and is restricted to local chain 31337.");
  const [owner, alice, bob, treasury, strategic, insurance] = await viem.getWalletClients();
  const launch = BigInt((await client.getBlock()).timestamp) + 300n;
  const ledger = await viem.deployContract("RentLedgerV6", [owner.account.address, launch]);
  const rewards = await viem.deployContract("StockRewardsV6", [owner.account.address]);
  const liquidity = await viem.deployContract("LiquidityV6", [owner.account.address, owner.account.address]);
  const fairLaunch = await viem.deployContract("FairLaunchV6", [owner.account.address]);
  const allocation = await viem.deployContract("RentAllocationV6", [ledger.address, launch, owner.account.address, treasury.account.address,
    strategic.account.address, liquidity.address, fairLaunch.address, insurance.account.address]);
  const rent = await viem.getContractAt("RentTokenV6", await allocation.read.rent());
  const emitter = await viem.getContractAt("RentEmitterV6", await allocation.read.emitter());
  const gate = await viem.deployContract("GeoGateV6", [owner.account.address]);
  const oracle = await viem.deployContract("MockPriceOracle");
  await oracle.write.setPrice([2_000_000_000n, (await client.getBlock()).timestamp]);
  const buyer = await viem.deployContract("StockBuyerV6", [owner.account.address, owner.account.address, rewards.address]);
  const burn = await viem.deployContract("RentBuyBurnV6", [owner.account.address, owner.account.address]);
  const thronePool = await viem.deployContract("ThronePoolV6", [owner.account.address, rewards.address]);
  const founder = await viem.deployContract("FounderShareV6", [owner.account.address, owner.account.address, treasury.account.address]);
  const nextNonce = BigInt(await client.getTransactionCount({ address: owner.account.address }));
  const jackpotAddress = getContractAddress({ from: owner.account.address, nonce: nextNonce + 1n });
  const vault = await viem.deployContract("RentVaultV6", [owner.account.address, oracle.address, burn.address, liquidity.address, jackpotAddress, founder.address]);
  const jackpot = await viem.deployContract("JackpotV6", [vault.address, ledger.address, rewards.address]);
  if (jackpot.address.toLowerCase() !== jackpotAddress.toLowerCase()) throw new Error("Unexpected deployment nonce");
  const deed = await viem.deployContract("DeedV6", [rent.address, gate.address, vault.address, rewards.address, rewards.address, liquidity.address, launch]);
  const manager = await viem.deployContract("V4PoolManager", [owner.account.address]);
  const hookImpl = await viem.deployContract("RentHookV6Harness", [manager.address, owner.account.address]);
  const hookAddress = getAddress("0x0000000000000000000000000000000000000080");
  await networkHelpers.setCode(hookAddress, await client.getCode({ address: hookImpl.address }));
  const hook = await viem.getContractAt("RentHookV6", hookAddress);
  const router = await viem.deployContract("RentFeeRouterV6", [manager.address, rent.address, hook.address, buyer.address, liquidity.address, founder.address, thronePool.address]);
  const poolKey = { currency0: zeroAddress, currency1: rent.address, fee: 0, tickSpacing: 60, hooks: hook.address };
  await hook.write.configurePool([poolKey, router.address]);
  const seedEth = parseEther("1.5");
  const initialPrice = sqrt(parseEther("50000000") * (1n << 192n) / seedEth);
  await manager.write.initialize([poolKey, initialPrice]);
  await ledger.write.configureVault([vault.address]); await vault.write.configureLedger([ledger.address]);
  await vault.write.configureDeed([deed.address]); await rewards.write.configureDeed([deed.address]);
  await rewards.write.configureStockBuyer([buyer.address]); await buyer.write.configureFeeSource([router.address]);
  const stocks = {}; const adapters = {};
  for (const name of tickers) {
    const ticker = stringToHex(name, { size: 32 });
    stocks[name] = await viem.deployContract("MockStockToken");
    adapters[name] = await viem.deployContract("MockStockSwapAdapter", [1000n * 10n ** 18n]);
    await rewards.write.configureTicker([ticker, stocks[name].address]);
    await buyer.write.configureRoute([ticker, adapters[name].address]);
  }
  await rewards.write.configureRewardSource([jackpot.address, true]);
  await rewards.write.configureRewardSource([thronePool.address, true]);
  await liquidity.write.configureRouter([router.address]);
  await liquidity.write.configureSource([router.address, 1]); await liquidity.write.configureSource([vault.address, 1]); await liquidity.write.configureSource([deed.address, 2]);
  await burn.write.configure([router.address, vault.address]);
  await founder.write.configure([router.address, vault.address, deed.address]);
  await thronePool.write.configure([deed.address, router.address]); await deed.write.configureThronePool([thronePool.address]);
  await fairLaunch.write.configure([router.address, vault.address, liquidity.address]);
  await router.write.configureLaunch([launch + 2n * 86400n, vault.address, fairLaunch.address]);
  const auction = await viem.deployContract("ThroneAuctionV6", [owner.account.address, deed.address, gate.address, liquidity.address]);
  const discount = await viem.deployContract("RentDiscountV6", [owner.account.address, router.address, vault.address, launch]);
  await vault.write.configureRentDiscount([discount.address]);
  const lockers = await viem.deployContract("RevenueLockerV6", [owner.account.address, rent.address, launch]);
  for (const [wallet, name] of [[alice, "alice"], [bob, "bob"]]) {
    await gate.write.attest([wallet.account.address, stringToHex(name, { size: 32 }), launch + 1000n * 86400n]);
    await rent.write.transfer([wallet.account.address, parseEther("1000000")], { account: treasury.account });
    await rent.write.approve([deed.address, parseEther("1000000")], { account: wallet.account });
  }
  const rentIndex = await viem.getContractAt("RentIndexV6", await vault.read.rentIndex());
  async function refresh() {
    await oracle.write.setPrice([2_000_000_000n, (await client.getBlock()).timestamp]); await rentIndex.write.sync();
  }
  async function openLaunch() {
    await networkHelpers.time.increaseTo(launch + 2n * 86400n); await refresh();
    await owner.sendTransaction({ to: fairLaunch.address, value: seedEth }); await fairLaunch.write.seed();
    const now = (await client.getBlock()).timestamp;
    await liquidity.write.reinvest([0n, 0n, seedEth, parseEther("50000000"), 1n, now + 300n]);
    await fairLaunch.write.open();
  }
  const poolId = keccak256(encodeAbiParameters([{ type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }], [poolKey]));
  return { ...connection, client, owner, alice, bob, treasury, strategic, insurance, launch, ledger, rewards, liquidity, fairLaunch, allocation, rent, emitter, gate, oracle, buyer, burn, thronePool, founder, vault, jackpot, deed, manager, hook, router, auction, discount, lockers, stocks, adapters, rentIndex, refresh, openLaunch, poolId, poolKey };
}
function sqrt(value: bigint) { let x = value; let y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + value / x) / 2n; } return x; }
