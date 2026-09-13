// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IPriceFeed {
    function latestPriceUsd6() external view returns (uint256 price, uint256 updatedAt);
}
