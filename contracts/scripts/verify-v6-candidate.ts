// @ts-nocheck -- Hardhat's viem augmentation is generated during compilation.
import { network } from "hardhat";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encodeAbiParameters, getAddress, keccak256, stringToHex, toHex, zeroAddress } from "viem";
import { loadV6ReleaseConfig, validateV6ExternalContracts, V6_TICKERS } from "./lib/v6-release-config.js";

const manifestSetting = process.env.V6_CANDIDATE_MANIFEST;
if (!manifestSetting) throw new Error("Set V6_CANDIDATE_MANIFEST to the candidate manifest");
const manifestPath = resolve(process.cwd(), manifestSetting);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const { config, path: configPath } = await loadV6ReleaseConfig();
if (manifest.release !== config.release || manifest.chainId !== config.chainId) throw new Error("Manifest/config release mismatch");
const configHash = keccak256(toHex(await readFile(configPath, "utf8")));
if (manifest.configHash !== configHash) throw new Error("Release configuration changed after deployment");

const networkName = config.chainId === 4663 ? "robinhoodMainnet" : "robinhoodTestnet";
const { viem } = await network.create({ network: networkName, chainType: "generic" });
const publicClient = await viem.getPublicClient();
await validateV6ExternalContracts(publicClient, config);
for (const [name, target] of Object.entries({ ...manifest.contracts, timelock: manifest.governance.timelock })) {
  const code = await publicClient.getCode({ address: target });
  if (!code || code === "0x") throw new Error(`${name} has no deployed bytecode`);
}

const c = manifest.contracts;
const timelock = getAddress(manifest.governance.timelock);
const deed = await viem.getContractAt("DeedV6", c.deed);
const vault = await viem.getContractAt("RentVaultV6", c.vault);
const ledger = await viem.getContractAt("RentLedgerV6", c.ledger);
const rewards = await viem.getContractAt("StockRewardsV6", c.rewards);
const buyer = await viem.getContractAt("StockBuyerV6", c.stockBuyer);
const router = await viem.getContractAt("RentFeeRouterV6", c.feeRouter);
const hook = await viem.getContractAt("RentHookV6", c.rentHook);
const liquidity = await viem.getContractAt("LiquidityV6", c.liquidity);
const fairLaunch = await viem.getContractAt("FairLaunchV6", c.fairLaunch);
const allocation = await viem.getContractAt("RentAllocationV6", c.allocation);
const rent = await viem.getContractAt("RentTokenV6", c.rent);
const paymaster = await viem.getContractAt("PaymasterV6", c.paymaster);

