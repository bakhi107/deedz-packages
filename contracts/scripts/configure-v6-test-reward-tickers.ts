// @ts-nocheck -- Hardhat 3 generated viem augmentation is loaded at runtime.
import { network } from "hardhat";
import { getAddress, stringToHex, zeroAddress } from "viem";

function envAddress(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return getAddress(value);
}

const rewardsAddress = envAddress("V6_STOCK_REWARDS");
const symbols = ["NVDA", "TSLA", "AAPL", "AMZN", "META", "MSFT", "GOOGL", "HOOD", "COIN", "AMD"] as const;
const tokens = Object.fromEntries(symbols.map((symbol) => [symbol, envAddress(`V6_TEST_STOCK_${symbol}`)]));

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
if ((await publicClient.getChainId()) !== 46630) throw new Error("Expected Robinhood testnet chain ID 46630");
const rewards = await viem.getContractAt("StockRewardsV6", rewardsAddress);

for (const symbol of symbols) {
  const ticker = stringToHex(symbol, { size: 32 });
  const token = tokens[symbol];
  const code = await publicClient.getCode({ address: token });
  if (!code || code === "0x") throw new Error(`${symbol} test token has no bytecode at ${token}`);
  const current = await rewards.read.stockToken([ticker]);
  if (getAddress(current) === token) {
    console.log(`${symbol}: already configured`);
    continue;
  }
  if (current !== zeroAddress) throw new Error(`${symbol} is already mapped to a different token: ${current}`);
  const hash = await rewards.write.configureTicker([ticker, token]);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${symbol} configuration failed: ${hash}`);
  console.log(`${symbol}: ${token} (${hash})`);
}

for (const symbol of symbols) {
  const configured = await rewards.read.stockToken([stringToHex(symbol, { size: 32 })]);
  if (getAddress(configured) !== tokens[symbol]) throw new Error(`${symbol} verification failed`);
}
console.log("V6_TEST_REWARD_TICKERS_CONFIGURED");
