// @ts-nocheck
import assert from "node:assert/strict";
import { beforeEach,describe,it } from "node:test";
import { network } from "hardhat";
import { stringToHex,parseEther,keccak256,encodeAbiParameters } from "viem";
import { shareTree,minimumOutput,completedManifests,eligibleGroups } from "../scripts/stock/keeper.js";

describe("Stock execution and actual-output shares",async()=>{
 const {viem,networkHelpers:nh}=await network.create({network:"stockUnit"});
 const [owner,holder,other,team]=await viem.getWalletClients();const ticker=stringToHex("NVDA",{size:32});
 let rent,stock,rewards,exchange,lp,fees;
 beforeEach(async()=>{
  rent=await viem.deployContract("RentToken",[owner.account.address]);stock=await viem.deployContract("TestStockToken",["NVDA",owner.account.address]);
  rewards=await viem.deployContract("StockRewards",[owner.account.address,owner.account.address]);
  exchange=await viem.deployContract("TestExchange",[owner.account.address,rent.address]);lp=await viem.deployContract("ProtocolLiquidity",[owner.account.address]);
  fees=await viem.deployContract("FeeProcessor",[owner.account.address,owner.account.address,rewards.address,exchange.address,lp.address,team.account.address]);
  await rewards.write.configureStock([ticker,stock.address]);await rewards.write.setProcessor([fees.address,true]);await fees.write.setFeeSource([owner.account.address,true]);
  await exchange.write.configureStock([ticker,stock.address,parseEther("1234")]);await stock.write.mint([exchange.address,parseEther("1000000")]);
  await fees.write.depositTradingFees([],{value:parseEther("0.01")});await nh.time.increase(10800);
 });
 const tree=()=>shareTree(0n,ticker,[{id:1n,owner:holder.account.address},{id:2n,owner:holder.account.address},{id:3n,owner:other.account.address}]);
 const args=async(root,size=3)=>[[{ticker,ethAmount:parseEther("0.007"),minimumStockOut:1n,merkleRoot:root,holderCount:BigInt(size)}],parseEther("0.01"),0n,BigInt(await nh.time.latest())+120n];
 it("uses actual received output after a price change and partitions every unit",async()=>{
  const m=tree(),plan={manifests:[m],snapshotBlock:"1"};await exchange.write.configureStock([ticker,stock.address,parseEther("1357")+1n]);
  const hash=await fees.write.processStockCycle(await args(m.root));const [manifest]=await completedManifests(rewards,plan,hash);
  let claimed=0n;for(const c of manifest.claims){const who=c.account.toLowerCase()===holder.account.address.toLowerCase()?holder:other;await rewards.write.claim([0n,BigInt(c.tokenId),BigInt(c.shareIndex),c.proof],{account:who.account});claimed+=BigInt(c.amount);}
  assert.equal(claimed,(await rewards.read.batches([0n]))[3]);assert.equal(await stock.read.balanceOf([rewards.address]),0n);
 });
 it("rejects stale queues, stale batches, expired plans, duplicates and unauthorized keeper",async()=>{
  const m=tree(),a=await args(m.root);await assert.rejects(fees.write.processStockCycle(a,{account:other.account}));
  for(const bad of [[a[0],1n,a[2],a[3]],[a[0],a[1],1n,a[3]],[a[0],a[1],a[2],1n],[[...a[0],...a[0]],a[1],a[2],a[3]]])await assert.rejects(fees.write.processStockCycle(bad));
  assert.equal(await fees.read.queuedTradingFees(),parseEther("0.01"));assert.equal(await rewards.read.batchCount(),0n);
 });
 it("keeps newly arrived trading fees queued while executing the prepared cycle",async()=>{
  const a=await args(tree().root);await fees.write.depositTradingFees([],{value:123456n});
  await fees.write.processStockCycle(a);assert.equal(await fees.read.queuedTradingFees(),123456n);
 });
 it("preserves all fees and accounting after insufficient stock output",async()=>{
  const m=tree(),a=await args(m.root);a[0][0].minimumStockOut=parseEther("9999999");await assert.rejects(fees.write.processStockCycle(a));
  assert.equal(await fees.read.queuedTradingFees(),parseEther("0.01"));assert.equal(await fees.read.teamBalance(),0n);assert.equal(await lp.read.totalEthReceived(),0n);
 });
 it("rejects altered claim indices, wrong wallets, duplicates and unauthorized funding",async()=>{
  const m=tree();await fees.write.processStockCycle(await args(m.root));const c=m.claims.find(c=>c.account.toLowerCase()===holder.account.address.toLowerCase());
  const a=[0n,BigInt(c.tokenId),BigInt(c.shareIndex),c.proof];await assert.rejects(rewards.write.claim(a,{account:other.account}));
  await assert.rejects(rewards.write.claim([0n,BigInt(c.tokenId),249n,c.proof],{account:holder.account}));
  await rewards.write.claim(a,{account:holder.account});await assert.rejects(rewards.write.claim(a,{account:holder.account}));
  await assert.rejects(rewards.write.createShareBatch([ticker,m.root,1n,1n],{account:other.account}));
 });
 it("preserves legacy amount-based reward claims",async()=>{
  const amount=12345n;await stock.write.mint([owner.account.address,amount]);await stock.write.approve([rewards.address,amount]);
  const root=keccak256(keccak256(encodeAbiParameters([{type:"uint256"},{type:"uint256"},{type:"address"},{type:"uint256"}],[0n,1n,holder.account.address,amount])));
  await rewards.write.createBatch([ticker,root,amount]);await rewards.write.claim([0n,1n,amount,[]],{account:holder.account});assert.equal(await stock.read.balanceOf([holder.account.address]),amount);
 });
 it("rotates away from the deployer keeper",async()=>{
  assert.equal((await fees.read.keeper()).toLowerCase(),owner.account.address.toLowerCase());await fees.write.setKeeper([other.account.address]);
  const a=await args(tree().root);await assert.rejects(fees.write.processStockCycle(a));await fees.write.processStockCycle(a,{account:other.account});
 });
 it("bounds slippage and rejects repeated token IDs in membership snapshots",()=>{
  assert.equal(minimumOutput(10000n,50),9950n);assert.throws(()=>minimumOutput(10000n,10000));assert.throws(()=>minimumOutput(0n,50));
  assert.throws(()=>shareTree(0n,ticker,[{id:1n,owner:holder.account.address},{id:1n,owner:other.account.address}]));
 });
});
