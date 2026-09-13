// @ts-nocheck -- Hardhat's viem augmentation is generated during compilation.
import { network } from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { keccak256, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { V6_TICKERS } from "./lib/v6-release-config.js";

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
if ((await publicClient.getChainId()) !== 46630) throw new Error("Mock dependencies may only deploy to Robinhood testnet");

const deployer = wallet.account.address;
const feed = await viem.deployContract("TestEthUsdFeedV6", [3000n * 10n ** 8n]);
const multisig = await viem.deployContract("TestRoleWalletV6", [deployer]);
const guardian = await viem.deployContract("TestRoleWalletV6", [deployer]);
const attester = await viem.deployContract("TestRoleWalletV6", [deployer]);
const keeper = await viem.deployContract("TestRoleWalletV6", [deployer]);

const wrappedEth = "0x7943e237c7F95DA44E0301572D358911207852Fa";
const stocks: Record<string, { token: string; router: string; fee: number }> = {};
for (const ticker of V6_TICKERS) {
  const token = await viem.deployContract("TestStockTokenV6", [ticker]);
  const router = await viem.deployContract("SwapRouterHarnessV6", [wrappedEth, token.address]);
  stocks[ticker] = { token: token.address, router: router.address, fee: 3000 };
}

// Publicly derivable and deliberately insecure: usable only for valueless testnet vouchers.
const signerKey = keccak256(stringToHex("DEEDS_V6_PUBLIC_TESTNET_PAYMASTER_SIGNER"));
const paymasterSigner = privateKeyToAccount(signerKey).address;
const latest = await publicClient.getBlock();
const release = `v6-testnet-mock-${latest.number}`;
const config = {
  release,
  chainId: 46630,
  launchAt: Number(latest.timestamp + 4n * 86400n),
  external: {
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    create2Factory: "0x4e59b44847b379578588920ca78fbf26c0b4956c",
    wrappedEth,
    ethUsdFeed: feed.address,
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032"
  },
  roles: {
    multisig: multisig.address,
    guardian: guardian.address,
    attester: attester.address,
    keeper: keeper.address,
    paymasterSigner,
    founder: multisig.address,
    treasury: multisig.address,
    teamVesting: multisig.address,
    strategicVesting: multisig.address,
    insurance: multisig.address
  },
  paymaster: {
    perIdentityWei: "100000000000000",
    perOperationWei: "20000000000000",
    totalBudgetWei: "1000000000000000",
    depositWei: "1000000000000",
    stakeWei: "1000000000000",
    unstakeDelaySec: 86400,
    accountCodeHashes: [keccak256(stringToHex("DEEDS_V6_TEST_ACCOUNT_RUNTIME"))]
  },
  stocks
};

const output = resolve(process.cwd(), "../../deployments/v6-testnet-mock-config.json");
await mkdir(resolve(process.cwd(), "../../deployments"), { recursive: true });
await writeFile(output, `${JSON.stringify(config, null, 2)}\n`);
console.log("V6_TESTNET_MOCK_DEPENDENCIES_DEPLOYED");
console.log(`Release config: ${output}`);
console.log("All generated tokens, routes, feed, and role wallets are valueless testnet substitutes.");
