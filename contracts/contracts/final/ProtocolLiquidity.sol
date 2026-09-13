// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract ProtocolLiquidity is Ownable {
    uint256 public totalEthReceived;
    event LiquidityReceived(uint256 amount);
    constructor(address owner_) Ownable(owner_) {}
    receive() external payable { totalEthReceived += msg.value; emit LiquidityReceived(msg.value); }
}
