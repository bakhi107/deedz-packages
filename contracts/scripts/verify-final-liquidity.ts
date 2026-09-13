// @ts-nocheck
import { network } from "hardhat";
import { getAddress, isAddress, parseEther } from "viem";
const {viem}=await network.create({network:"robinhoodTestnet",chainType:"generic"}); const client=await viem.getPublicClient(); const [wallet]=await viem.getWalletClients();
const manager=await viem.getContractAt("ProtocolLiquidityManager",env("FINAL_LIQUIDITY_MANAGER")); const rent=await viem.getContractAt("RentToken",env("FINAL_RENT")); const processor=await viem.getContractAt("FeeProcessor",env("FINAL_PROCESSOR")); const settlement=await viem.getContractAt("SundaySettlement",env("FINAL_SETTLEMENT"));
if((await processor.read.liquidity()).toLowerCase()!==manager.address.toLowerCase()||(await settlement.read.liquidity()).toLowerCase()!==manager.address.toLowerCase())throw new Error("Liquidity destinations do not match");
const before=await manager.read.totalLiquidity(); const fund=await wallet.sendTransaction({to:manager.address,value:parseEther("0.000001")}); await client.waitForTransactionReceipt({hash:fund});
const eth=await client.getBalance({address:manager.address}), tokens=await rent.read.balanceOf([manager.address]), block=await client.getBlock(); const hash=await manager.write.reinvest([eth/2n,1n,eth,tokens,1n,block.timestamp+900n]); const receipt=await client.waitForTransactionReceipt({hash}); if(receipt.status!=="success"||await manager.read.totalLiquidity()<=before)throw new Error("Liquidity reinvestment failed");
console.log(`FINAL_LIQUIDITY_VERIFIED\nTRANSACTION=${hash}\nTOTAL_LIQUIDITY=${await manager.read.totalLiquidity()}`);
function env(name:string){const value=process.env[name];if(!value||!isAddress(value))throw new Error(`${name} missing`);return getAddress(value);}
