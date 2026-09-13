// @ts-nocheck -- Hardhat's viem augmentation is generated during compilation.
import { network } from "hardhat";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEther } from "viem";
import { loadV6ReleaseConfig } from "./lib/v6-release-config.js";

const manifestSetting = process.env.V6_CANDIDATE_MANIFEST;
const seedSetting = process.env.V6_FAIR_LAUNCH_ETH_WEI;
const minimumLiquiditySetting = process.env.V6_MIN_INITIAL_LIQUIDITY;
if (!manifestSetting || !seedSetting || !/^\d+$/.test(seedSetting)) throw new Error("Set V6_CANDIDATE_MANIFEST and V6_FAIR_LAUNCH_ETH_WEI");
if (!minimumLiquiditySetting || !/^\d+$/.test(minimumLiquiditySetting) || BigInt(minimumLiquiditySetting) === 0n) throw new Error("Set a reviewed non-zero V6_MIN_INITIAL_LIQUIDITY");
if (process.env.V6_CONFIRM_LAUNCH !== "I_UNDERSTAND_THIS_OPENS_TRADING") throw new Error("Set V6_CONFIRM_LAUNCH=I_UNDERSTAND_THIS_OPENS_TRADING after multisig review");

const manifestPath = resolve(process.cwd(), manifestSetting);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const { config } = await loadV6ReleaseConfig();
if (manifest.release !== config.release || manifest.chainId !== config.chainId || manifest.status !== "candidate-deployed-not-launched") throw new Error("Candidate is not in a launchable state");
const networkName = config.chainId === 4663 ? "robinhoodMainnet" : "robinhoodTestnet";
const { viem } = await network.create({ network: networkName, chainType: "generic" });
const publicClient = await viem.getPublicClient();
const [wallet] = await viem.getWalletClients();
const now = (await publicClient.getBlock()).timestamp;
const opensAt = BigInt(config.launchAt) + 2n * 86400n;
if (now < opensAt || now > opensAt + 3600n) throw new Error("Launch must execute during the reviewed day-two launch hour");
if (wallet.account.address.toLowerCase() !== config.roles.keeper.toLowerCase()) throw new Error("Launch must be signed by the configured keeper/launcher");

async function wait(hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`);
  return hash;
}
const c = manifest.contracts;
const vault = await viem.getContractAt("RentVaultV6", c.vault);
const fairLaunch = await viem.getContractAt("FairLaunchV6", c.fairLaunch);
const liquidity = await viem.getContractAt("LiquidityV6", c.liquidity);
const manager = await viem.getContractAt("V4PoolManager", config.external.poolManager);
const seed = BigInt(seedSetting);
const required = await vault.read.usdToEth([3_000_000_000n]);
if (seed < required || seed > required * 110n / 100n) throw new Error("Fair-launch ETH must cover approximately $3,000 without exceeding the 10% review bound");
if (await fairLaunch.read.seeded()) throw new Error("Fair launch is already seeded");

const rentSeed = parseEther("50000000");
const sqrtPriceX96 = sqrt(rentSeed * (1n << 192n) / seed);
const initialize = await wait(await manager.write.initialize([manifest.uniswapV4.poolKey, sqrtPriceX96]));
const fund = await wait(await wallet.sendTransaction({ to: c.fairLaunch, value: seed }));
const seedTx = await wait(await fairLaunch.write.seed());
const addLiquidity = await wait(await liquidity.write.reinvest([
  0n, 0n, seed, rentSeed, BigInt(minimumLiquiditySetting), (await publicClient.getBlock()).timestamp + 300n,
]));
const open = await wait(await fairLaunch.write.open());
if (!(await (await viem.getContractAt("RentFeeRouterV6", c.feeRouter)).read.launchReady())) throw new Error("Router did not open");

manifest.status = "candidate-launched-unaudited";
manifest.uniswapV4.initialized = true;
manifest.uniswapV4.initialSqrtPriceX96 = sqrtPriceX96.toString();
manifest.uniswapV4.initialRent = rentSeed.toString();
manifest.uniswapV4.initialEth = seed.toString();
manifest.launchedAtBlock = Number(await publicClient.getBlockNumber());
manifest.launchTransactions = { initialize, fund, seed: seedTx, addLiquidity, open };
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log("V6_CANDIDATE_LAUNCHED_UNAUDITED");
console.log(`Manifest: ${manifestPath}`);
console.log("Trading is open. Security audit and all non-code release gates must still be recorded before production labeling.");

function sqrt(value: bigint) {
  if (value < 0n) throw new Error("Cannot calculate a negative square root");
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + value / x) / 2n; }
  return x;
}
