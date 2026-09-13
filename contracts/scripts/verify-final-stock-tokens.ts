import hre from "hardhat";
import { getAddress, isAddress } from "viem";

const TICKERS = ["NVDA", "AAPL", "MSFT", "META", "GOOGL"] as const;
const { viem } = await hre.network.connect();
const publicClient = await viem.getPublicClient();

if (await publicClient.getChainId() !== 46630) throw new Error("Wrong network");

for (const ticker of TICKERS) {
  const raw = process.env[`STOCK_${ticker}`];
  if (!raw || !isAddress(raw)) throw new Error(`STOCK_${ticker} is missing or invalid`);
  const address = getAddress(raw);
  const code = await publicClient.getCode({ address });
  if (!code || code === "0x") throw new Error(`${ticker} has no deployed bytecode`);
  const token = await viem.getContractAt("TestStockToken", address);
  const [name, symbol, decimals, owner] = await Promise.all([
    token.read.name(), token.read.symbol(), token.read.decimals(), token.read.owner(),
  ]);
  if (name !== ticker || symbol !== ticker || decimals !== 18 || owner.toLowerCase() === "0x0000000000000000000000000000000000000000") {
    throw new Error(`${ticker} failed metadata/ownership verification`);
  }
  console.log(`${ticker}=${address} verified; owner=${owner}`);
}
