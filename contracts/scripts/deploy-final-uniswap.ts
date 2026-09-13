// @ts-nocheck
import { artifacts, network } from "hardhat";
import { concatHex, encodeAbiParameters, encodeDeployData, getAddress, getContractAddress, keccak256, maxUint256, numberToHex, parseEther, zeroAddress, zeroHash } from "viem";

const { viem } = await network.create({ network: "robinhoodTestnet", chainType: "generic" });
const client = await viem.getPublicClient(); const [wallet] = await viem.getWalletClients();
const RENT = env("FINAL_RENT"), PROCESSOR = env("FINAL_PROCESSOR"), MANAGER = env("V6_POOL_MANAGER"), STATE_VIEW = env("V6_STATE_VIEW"), FACTORY = env("V6_CREATE2_FACTORY"), LIQUIDITY_ROUTER = env("V6_LIQUIDITY_ROUTER");
if (await client.getChainId() !== 46630) throw new Error("Robinhood testnet only");
async function mined(hashPromise:Promise<`0x${string}`>) { const hash=await hashPromise; const receipt=await client.waitForTransactionReceipt({hash}); if(receipt.status!=="success") throw new Error(`Failed ${hash}`); return hash; }

const artifact = await artifacts.readArtifact("TradingHook"); const initCode = encodeDeployData({ abi:artifact.abi, bytecode:artifact.bytecode, args:[MANAGER,wallet.account.address] });
let nonce=0n, salt, hook; do { salt=numberToHex(nonce++,{size:32}); hook=getContractAddress({opcode:"CREATE2",from:FACTORY,salt,bytecode:initCode}); } while ((BigInt(hook)&((1n<<14n)-1n))!==0x80n);
const hookCode = await client.getCode({address:hook}); if (!hookCode || hookCode === "0x") await mined(wallet.sendTransaction({to:FACTORY,data:concatHex([salt,initCode])}));
const router = await viem.deployContract("TradingRouter",[MANAGER,RENT,hook,PROCESSOR]);
const key={currency0:zeroAddress,currency1:RENT,fee:0,tickSpacing:60,hooks:hook} as const;
const poolId=keccak256(encodeAbiParameters([{type:"tuple",components:[{name:"currency0",type:"address"},{name:"currency1",type:"address"},{name:"fee",type:"uint24"},{name:"tickSpacing",type:"int24"},{name:"hooks",type:"address"}]}],[key]));
const hookContract=await viem.getContractAt("TradingHook",hook); await mined(hookContract.write.configurePool([key,router.address]));
const manager=await viem.getContractAt("V4PoolManager",MANAGER); await mined(manager.write.initialize([key,1000n*(2n**96n)]));
const rent=await viem.getContractAt("RentToken",RENT); await mined(rent.write.approve([LIQUIDITY_ROUTER,maxUint256]));
const liquidity=await viem.getContractAt("V4LiquidityRouter",LIQUIDITY_ROUTER); await mined(liquidity.write.modifyLiquidity([key,{tickLower:-887220,tickUpper:887220,liquidityDelta:10n**15n,salt:zeroHash},"0x"],{value:parseEther("0.001")}));
const processor=await viem.getContractAt("FeeProcessor",PROCESSOR); await mined(processor.write.setFeeSource([router.address,true]));
const queuedBefore=await processor.read.queuedTradingFees(), block=await client.getBlock(), deadline=block.timestamp+3600n, rentBefore=await rent.read.balanceOf([wallet.account.address]);
const ethIn=10n**12n, tx1=await mined(router.write.swapExactInputEthForRent([0n,deadline],{value:ethIn})); const received=await rent.read.balanceOf([wallet.account.address])-rentBefore; if(received<=0n) throw new Error("ETH/RENT swap returned zero");
const rentBack=received/10n; await mined(rent.write.approve([router.address,rentBack])); const tx2=await mined(router.write.swapExactInputRentForEth([rentBack,0n,deadline]));
const totalFees=await router.read.totalFeesCollected(), queuedAfter=await processor.read.queuedTradingFees(); if(totalFees===0n||queuedAfter-queuedBefore!==totalFees) throw new Error("5% fees did not reach FeeProcessor");
const slot=await client.readContract({address:STATE_VIEW,abi:[{type:"function",name:"getSlot0",stateMutability:"view",inputs:[{type:"bytes32"}],outputs:[{type:"uint160"},{type:"int24"},{type:"uint24"},{type:"uint24"}]}],functionName:"getSlot0",args:[poolId]}); if(slot[0]===0n) throw new Error("Pool not initialized");
console.log(`FINAL_UNISWAP_VERIFIED\nFINAL_TRADING_HOOK=${hook}\nFINAL_TRADING_ROUTER=${router.address}\nFINAL_POOL_ID=${poolId}\nFINAL_UNISWAP_BLOCK=${await client.getBlockNumber()}\nSWAP_ETH_TO_RENT=${tx1}\nSWAP_RENT_TO_ETH=${tx2}\nFEES_QUEUED=${totalFees}`);
function env(name:string){const value=process.env[name];if(!value)throw new Error(`${name} missing`);return getAddress(value);}
