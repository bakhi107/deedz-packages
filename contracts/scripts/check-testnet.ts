import { formatEther } from "viem";
import { network } from "hardhat";

const { viem } = await network.create({
  network: "robinhoodTestnet",
  chainType: "generic",
});

const publicClient = await viem.getPublicClient();
const [walletClient] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();
const blockNumber = await publicClient.getBlockNumber();
const balance = await publicClient.getBalance({ address: walletClient.account.address });

console.log(`Robinhood testnet chain ID: ${chainId}`);
console.log(`Latest block: ${blockNumber}`);
console.log("Deployment wallet: configured");
console.log(`Deployment wallet gas balance: ${formatEther(balance)} ETH`);

if (chainId !== 46630) {
  throw new Error(`Expected Robinhood testnet chain ID 46630, received ${chainId}`);
}

