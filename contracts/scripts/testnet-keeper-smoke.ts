// @ts-nocheck -- This exercises the existing, legacy testnet deployment only.
import { network } from 'hardhat';
import { getAddress, isAddress, stringToHex, parseEther } from 'viem';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { persistKeeperData } from './testnet-keeper-state.mjs';

if (process.env.DEEDZ_TESTNET_SMOKE !== '1') throw Error('Explicit testnet smoke flag required');
const {viem}=await network.create({network:'robinhoodTestnet',chainType:'generic'});
const client=await viem.getPublicClient(), [wallet]=await viem.getWalletClients();
if(await client.getChainId()!==46630)throw Error('Robinhood testnet only');
const account=wallet.account.address;
const deed=await viem.getContractAt('contracts/final/Deed.sol:Deed',env('FINAL_DEED'));
const rewards=await viem.getContractAt('StockRewards',env('FINAL_REWARDS'));
const processor=await viem.getContractAt('FeeProcessor',env('FINAL_PROCESSOR'));
const treasury=await viem.getContractAt('RentTreasury',env('FINAL_TREASURY'));
const rent=await viem.getContractAt('RentToken',env('FINAL_RENT'));
if(getAddress(await processor.read.keeper())!==getAddress(account))throw Error('Secret wallet is not the keeper');
const ticker=stringToHex('NVDA',{size:32});
const stock=await viem.getContractAt('TestStockToken',await rewards.read.stockToken([ticker]));
const file='keeper-data/smoke.json';mkdirSync('keeper-data',{recursive:true});
let state=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{chainId:46630,rewards:rewards.address.toLowerCase(),account:getAddress(account),phase:'prepare',firstBatch:String(await rewards.read.batchCount()),transactions:[]};
if(state.chainId!==46630||state.rewards!==rewards.address.toLowerCase()||state.account!==getAddress(account))throw Error('Smoke state belongs to another deployment');
function save(){writeFileSync(file+'.tmp',JSON.stringify(state,null,2)+'\n');renameSync(file+'.tmp',file);persistKeeperData();}
async function mined(label,send){const hash=await send();const receipt=await client.waitForTransactionReceipt({hash});if(receipt.status!=='success')throw Error(label+' reverted');state.transactions.push({label,hash});save();console.log(label+' '+hash);}

if((process.env.DEEDZ_SMOKE_PHASE??'prepare')==='prepare'){
  if(state.phase!=='prepare'){console.log('SMOKE_ALREADY_SEEDED: verifying existing test on this run');process.exit(0);}
  if(existsSync('keeper-data/pending.json'))throw Error('Reconcile pending keeper transaction before seeding');
  if(await client.getBalance({address:account})<parseEther('0.001'))throw Error('Keeper needs at least 0.001 test ETH');
  let id=state.tokenId?BigInt(state.tokenId):0n;
  if(!id){for(let n=1n;n<=await deed.read.totalMinted();n++){if(getAddress(await deed.read.ownerOf([n]))===getAddress(account)&&(await deed.read.deedData([n])).ticker===ticker){id=n;break;}}}
  if(!id){await mined('SMOKE_MINT',()=>deed.write.mint([ticker]));id=await deed.read.totalMinted();if(getAddress(await deed.read.ownerOf([id]))!==getAddress(account))throw Error('Concurrent mint; rerun to find own token');}
  state.tokenId=String(id);save();
  if([0,3].includes(Number(await deed.read.stateOf([id])))){
    const burn=await deed.read.LIGHT_COST();
    if(await rent.read.balanceOf([account])<burn){const faucet=await viem.getContractAt('TestRentFaucet',env('FINAL_FAUCET'));await mined('SMOKE_FAUCET',()=>faucet.write.claim());}
    if(await rent.read.allowance([account,deed.address])<burn)await mined('SMOKE_APPROVE',()=>rent.write.approve([deed.address,burn]));
    const deposit=await treasury.read.dailyRentWei([5_000_000n])*7n;
    if(deposit>parseEther('0.0001'))throw Error('Unexpected test rent cost');
    await mined('SMOKE_LIGHT',()=>deed.write.light([id,5_000_000n],{value:deposit}));
  }
  const pool=await viem.getContractAt('TestTradingPool',env('FINAL_TRADING_POOL'));
  if(getAddress(await pool.read.feeProcessor())!==getAddress(processor.address)||!await processor.read.feeSource([pool.address]))throw Error('Test pool fee wiring mismatch');
  state.stockBefore=String(await stock.read.balanceOf([account]));save();
  // Skip reseeding after an interrupted preparation if there are already queued fees.
  if(await processor.read.queuedTradingFees()===0n){const input=parseEther('0.00002'),minimum=input*95n/100n*await pool.read.rentPerEth()/10n**18n;await mined('SMOKE_TRADE',()=>pool.write.swapEthForRent([minimum],{value:input}));}
  state.phase='seeded';save();console.log('SMOKE_SEEDED: NFT '+id+'; fees '+await processor.read.queuedTradingFees());
}else if(process.env.DEEDZ_SMOKE_PHASE==='verify'){
  const history=JSON.parse(readFileSync('keeper-data/rewards.json','utf8'));
  if(history.chainId!==46630||history.rewards!==rewards.address.toLowerCase())throw Error('Wrong proof history');
  const claims=history.batches.filter(b=>BigInt(b.id)>=BigInt(state.firstBatch)).flatMap(b=>b.claims).filter(c=>getAddress(c.account)===getAddress(account)&&c.tokenId===state.tokenId);
  if(!claims.length)throw Error('No smoke reward batch yet; cycle may still be inside its 3-hour interval');
  for(const claim of claims){const id=BigInt(claim.batchId),tokenId=BigInt(claim.tokenId);if(!await rewards.read.tokenClaimed([id,tokenId]))await mined('SMOKE_CLAIM',()=>rewards.write.claim([id,tokenId,BigInt(claim.amount),claim.proof]));}
  const received=await stock.read.balanceOf([account])-BigInt(state.stockBefore);
  if(received<=0n)throw Error('Stock balance did not increase');
  state.phase='verified';state.stockReceived=String(received);state.verifiedAt=new Date().toISOString();save();
  console.log('SMOKE_VERIFIED: test stock purchased and claimed; '+received+' base units; repeat claims skipped');
}else throw Error('Unknown smoke phase');
function env(name){const value=process.env[name];if(!value||!isAddress(value))throw Error(name+' missing');return getAddress(value);}
