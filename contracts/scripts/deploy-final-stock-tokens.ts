import hre from "hardhat";

const MISSING_TICKERS = ["NVDA", "AAPL", "MSFT", "META", "GOOGL"] as const;

const { viem } = await hre.network.connect();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();

if (chainId !== 46630) throw new Error(`Refusing to deploy test tokens on chain ${chainId}`);

console.log(`Deploying five missing test stock tokens from ${deployer.account.address}`);

for (const ticker of MISSING_TICKERS) {
  const token = await viem.deployContract("TestStockToken", [ticker, deployer.account.address]);
  console.log(`${ticker}=${token.address}`);
}
