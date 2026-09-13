import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const configDir = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(configDir, "../../../.env"), quiet: true });
loadEnv({ path: resolve(configDir, ".env.robinhood-testnet"), quiet: true });
loadEnv({ path: resolve(configDir, ".env"), quiet: true });

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
      production: {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
      },
    },
  },
  chainDescriptors: {
    11155111: {
      name: "Ethereum Sepolia",
      chainType: "generic",
      blockExplorers: {
        etherscan: {
          name: "Sepolia Etherscan",
          url: "https://sepolia.etherscan.io",
          apiUrl: "https://api-sepolia.etherscan.io/api",
        },
      },
    },
    4663: {
      name: "Robinhood Chain",
      chainType: "generic",
      blockExplorers: {
        blockscout: {
          name: "Robinhood Chain Blockscout",
          url: "https://robinhoodchain.blockscout.com",
          apiUrl: "https://robinhoodchain.blockscout.com/api",
        },
      },
    },
    46630: {
      name: "Robinhood Chain Testnet",
      chainType: "generic",
      blockExplorers: {
        blockscout: {
          name: "Robinhood Chain Testnet Blockscout",
          url: "https://explorer.testnet.chain.robinhood.com",
          apiUrl: "https://explorer.testnet.chain.robinhood.com/api",
        },
      },
    },
  },
  networks: {
    hardhatMainnet: { type: "edr-simulated", chainType: "generic" },
    sepolia: {
      type: "http",
      chainType: "generic",
      chainId: 11155111,
      url: "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: [configVariable("PRIVATE_KEY")],
    },
    robinhoodTestnet: {
      type: "http",
      chainType: "generic",
      chainId: 46630,
      url: process.env.ROBINHOOD_TESTNET_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com",
      accounts: [configVariable("PRIVATE_KEY")],
    },
    robinhoodMainnet: {
      type: "http",
      chainType: "generic",
      chainId: 4663,
      url: "https://rpc.mainnet.chain.robinhood.com",
      accounts: [configVariable("PRIVATE_KEY")],
    },
  },
});
