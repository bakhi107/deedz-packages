// @ts-nocheck -- Hardhat 3's generated viem augmentations are loaded at runtime by the plugin.
import { network } from "hardhat";
import { createPublicClient, http, keccak256 } from "viem";

const TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com";
const MAINNET_RPC = "https://rpc.mainnet.chain.robinhood.com";

const uniswap = {
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
} as const;

const localAssets = {
  usdg: "0x9b1ed94f8b943a2b142793a90527bc419c5548cc",
  nvda: "0x2987c3e0eafaa52684c943c3233e165dac4e94f8",
  oracle: "0x0bf65702ab1eaea217b90f5e7fb7d8c484f5c96b",
} as const;
const canonicalTestnetWeth = "0x7943e237c7F95DA44E0301572D358911207852Fa" as const;

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const testnet = await viem.getPublicClient();
const mainnet = createPublicClient({ transport: http(MAINNET_RPC) });

if ((await testnet.getChainId()) !== 46630) throw new Error("Expected Robinhood testnet chain ID 46630");

console.log("Robinhood testnet external-dependency audit");
for (const [name, address] of Object.entries(uniswap)) {
  const [testCode, mainCode] = await Promise.all([
    testnet.getCode({ address }),
    mainnet.getCode({ address }),
  ]);
  if (!testCode || testCode === "0x") throw new Error(`${name} has no testnet code at ${address}`);
  if (!mainCode || mainCode === "0x") throw new Error(`${name} has no mainnet code at ${address}`);
  const testHash = keccak256(testCode);
  const mainHash = keccak256(mainCode);
  console.log(`${name}: ${address} | testnet bytes ${(testCode.length - 2) / 2} | runtime ${testHash === mainHash ? "matches mainnet" : "differs from mainnet"}`);
}

const addressGetterAbi = (name: string) => [{
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "address" }],
}] as const;
const positionManager = uniswap.positionManager;
const [positionPoolManager, positionPermit2, positionWeth] = await Promise.all([
  testnet.readContract({ address: positionManager, abi: addressGetterAbi("poolManager"), functionName: "poolManager" }),
  testnet.readContract({ address: positionManager, abi: addressGetterAbi("permit2"), functionName: "permit2" }),
  testnet.readContract({ address: positionManager, abi: addressGetterAbi("WETH9"), functionName: "WETH9" }),
]);
if (positionPoolManager.toLowerCase() !== uniswap.poolManager.toLowerCase()) throw new Error("PositionManager PoolManager mismatch");
if (positionPermit2.toLowerCase() !== uniswap.permit2.toLowerCase()) throw new Error("PositionManager Permit2 mismatch");
console.log(`positionManager.poolManager: ${positionPoolManager}`);
console.log(`positionManager.permit2: ${positionPermit2}`);
console.log(`positionManager.WETH9: ${positionWeth} | ${positionWeth.toLowerCase() === canonicalTestnetWeth.toLowerCase() ? "canonical testnet WETH" : "NOT canonical testnet WETH"}`);

const erc20Abi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

for (const [name, address] of Object.entries(localAssets)) {
  const code = await testnet.getCode({ address });
  if (!code || code === "0x") throw new Error(`${name} has no testnet code at ${address}`);
  if (name === "oracle") {
    console.log(`${name}: ${address} | deployed test-only price oracle`);
    continue;
  }
  const [tokenName, symbol, decimals] = await Promise.all([
    testnet.readContract({ address, abi: erc20Abi, functionName: "name" }),
    testnet.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    testnet.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
  ]);
  console.log(`${name}: ${address} | ${tokenName} (${symbol}) | ${decimals} decimals | DEEDS test-only asset`);
}

console.log(`RPC checked: ${TESTNET_RPC}`);
console.log("Result: Uniswap contracts are live; USDG, NVDA, and oracle are controlled DEEDS test substitutes, not canonical Robinhood assets.");
