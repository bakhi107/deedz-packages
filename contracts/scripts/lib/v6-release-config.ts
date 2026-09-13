import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAddress, isAddress, type Address, type PublicClient } from "viem";

export const V6_TICKERS = ["NVDA", "TSLA", "AAPL", "AMZN", "META", "MSFT", "GOOGL", "NFLX", "COIN", "AMD"] as const;

type StockRoute = { token: Address; router: Address; fee: number };
export type V6ReleaseConfig = {
  release: string;
  chainId: 4663 | 46630;
  testOnlyMocks?: boolean;
  launchAt: number;
  external: {
    poolManager: Address;
    stateView: Address;
    create2Factory: Address;
    wrappedEth: Address;
    ethUsdFeed: Address;
    entryPoint: Address;
  };
  roles: {
    multisig: Address;
    guardian: Address;
    attester: Address;
    keeper: Address;
    paymasterSigner: Address;
    founder: Address;
    treasury: Address;
    teamVesting: Address;
    strategicVesting: Address;
    insurance: Address;
  };
  paymaster: {
    perIdentityWei: string;
    perOperationWei: string;
    totalBudgetWei: string;
    depositWei: string;
    stakeWei: string;
    unstakeDelaySec: number;
    accountCodeHashes: `0x${string}`[];
  };
  stocks: Record<(typeof V6_TICKERS)[number], StockRoute>;
};

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value) || /^0x0{40}$/i.test(value)) {
    throw new Error(`${field} must be a non-zero address`);
  }
  return getAddress(value);
}

function positiveInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${field} must be a positive integer`);
  return Number(value);
}

function positiveBigInt(value: unknown, field: string) {
  if (typeof value !== "string" || !/^\d+$/.test(value) || BigInt(value) <= 0n) throw new Error(`${field} must be a positive integer string`);
  return value;
}

export async function loadV6ReleaseConfig(): Promise<{ config: V6ReleaseConfig; path: string }> {
  const configuredPath = process.env.V6_RELEASE_CONFIG;
  if (!configuredPath) throw new Error("Set V6_RELEASE_CONFIG to a reviewed release JSON file");
  const path = resolve(process.cwd(), configuredPath);
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, any>;
  if (raw.chainId !== 4663 && raw.chainId !== 46630) throw new Error("chainId must be Robinhood mainnet 4663 or testnet 46630");
  if (typeof raw.release !== "string" || !/^[a-z0-9][a-z0-9._-]{2,63}$/i.test(raw.release)) throw new Error("Invalid release name");

  // Normalize into a copy so rebuilding nested objects cannot erase the raw input
  // before its fields have been validated.
  const config = structuredClone(raw) as V6ReleaseConfig;
  config.testOnlyMocks = raw.testOnlyMocks === true;
  if (config.testOnlyMocks && (raw.chainId !== 46630 || !String(raw.release).includes("mock"))) {
    throw new Error("testOnlyMocks is restricted to explicitly named Robinhood testnet releases");
  }
  config.launchAt = positiveInteger(raw.launchAt, "launchAt");
  config.external = {} as V6ReleaseConfig["external"];
  config.roles = {} as V6ReleaseConfig["roles"];
  for (const required of ["poolManager", "stateView", "create2Factory", "wrappedEth", "ethUsdFeed", "entryPoint"] as const) {
    config.external[required] = address(raw.external?.[required], `external.${required}`);
  }
  for (const required of ["multisig", "guardian", "attester", "keeper", "paymasterSigner", "founder", "treasury", "teamVesting", "strategicVesting", "insurance"] as const) {
    config.roles[required] = address(raw.roles?.[required], `roles.${required}`);
  }
  const privileged = config.testOnlyMocks
    ? [config.roles.multisig, config.roles.guardian, config.roles.attester, config.roles.paymasterSigner]
    : [config.roles.multisig, config.roles.guardian, config.roles.attester, config.roles.keeper, config.roles.paymasterSigner];
  if (new Set(privileged.map((item) => item.toLowerCase())).size !== privileged.length) {
    throw new Error("multisig, guardian, attester, keeper, and paymasterSigner must be separate roles");
  }
  config.paymaster.perIdentityWei = positiveBigInt(raw.paymaster?.perIdentityWei, "paymaster.perIdentityWei");
  config.paymaster.perOperationWei = positiveBigInt(raw.paymaster?.perOperationWei, "paymaster.perOperationWei");
  config.paymaster.totalBudgetWei = positiveBigInt(raw.paymaster?.totalBudgetWei, "paymaster.totalBudgetWei");
  config.paymaster.depositWei = positiveBigInt(raw.paymaster?.depositWei, "paymaster.depositWei");
  config.paymaster.stakeWei = positiveBigInt(raw.paymaster?.stakeWei, "paymaster.stakeWei");
  config.paymaster.unstakeDelaySec = positiveInteger(raw.paymaster?.unstakeDelaySec, "paymaster.unstakeDelaySec");
  if (config.paymaster.unstakeDelaySec < 86400) throw new Error("paymaster.unstakeDelaySec must be at least one day");
  if (BigInt(config.paymaster.perOperationWei) > BigInt(config.paymaster.perIdentityWei)
      || BigInt(config.paymaster.perIdentityWei) > BigInt(config.paymaster.totalBudgetWei)) throw new Error("Invalid paymaster budget ordering");
  if (!Array.isArray(raw.paymaster?.accountCodeHashes) || raw.paymaster.accountCodeHashes.length === 0
      || raw.paymaster.accountCodeHashes.some((item: unknown) => typeof item !== "string" || !/^0x[0-9a-f]{64}$/i.test(item) || /^0x0{64}$/i.test(item))) {
    throw new Error("At least one non-zero audited accountCodeHash is required");
  }
  const seen = new Set<string>();
  config.stocks = {} as V6ReleaseConfig["stocks"];
  for (const ticker of V6_TICKERS) {
    const route = raw.stocks?.[ticker];
    const token = address(route?.token, `stocks.${ticker}.token`);
    const router = address(route?.router, `stocks.${ticker}.router`);
    const fee = positiveInteger(route?.fee, `stocks.${ticker}.fee`);
    if (fee > 1_000_000) throw new Error(`stocks.${ticker}.fee exceeds Uniswap fee units`);
    if (seen.has(token.toLowerCase())) throw new Error(`Duplicate Stock Token address for ${ticker}`);
    seen.add(token.toLowerCase());
    config.stocks[ticker] = { token, router, fee };
  }
  return { config, path };
}

export async function validateV6ExternalContracts(publicClient: PublicClient, config: V6ReleaseConfig) {
  if (await publicClient.getChainId() !== config.chainId) throw new Error(`RPC chain does not match configured chainId ${config.chainId}`);
  const contracts: Record<string, Address> = {
    ...config.external,
    multisig: config.roles.multisig,
    treasury: config.roles.treasury,
    teamVesting: config.roles.teamVesting,
    strategicVesting: config.roles.strategicVesting,
    insurance: config.roles.insurance,
  };
  for (const ticker of V6_TICKERS) {
    contracts[`stock.${ticker}`] = config.stocks[ticker].token;
    contracts[`stockRouter.${ticker}`] = config.stocks[ticker].router;
  }
  for (const [name, target] of Object.entries(contracts)) {
    const code = await publicClient.getCode({ address: target });
    if (!code || code === "0x") throw new Error(`${name} has no bytecode at ${target}`);
  }
  const feedAbi = [
    { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
    { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
  ] as const;
  const decimals = await publicClient.readContract({ address: config.external.ethUsdFeed, abi: feedAbi, functionName: "decimals" });
  const round = await publicClient.readContract({ address: config.external.ethUsdFeed, abi: feedAbi, functionName: "latestRoundData" });
  if (decimals > 18 || round[1] <= 0n || round[3] === 0n || round[4] < round[0]) throw new Error("ETH/USD feed returned an invalid round");
}
