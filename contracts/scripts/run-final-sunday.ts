// @ts-nocheck
import { network } from "hardhat";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { createRewardJournal, rewardEligible, waitForKeeperReceipt } from "./testnet-keeper-state.mjs";
import { getAddress, isAddress } from "viem";

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const client = await viem.getPublicClient(); const [wallet] = await viem.getWalletClients();
if (await client.getChainId() !== 46630) throw Error("Robinhood testnet only");
const deed = await viem.getContractAt("contracts/final/Deed.sol:Deed", env("FINAL_DEED"));
const treasury = await viem.getContractAt("RentTreasury", env("FINAL_TREASURY"));
const settlement = await viem.getContractAt("SundaySettlement", env("FINAL_SETTLEMENT"));
const rewards = await viem.getContractAt("StockRewards", env("FINAL_REWARDS"));
const exchange = await viem.getContractAt("TestExchange", env("FINAL_EXCHANGE"));
if ((await treasury.read.keeper()).toLowerCase() !== wallet.account.address.toLowerCase()) throw new Error("Configured key is not the keeper");
if ((await settlement.read.keeper()).toLowerCase() !== wallet.account.address.toLowerCase()) throw Error("Settlement keeper mismatch");
const journal = createRewardJournal({ rewardsAddress: rewards.address });
await journal.recover(client, rewards);
const currentWeek = await treasury.read.weekOf([(await client.getBlock()).timestamp]);
for (let week = 0n; week < currentWeek; ++week) {
  if (await settlement.read.settled([week])) continue;
  if (!await treasury.read.weekFinalized([week])) {
    const count = await treasury.read.positionCount(); let cursor = await treasury.read.checkpointCursor([week]);
    while (cursor < count) { await mined(treasury.write.checkpointWeek([week, 250n])); cursor = await treasury.read.checkpointCursor([week]); }
    await mined(treasury.write.finalizeWeek([week]));
  }
  const total = await treasury.read.distributableRentEth([week]); if (total === 0n) continue;
  const [winner] = await settlement.read.winningClan([week]); const holders = [];
  const minted = await deed.read.totalMinted(); for (let id = 1n; id <= minted; ++id) { const data = await deed.read.deedData([id]); const ticker = data.ticker; if (!ticker) throw new Error(`Deed ${id}: ticker missing from deedData`); if (ticker.toLowerCase() === winner.toLowerCase() && rewardEligible(await deed.read.stateOf([id]))) holders.push({ id, owner: await deed.read.ownerOf([id]) }); }
  if (!holders.length) { console.log(`SKIP: week ${week} has no eligible winning holders; rent remains in treasury`); continue; }
  const jackpotEth = total * 20n / 100n; const rate = await exchange.read.stockPerEth([winner]); const stockTotal = jackpotEth * rate / 10n ** 18n; const batchId = await rewards.read.batchCount(); let used = 0n;
  const values = holders.map((holder, index) => { const amount = index === holders.length - 1 ? stockTotal - used : stockTotal / BigInt(holders.length); used += amount; return [batchId.toString(), holder.id.toString(), getAddress(holder.owner), amount.toString()]; });
  const tree = StandardMerkleTree.of(values, ["uint256","uint256","address","uint256"]); const claims = [...tree.entries()].map(([i,value]) => ({ batchId:value[0],tokenId:value[1],account:value[2],amount:value[3],proof:tree.getProof(i) }));
  const args=[week,total*50n/100n*await exchange.read.rentPerEth()/10n**18n,stockTotal,tree.root];
  await client.simulateContract({address:settlement.address,abi:settlement.abi,functionName:"settle",args,account:wallet.account});
  const hash=await journal.execute({client,rewards,batches:[{id:batchId.toString(),ticker:winner,root:tree.root,claims,kind:"Sunday",week:week.toString()}],submit:()=>settlement.write.settle(args)});
  console.log(`SUNDAY_OK week=${week} ${hash}`);
}
async function mined(promise: Promise<`0x${string}`>) { const hash = await promise; const receipt = await waitForKeeperReceipt(client, hash); if (receipt.status !== "success") throw new Error(`Transaction failed: ${hash}`); }
function env(name:string) { const value=process.env[name]; if(!value||!isAddress(value)) throw new Error(`${name} missing`); return getAddress(value); }
