import toolbox from "@nomicfoundation/hardhat-toolbox-viem";
import { defineConfig } from "hardhat/config";

// Deliberately does not load a private .env or configure a live signing network.
export default defineConfig({
  plugins: [toolbox],
  solidity: { version: "0.8.26", settings: {optimizer:{enabled:true,runs:200},viaIR:true,evmVersion:"cancun"} },
  chainDescriptors: {46630:{name:"Robinhood testnet fork source",chainType:"generic",hardforkHistory:{cancun:{blockNumber:0}}},4663:{name:"Robinhood fork source",chainType:"generic",hardforkHistory:{cancun:{blockNumber:0}}}},
  networks: {
    stockFork: {type:"edr-simulated",chainType:"generic",chainId:31337,hardfork:"cancun",
      forking:{url:process.env.STOCK_FORK_RPC ?? "https://rpc.mainnet.chain.robinhood.com", ...(process.env.STOCK_FORK_BLOCK?{blockNumber:Number(process.env.STOCK_FORK_BLOCK)}:{})}},
    stockTestnetFork: {type:"edr-simulated",chainType:"generic",chainId:31337,hardfork:"cancun",forking:{url:"https://rpc.testnet.chain.robinhood.com"}},
    stockUnit: {type:"edr-simulated",chainType:"generic",chainId:31337,hardfork:"cancun"},
  },
});
