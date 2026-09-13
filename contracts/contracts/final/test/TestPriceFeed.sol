// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPriceFeed} from "../interfaces/IPriceFeed.sol";

contract TestPriceFeed is Ownable, IPriceFeed {
    uint256 public priceUsd6;
    uint256 public updatedAt;
    constructor(address owner_, uint256 initialPriceUsd6) Ownable(owner_) { setPrice(initialPriceUsd6); }
    function setPrice(uint256 value) public onlyOwner { require(value != 0, "Invalid price"); priceUsd6 = value; updatedAt = block.timestamp; }
    // Testnet deliberately reports the configured price as current so no team transaction is needed to refresh it.
    function latestPriceUsd6() external view returns (uint256, uint256) { return (priceUsd6, block.timestamp); }
}
