// @ts-nocheck
import { network } from "hardhat";
import { formatEther, formatUnits, getAddress, isAddress } from "viem";

const TICKERS = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "NFLX", "AMD", "PLTR"];
const MOCKS = new Set(["NVDA", "AAPL", "MSFT", "META", "GOOGL"]);
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const client = await viem.getPublicClient(); const [wallet] = await viem.getWalletClients();
if (await client.getChainId() !== 46630) throw new Error("Wrong chain");
const eth = await client.getBalance({ address: wallet.account.address });
if (eth < 5_000_000_000_000_000n) throw new Error(`Deployment wallet ETH is too low: ${formatEther(eth)}`);
console.log(`Deployer ${wallet.account.address}: ${formatEther(eth)} ETH`);
for (const ticker of TICKERS) {
  const raw = process.env[`STOCK_${ticker}`]; if (!raw || !isAddress(raw)) throw new Error(`STOCK_${ticker} missing`);
  const address = getAddress(raw); const code = await client.getCode({ address }); if (!code || code === "0x") throw new Error(`${ticker} has no code`);
  const token = await viem.getContractAt("TestStockToken", address);
  if (await token.read.symbol() !== ticker || await token.read.decimals() !== 18) throw new Error(`${ticker} metadata mismatch`);
  if (MOCKS.has(ticker)) {
    if ((await token.read.owner()).toLowerCase() !== wallet.account.address.toLowerCase()) throw new Error(`${ticker} mock owner mismatch`);
    console.log(`${ticker}: verified mock`);
  } else {
    const balance = await token.read.balanceOf([wallet.account.address]); if (balance === 0n) throw new Error(`${ticker} reserve unavailable`);
    console.log(`${ticker}: Robinhood token, deployer reserve ${formatUnits(balance, 18)}`);
  }
}
console.log("FINAL_TESTNET_PREFLIGHT_OK");
