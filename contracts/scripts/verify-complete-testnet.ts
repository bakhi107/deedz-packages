// @ts-nocheck
import { network } from "hardhat";
import { getAddress, stringToHex, zeroAddress } from "viem";

const A = {
  rent: "0x200d55d3b2eaf23f469674c13a30b57c031d6df9", oracle: "0x7fed399e622cb3b56d887013be408aa66a0eb9c3",
  ledger: "0x2923fcfe9e4c9cb555fec4cec009f8e3a9dc5156", rewards: "0x0f32ec321908684666294f7b1b4f54a029981355",
  liquidity: "0xce2e54d96e02e6b638b784f2d9a25958a451bc2f", buyer: "0x38cd7b6f440116ca6cdfd6eb2ce2433ff1c75e0e",
  burn: "0x5ee06d10e3698ede6a4536edfebb4403397fbf21", thronePool: "0x9f84bae099b1ae7ea961dbbc920d811ad9014064",
  vault: "0x160f6159ffff8586012d511f09c3252ea16dbd2d", jackpot: "0xfb640534eafd14fb57d7753e482309dae9152fe6",
  deed: "0x50954b51e4ecbca65ad3d1943f56afd191319c8c", hook: "0x1886d845471Baf22747B8fa691C6073414c5C080",
  router: "0x5ccf29c30fc9d19c485674c5bb8880526c190d6b", auction: "0xfc2a40f9f7a761ab96e9eae39913a1640bdc10c6",
  discount: "0xd852ebaa429e77e9c777a3a2f48a2a3a407ec000",
} as const;
const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const client = await viem.getPublicClient();
for (const [name, raw] of Object.entries(A)) {
  const code = await client.getCode({ address: getAddress(raw) }); if (!code || code === "0x") throw new Error(`${name}: no bytecode`);
}
const vault = await viem.getContractAt("RentVaultV6", A.vault);
const ledger = await viem.getContractAt("RentLedgerV6", A.ledger);
const rewards = await viem.getContractAt("StockRewardsV6", A.rewards);
const deed = await viem.getContractAt("DeedV6", A.deed);
const buyer = await viem.getContractAt("StockBuyerV6", A.buyer);
const liquidity = await viem.getContractAt("LiquidityV6", A.liquidity);
const router = await viem.getContractAt("RentFeeRouterV6", A.router);
const thronePool = await viem.getContractAt("ThronePoolV6", A.thronePool);
const same = (actual: string, expected: string, label: string) => { if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`${label} mismatch`); };
same(await vault.read.deed(), A.deed, "vault/deed"); same(await vault.read.ledger(), A.ledger, "vault/ledger");
same(await ledger.read.vault(), A.vault, "ledger/vault"); same(await rewards.read.deed(), A.deed, "rewards/deed");
same(await rewards.read.stockBuyer(), A.buyer, "rewards/buyer"); same(await buyer.read.feeSource(), A.router, "buyer/router");
same(await liquidity.read.router(), A.router, "liquidity/router"); same(await deed.read.thronePool(), A.thronePool, "deed/thronePool");
same(await deed.read.throneAuction(), A.auction, "deed/auction"); same(await thronePool.read.deed(), A.deed, "thronePool/deed");
if (await liquidity.read.totalLiquidity() === 0n) throw new Error("pool liquidity missing");
for (const ticker of ["NVDA","TSLA","AAPL","AMZN","META","MSFT","GOOGL","NFLX","COIN","AMD"]) {
  const key = stringToHex(ticker, { size: 32 });
  if (await rewards.read.stockToken([key]) === zeroAddress || await buyer.read.swapAdapter([key]) === zeroAddress) throw new Error(`${ticker} route missing`);
}
if (await router.read.FEE_BPS() !== 500n) throw new Error("router fee is not 5%");
console.log("COMPLETE_DEEDZ_TESTNET_VERIFIED");
