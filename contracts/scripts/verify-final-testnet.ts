// @ts-nocheck
import { network } from "hardhat";
import { getAddress, isAddress, stringToHex } from "viem";

const NAMES = ["RENT","ORACLE","LIQUIDITY","REWARDS","EXCHANGE","TREASURY","PROCESSOR","SETTLEMENT","DEED","ART","FAUCET","TRADING_POOL"];
const TICKERS = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "NFLX", "AMD", "PLTR"];
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const client = await viem.getPublicClient(); const [wallet] = await viem.getWalletClients();
if (await client.getChainId() !== 46630) throw new Error("Wrong chain");
const a = Object.fromEntries(NAMES.map((name) => [name, env(`FINAL_${name}`)]));
for (const [name, address] of Object.entries(a)) {
  const code = await client.getCode({ address }); if (!code || code === "0x") throw new Error(`${name} has no code`);
}
const rent = await viem.getContractAt("RentToken", a.RENT);
const deed = await viem.getContractAt("contracts/final/Deed.sol:Deed", a.DEED);
const treasury = await viem.getContractAt("RentTreasury", a.TREASURY);
const rewards = await viem.getContractAt("StockRewards", a.REWARDS);
const processor = await viem.getContractAt("FeeProcessor", a.PROCESSOR);
const settlement = await viem.getContractAt("SundaySettlement", a.SETTLEMENT);
const exchange = await viem.getContractAt("TestExchange", a.EXCHANGE);
const faucet = await viem.getContractAt("TestRentFaucet", a.FAUCET);

equal(await rent.read.totalSupply(), 1_000_000_000n * 10n ** 18n, "RENT supply");
equal(await deed.read.rent(), a.RENT, "Deed RENT"); equal(await deed.read.treasury(), a.TREASURY, "Deed Treasury");
equal(await deed.read.feeProcessor(), a.PROCESSOR, "Deed processor"); equal(await deed.read.art(), a.ART, "Deed art");
equal(await treasury.read.deed(), a.DEED, "Treasury Deed"); equal(await treasury.read.settlement(), a.SETTLEMENT, "Treasury settlement");
equal(await settlement.read.treasury(), a.TREASURY, "Settlement Treasury"); equal(await settlement.read.rewards(), a.REWARDS, "Settlement rewards");
equal(await processor.read.rewards(), a.REWARDS, "Processor rewards"); equal(await processor.read.exchange(), a.EXCHANGE, "Processor exchange");
equal(await exchange.read.rent(), a.RENT, "Exchange RENT"); equal(await faucet.read.rent(), a.RENT, "Faucet RENT");
if (!await rewards.read.processor([a.PROCESSOR]) || !await rewards.read.processor([a.SETTLEMENT])) throw new Error("Reward processors missing");
if (await rewards.read.processor([wallet.account.address])) throw new Error("Deployer retained reward processor role");
if (!await processor.read.feeSource([a.DEED]) || !await processor.read.feeSource([a.TRADING_POOL])) throw new Error("Fee sources missing");
if (await deed.read.supportedTicker([stringToHex("COIN", { size: 32 })])) throw new Error("COIN was not removed");

for (const ticker of TICKERS) {
  const key = stringToHex(ticker, { size: 32 }); const expected = env(`STOCK_${ticker}`);
  equal(await rewards.read.stockToken([key]), expected, `${ticker} rewards`);
  equal(await exchange.read.stock([key]), expected, `${ticker} exchange`);
  if (!await deed.read.supportedTicker([key])) throw new Error(`${ticker} unsupported by Deed`);
  if (await exchange.read.stockPerEth([key]) === 0n) throw new Error(`${ticker} exchange rate missing`);
}
if (await rent.read.balanceOf([a.FAUCET]) < 10_000_000n * 10n ** 18n) throw new Error("Faucet underfunded");
if (await rent.read.balanceOf([a.EXCHANGE]) < 100_000_000n * 10n ** 18n) throw new Error("Exchange underfunded");
console.log("FINAL_TESTNET_VERIFIED");
for (const [name, address] of Object.entries(a)) console.log(`${name}=${address}`);

function env(name: string) { const value = process.env[name]; if (!value || !isAddress(value)) throw new Error(`${name} missing`); return getAddress(value); }
function equal(actual: string | bigint, expected: string | bigint, label: string) {
  if (typeof actual === "string" && typeof expected === "string") { if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${label} mismatch`); }
  else if (actual !== expected) throw new Error(`${label} mismatch`);
}
