// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IStockSwap {
    function buyStock(bytes32 ticker, address recipient, uint256 minimumOut) external payable returns (uint256 amountOut);
    function buyRent(address recipient, uint256 minimumOut) external payable returns (uint256 amountOut);
}
