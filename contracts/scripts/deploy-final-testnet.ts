// @ts-nocheck -- Hardhat's viem augmentation is generated during compilation.
import { network } from "hardhat";
import { getAddress, isAddress, parseEther, stringToHex, type Address, type Hash } from "viem";

const TICKERS = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "NFLX", "AMD", "PLTR"] as const;
const MOCKS = new Set(["NVDA", "AAPL", "MSFT", "META", "GOOGL"]);
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
if (await publicClient.getChainId() !== 46630) throw new Error("This deployment is Robinhood Testnet-only");

const owner = deployer.account.address;
const keeper = addressFromEnv("KEEPER_ADDRESS", owner);
const team = addressFromEnv("TEAM_ADDRESS", owner);
const stocks = Object.fromEntries(TICKERS.map((ticker) => [ticker, addressFromEnv(`STOCK_${ticker}`)])) as Record<typeof TICKERS[number], Address>;

async function mined(hashPromise: Promise<Hash>) { await publicClient.waitForTransactionReceipt({ hash: await hashPromise }); }
console.log(`Owner=${owner}\nKeeper=${keeper}\nTeam=${team}`);

const rent = await viem.deployContract("RentToken", [owner]);
const oracle = await viem.deployContract("TestPriceFeed", [owner, 2_500_000_000n]);
const liquidity = await viem.deployContract("ProtocolLiquidity", [owner]);
const rewards = await viem.deployContract("StockRewards", [owner, owner]);
const exchange = await viem.deployContract("TestExchange", [owner, rent.address]);
const treasury = await viem.deployContract("RentTreasury", [owner, keeper, team, oracle.address]);
const processor = await viem.deployContract("FeeProcessor", [owner, keeper, rewards.address, exchange.address, liquidity.address, team]);
const settlement = await viem.deployContract("SundaySettlement", [owner, keeper, treasury.address, rewards.address, rent.address, exchange.address, liquidity.address, team]);
const deed = await viem.deployContract("contracts/final/Deed.sol:Deed", [owner, rent.address, treasury.address, processor.address]);
const faucet = await viem.deployContract("TestRentFaucet", [rent.address]);
const tradingPool = await viem.deployContract("TestTradingPool", [owner, rent.address, processor.address, 1_000_000n * 10n ** 18n]);

await mined(treasury.write.configureDeed([deed.address]));
await mined(treasury.write.configureSettlement([settlement.address]));
await mined(rewards.write.setProcessor([processor.address, true]));
await mined(rewards.write.setProcessor([settlement.address, true]));
await mined(rewards.write.setProcessor([owner, false]));
await mined(processor.write.setFeeSource([deed.address, true]));
await mined(processor.write.setFeeSource([tradingPool.address, true]));
await mined(processor.write.setLiquidity([tradingPool.address]));
await mined(settlement.write.setLiquidity([tradingPool.address]));
await mined(exchange.write.setRentRate([1_000_000n * 10n ** 18n]));

for (const ticker of TICKERS) {
  const token = await viem.getContractAt("TestStockToken", stocks[ticker]);
  const code = await publicClient.getCode({ address: stocks[ticker] });
  if (!code || code === "0x" || await token.read.symbol() !== ticker) throw new Error(`${ticker} token verification failed`);
  const key = stringToHex(ticker, { size: 32 });
  await mined(rewards.write.configureStock([key, stocks[ticker]]));
  await mined(exchange.write.configureStock([key, stocks[ticker], 1_000n * 10n ** 18n]));
  if (MOCKS.has(ticker)) await mined(token.write.mint([exchange.address, 1_000_000n * 10n ** 18n]));
  else {
    const balance = await token.read.balanceOf([owner]);
    const reserve = balance > 20n * 10n ** 18n ? 20n * 10n ** 18n : balance / 2n;
    if (reserve == 0n) throw new Error(`${ticker} deployer reserve is empty`);
    await mined(token.write.transfer([exchange.address, reserve]));
  }
}

await mined(rent.write.transfer([faucet.address, 10_000_000n * 10n ** 18n]));
await mined(rent.write.transfer([exchange.address, 100_000_000n * 10n ** 18n]));
await mined(rent.write.transfer([tradingPool.address, 10_000_000n * 10n ** 18n]));
await mined(deployer.sendTransaction({ to: tradingPool.address, value: parseEther("0.003") }));

console.log("\nFINAL TESTNET ADDRESSES");
for (const [name, address] of Object.entries({ rent: rent.address, oracle: oracle.address, liquidity: liquidity.address, rewards: rewards.address, exchange: exchange.address, treasury: treasury.address, processor: processor.address, settlement: settlement.address, deed: deed.address, art: await deed.read.art(), faucet: faucet.address, tradingPool: tradingPool.address })) {
  console.log(`FINAL_${name.toUpperCase()}=${getAddress(address)}`);
}

function addressFromEnv(name: string, fallback?: Address): Address {
  const value = process.env[name] ?? fallback;
  if (!value || !isAddress(value)) throw new Error(`${name} is missing or invalid`);
  return getAddress(value);
}
