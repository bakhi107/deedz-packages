// @ts-nocheck -- Hardhat's viem augmentation is generated during compilation.
import { network } from "hardhat";
import { loadV6ReleaseConfig, validateV6ExternalContracts, V6_TICKERS } from "./lib/v6-release-config.js";

const { config, path } = await loadV6ReleaseConfig();
const networkName = config.chainId === 4663 ? "robinhoodMainnet" : "robinhoodTestnet";
const { viem } = await network.create({ network: networkName, chainType: "generic" });
const publicClient = await viem.getPublicClient();
await validateV6ExternalContracts(publicClient, config);

const tokenAbi = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;
for (const ticker of V6_TICKERS) {
  const route = config.stocks[ticker];
  const [symbol, decimals] = await Promise.all([
    publicClient.readContract({ address: route.token, abi: tokenAbi, functionName: "symbol" }),
    publicClient.readContract({ address: route.token, abi: tokenAbi, functionName: "decimals" }),
  ]);
  if (symbol.toUpperCase() !== ticker && !symbol.toUpperCase().includes(ticker)) {
    throw new Error(`${ticker} token reports unexpected symbol ${symbol}`);
  }
  if (decimals > 18) throw new Error(`${ticker} token has unsupported decimals ${decimals}`);
}

console.log("V6_RELEASE_CONFIGURATION_VALID");
console.log(`Config: ${path}`);
console.log(`Release: ${config.release}`);
console.log(`Chain ID: ${config.chainId}`);
console.log("All required external contracts, Stock Tokens, routers, oracle data, budgets, and multisig bytecode passed validation.");