function same(actual: string, expected: string, field: string) {
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${field}: expected ${expected}, received ${actual}`);
}
for (const name of ["ledger", "rewards", "stockBuyer", "rentBuyBurn", "liquidity", "fairLaunch", "founderShare", "vault", "deed", "feeRouter", "thronePool", "throneAuction", "rentDiscount", "revenueLocker", "paymaster"] as const) {
  const contract = await viem.getContractAt(name === "ledger" ? "RentLedgerV6" : {
    rewards: "StockRewardsV6", stockBuyer: "StockBuyerV6", rentBuyBurn: "RentBuyBurnV6", liquidity: "LiquidityV6",
    fairLaunch: "FairLaunchV6", founderShare: "FounderShareV6", vault: "RentVaultV6", deed: "DeedV6",
    feeRouter: "RentFeeRouterV6", thronePool: "ThronePoolV6", throneAuction: "ThroneAuctionV6",
    rentDiscount: "RentDiscountV6", revenueLocker: "RevenueLockerV6", paymaster: "PaymasterV6",
  }[name], c[name]);
  same(await contract.read.owner(), timelock, `${name}.owner`);
}
same(await hook.read.admin(), timelock, "rentHook.admin");
same(await deed.read.rent(), c.rent, "deed.rent");
same(await deed.read.geoGate(), c.geoGate, "deed.geoGate");
same(await deed.read.rentVault(), c.vault, "deed.vault");
same(await deed.read.stockRewards(), c.rewards, "deed.rewards");
same(await vault.read.deed(), c.deed, "vault.deed");
same(await vault.read.ledger(), c.ledger, "vault.ledger");
same(await ledger.read.vault(), c.vault, "ledger.vault");
same(await rewards.read.deed(), c.deed, "rewards.deed");
same(await rewards.read.stockBuyer(), c.stockBuyer, "rewards.stockBuyer");
same(await buyer.read.feeSource(), c.feeRouter, "buyer.feeSource");
same(await router.read.poolManager(), config.external.poolManager, "router.poolManager");
same(await router.read.hook(), c.rentHook, "router.hook");
same(await liquidity.read.router(), c.feeRouter, "liquidity.router");
same(await liquidity.read.executor(), config.roles.keeper, "liquidity.executor");
same(await fairLaunch.read.launcher(), config.roles.keeper, "fairLaunch.launcher");
same(await buyer.read.executor(), config.roles.keeper, "buyer.executor");
same(await deed.read.guardian(), config.roles.guardian, "deed.guardian");
same(await router.read.guardian(), config.roles.guardian, "router.guardian");

if (await rent.read.totalSupply() !== 1_000_000_000n * 10n ** 18n) throw new Error("RENT supply is not exactly one billion");
if (await rent.read.balanceOf([c.emitter]) !== 400_000_000n * 10n ** 18n) throw new Error("Emitter allocation mismatch");
if (await rent.read.balanceOf([c.fairLaunch]) !== 50_000_000n * 10n ** 18n) throw new Error("Fair launch allocation mismatch");
if (await rent.read.balanceOf([c.liquidity]) !== 20_000_000n * 10n ** 18n) throw new Error("Permanent liquidity allocation mismatch");
if (await deed.read.fusionEnabled() || await deed.read.landlordEnabled()) throw new Error("Phase-two Deed policy must be disabled at launch");
const auction = await viem.getContractAt("ThroneAuctionV6", c.throneAuction);
const discount = await viem.getContractAt("RentDiscountV6", c.rentDiscount);
const locker = await viem.getContractAt("RevenueLockerV6", c.revenueLocker);
if (await auction.read.enabled() || await discount.read.enabled() || await locker.read.enabled()) throw new Error("Disconnected phase-two modules are enabled");
if (!(await paymaster.read.enabled())) throw new Error("Launch paymaster is disabled");
if (await paymaster.read.getDeposit() < BigInt(config.paymaster.depositWei)) throw new Error("Paymaster EntryPoint deposit is below configuration");
for (const hash of config.paymaster.accountCodeHashes) if (!(await paymaster.read.accountCodeHash([hash]))) throw new Error(`Paymaster code hash ${hash} is not allowed`);

const key = { currency0: zeroAddress, currency1: c.rent, fee: 0, tickSpacing: 60, hooks: c.rentHook } as const;
const poolId = keccak256(encodeAbiParameters([{ type: "tuple", components: [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
] }], [key]));
if (poolId !== manifest.uniswapV4.poolId) throw new Error("Pool ID mismatch");
same(await hook.read.poolRouter([poolId]), c.feeRouter, "hook.poolRouter");
for (const ticker of V6_TICKERS) {
  const tickerBytes = stringToHex(ticker, { size: 32 });
  same(await rewards.read.stockToken([tickerBytes]), config.stocks[ticker].token, `${ticker}.rewardToken`);
  same(await buyer.read.swapAdapter([tickerBytes]), manifest.stocks[ticker].adapter, `${ticker}.adapter`);
  const adapter = await viem.getContractAt("StockRouterAdapterV6", manifest.stocks[ticker].adapter);
  same(await adapter.read.router(), config.stocks[ticker].router, `${ticker}.router`);
  same(await adapter.read.weth(), config.external.wrappedEth, `${ticker}.weth`);
  same(await adapter.read.stock(), config.stocks[ticker].token, `${ticker}.stock`);
}

const accessAbi = [
  { type: "function", name: "getMinDelay", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "PROPOSER_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "EXECUTOR_ROLE", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] },
] as const;
if (await publicClient.readContract({ address: timelock, abi: accessAbi, functionName: "getMinDelay" }) < 2n * 86400n) throw new Error("Timelock delay is below two days");
for (const roleName of ["PROPOSER_ROLE", "EXECUTOR_ROLE"] as const) {
  const role = await publicClient.readContract({ address: timelock, abi: accessAbi, functionName: roleName });
  if (!(await publicClient.readContract({ address: timelock, abi: accessAbi, functionName: "hasRole", args: [role, config.roles.multisig] }))) throw new Error(`Multisig lacks ${roleName}`);
}

console.log("V6_CANDIDATE_VERIFIED");
console.log(`Release: ${manifest.release}`);
console.log(`Manifest: ${manifestPath}`);
console.log(`Block: ${await publicClient.getBlockNumber()}`);
console.log("Bytecode, immutable wiring, token allocations, adapters, governance, launch guards, and disconnected phase-two state all match the reviewed config.");
