// @ts-nocheck -- Hardhat's viem augmentation is generated during compilation.
import { artifacts, network } from "hardhat";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  concatHex, encodeAbiParameters, encodeDeployData, getContractAddress, keccak256,
  numberToHex, stringToHex, toHex, zeroAddress,
} from "viem";
import { loadV6ReleaseConfig, validateV6ExternalContracts, V6_TICKERS } from "./lib/v6-release-config.js";

const { config, path: configPath } = await loadV6ReleaseConfig();
const networkName = config.chainId === 4663 ? "robinhoodMainnet" : "robinhoodTestnet";
const { viem } = await network.create({ network: networkName, chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const deployer = wallet.account.address;
await validateV6ExternalContracts(publicClient, config);
const deployerRoles = [config.roles.multisig, config.roles.guardian, config.roles.attester, config.roles.paymasterSigner];
if (!config.testOnlyMocks) deployerRoles.push(config.roles.keeper);
if (deployerRoles.some((role) => role.toLowerCase() === deployer.toLowerCase())) {
  throw new Error("Disposable deployer must not retain a governance or operational role");
}
const now = (await publicClient.getBlock()).timestamp;
if (!config.testOnlyMocks && BigInt(config.launchAt) < now + 3n * 24n * 60n * 60n) {
  throw new Error("launchAt must leave at least three days for deployment and timelock review");
}

async function wait(hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
  return receipt;
}
async function transferOwnership(contract: any, name: string, owner: `0x${string}`) {
  await wait(await contract.write.transferOwnership([owner]));
  if ((await contract.read.owner()).toLowerCase() !== owner.toLowerCase()) throw new Error(`${name} ownership handoff failed`);
}

const launchAt = BigInt(config.launchAt);
const timelock = await viem.deployContract("DeedsTimelockV6", [config.roles.multisig]);
const ledger = await viem.deployContract("RentLedgerV6", [deployer, launchAt]);
const rewards = await viem.deployContract("StockRewardsV6", [deployer]);
const liquidity = await viem.deployContract("LiquidityV6", [deployer, config.roles.keeper]);
const fairLaunch = await viem.deployContract("FairLaunchV6", [deployer]);
const allocation = await viem.deployContract("RentAllocationV6", [
  ledger.address, launchAt, config.roles.teamVesting, config.roles.treasury, config.roles.strategicVesting,
  liquidity.address, fairLaunch.address, config.roles.insurance,
]);
const rentAddress = await allocation.read.rent();
const emitterAddress = await allocation.read.emitter();
const oracle = await viem.deployContract("EthUsdOracleV6", [config.external.ethUsdFeed]);
const gate = await viem.deployContract("GeoGateV6", [deployer]);
const buyer = await viem.deployContract("StockBuyerV6", [deployer, config.roles.keeper, rewards.address]);
const burn = await viem.deployContract("RentBuyBurnV6", [deployer, config.roles.keeper]);
const thronePool = await viem.deployContract("ThronePoolV6", [deployer, rewards.address]);
const founder = await viem.deployContract("FounderShareV6", [deployer, config.roles.founder, config.roles.treasury]);

const nextNonce = BigInt(await publicClient.getTransactionCount({ address: deployer, blockTag: "pending" }));
const predictedJackpot = getContractAddress({ from: deployer, nonce: nextNonce + 1n });
const vault = await viem.deployContract("RentVaultV6", [deployer, oracle.address, burn.address, liquidity.address, predictedJackpot, founder.address]);
const jackpot = await viem.deployContract("JackpotV6", [vault.address, ledger.address, rewards.address]);
if (jackpot.address.toLowerCase() !== predictedJackpot.toLowerCase()) throw new Error("Jackpot deployment address prediction failed");
const deed = await viem.deployContract("DeedV6", [rentAddress, gate.address, vault.address, rewards.address, rewards.address, liquidity.address, launchAt]);

const hookArtifact = await artifacts.readArtifact("RentHookV6");
const hookInitCode = encodeDeployData({ abi: hookArtifact.abi, bytecode: hookArtifact.bytecode, args: [config.external.poolManager, deployer] });
const hookFlags = 0x80n;
const hookMask = (1n << 14n) - 1n;
let hookAddress: `0x${string}`;
let hookSalt: `0x${string}`;
for (let nonce = 0n;; ++nonce) {
  hookSalt = numberToHex(nonce, { size: 32 });
  hookAddress = getContractAddress({ opcode: "CREATE2", from: config.external.create2Factory, salt: hookSalt, bytecode: hookInitCode });
  if ((BigInt(hookAddress) & hookMask) !== hookFlags) continue;
  const code = await publicClient.getCode({ address: hookAddress });
  if (!code || code === "0x") break;
}
await wait(await wallet.sendTransaction({ to: config.external.create2Factory, data: concatHex([hookSalt, hookInitCode]) }));
const hookCode = await publicClient.getCode({ address: hookAddress });
if (!hookCode || hookCode === "0x") throw new Error("RentHook deployment failed");
const hook = await viem.getContractAt("RentHookV6", hookAddress);
const router = await viem.deployContract("RentFeeRouterV6", [
  config.external.poolManager, rentAddress, hookAddress, buyer.address, liquidity.address, founder.address, thronePool.address,
]);
const poolKey = { currency0: zeroAddress, currency1: rentAddress, fee: 0, tickSpacing: 60, hooks: hookAddress } as const;
const poolId = keccak256(encodeAbiParameters([{ type: "tuple", components: [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
] }], [poolKey]));
await wait(await hook.write.configurePool([poolKey, router.address]));

const adapters: Record<string, `0x${string}`> = {};
for (const ticker of V6_TICKERS) {
  const tickerBytes = stringToHex(ticker, { size: 32 });
  const route = config.stocks[ticker];
  await wait(await rewards.write.configureTicker([tickerBytes, route.token]));
  const adapter = await viem.deployContract("StockRouterAdapterV6", [route.router, config.external.wrappedEth, route.token, route.fee]);
  adapters[ticker] = adapter.address;
  await wait(await buyer.write.configureRoute([tickerBytes, adapter.address]));
}

await wait(await ledger.write.configureVault([vault.address]));
await wait(await vault.write.configureLedger([ledger.address]));
await wait(await vault.write.configureDeed([deed.address]));
await wait(await rewards.write.configureDeed([deed.address]));
await wait(await rewards.write.configureStockBuyer([buyer.address]));
await wait(await buyer.write.configureFeeSource([router.address]));
await wait(await rewards.write.configureRewardSource([jackpot.address, true]));
await wait(await rewards.write.configureRewardSource([thronePool.address, true]));
await wait(await liquidity.write.configureRouter([router.address]));
await wait(await liquidity.write.configureSource([router.address, 1]));
await wait(await liquidity.write.configureSource([vault.address, 1]));
await wait(await liquidity.write.configureSource([deed.address, 2]));
await wait(await burn.write.configure([router.address, vault.address]));
await wait(await founder.write.configure([router.address, vault.address, deed.address]));
await wait(await thronePool.write.configure([deed.address, router.address]));
await wait(await deed.write.configureThronePool([thronePool.address]));
await wait(await fairLaunch.write.configure([router.address, vault.address, liquidity.address]));
await wait(await fairLaunch.write.setLauncher([config.roles.keeper]));
await wait(await router.write.configureLaunch([launchAt + 2n * 86400n, vault.address, fairLaunch.address]));
await wait(await deed.write.setGuardian([config.roles.guardian]));
await wait(await router.write.setGuardian([config.roles.guardian]));
await wait(await gate.write.setAttester([config.roles.attester]));

const auction = await viem.deployContract("ThroneAuctionV6", [deployer, deed.address, gate.address, liquidity.address]);
const discount = await viem.deployContract("RentDiscountV6", [deployer, router.address, vault.address, launchAt]);
await wait(await vault.write.configureRentDiscount([discount.address]));
const locker = await viem.deployContract("RevenueLockerV6", [deployer, rentAddress, launchAt]);
const paymaster = await viem.deployContract("PaymasterV6", [
  config.external.entryPoint, deed.address, config.roles.paymasterSigner, launchAt,
  BigInt(config.paymaster.perIdentityWei), BigInt(config.paymaster.perOperationWei), BigInt(config.paymaster.totalBudgetWei),
]);
for (const codeHash of config.paymaster.accountCodeHashes) await wait(await paymaster.write.allowAccountCode([codeHash, true]));
await wait(await paymaster.write.configure([true, config.roles.paymasterSigner]));
await wait(await paymaster.write.deposit({ value: BigInt(config.paymaster.depositWei) }));
await wait(await paymaster.write.addStake([config.paymaster.unstakeDelaySec], { value: BigInt(config.paymaster.stakeWei) }));

for (const [name, contract] of [
  ["RentLedger", ledger], ["StockRewards", rewards], ["Liquidity", liquidity], ["FairLaunch", fairLaunch],
  ["GeoGate", gate], ["StockBuyer", buyer], ["RentBuyBurn", burn], ["ThronePool", thronePool],
  ["FounderShare", founder], ["RentVault", vault], ["Deed", deed], ["RentFeeRouter", router],
  ["ThroneAuction", auction], ["RentDiscount", discount], ["RevenueLocker", locker], ["Paymaster", paymaster],
] as const) await transferOwnership(contract, name, timelock.address);
await wait(await hook.write.transferAdmin([timelock.address]));

const configHash = keccak256(toHex(await readFile(configPath, "utf8")));
const manifest = {
  release: config.release, status: "candidate-deployed-not-launched", chainId: config.chainId,
  configHash, deployedAtBlock: Number(await publicClient.getBlockNumber()), deployer, launchAt: config.launchAt,
  governance: { multisig: config.roles.multisig, timelock: timelock.address, guardian: config.roles.guardian, attester: config.roles.attester, keeper: config.roles.keeper },
  external: config.external,
  contracts: {
    allocation: allocation.address, rent: rentAddress, emitter: emitterAddress,
    teamVesting: await allocation.read.teamVesting(), strategicVesting: await allocation.read.strategicVesting(),
    oracle: oracle.address, geoGate: gate.address, ledger: ledger.address, vault: vault.address, deed: deed.address,
    rewards: rewards.address, stockBuyer: buyer.address, rentBuyBurn: burn.address, liquidity: liquidity.address,
    fairLaunch: fairLaunch.address, founderShare: founder.address, jackpot: jackpot.address,
    thronePool: thronePool.address, throneAuction: auction.address, rentDiscount: discount.address,
    revenueLocker: locker.address, paymaster: paymaster.address, rentHook: hookAddress, feeRouter: router.address,
  },
  stocks: Object.fromEntries(V6_TICKERS.map((ticker) => [ticker, { ...config.stocks[ticker], adapter: adapters[ticker] }])),
  uniswapV4: { poolId, poolKey, hookSalt, initialized: false },
  gates: { phaseTwoConnected: false, landlordEnabled: false, blackoutScheduled: false, securityAuditComplete: false },
};
const manifestPath = resolve(dirname(configPath), `${config.release}.manifest.json`);
await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log("V6_CANDIDATE_DEPLOYED_NOT_LAUNCHED");
console.log(`Manifest: ${manifestPath}`);
console.log(`Config hash: ${configHash}`);
console.log("No liquidity was seeded and trading remains closed. Run verification before the separately authorized launch procedure.");
