// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IMintableStockToken {
    function mint(address to, uint256 amount) external;
}

contract MockStockSwapAdapter {
    uint256 public immutable tokensPerEth;

    constructor(uint256 tokensPerEth_) {
        tokensPerEth = tokensPerEth_;
    }

    function swapExactEthForToken(address token, uint256 minAmountOut, uint256 deadline, bytes calldata)
        external
        payable
        returns (uint256 amountOut)
    {
        require(block.timestamp <= deadline, "expired");
        amountOut = msg.value * tokensPerEth / 1 ether;
        require(amountOut >= minAmountOut, "slippage");
        IMintableStockToken(token).mint(msg.sender, amountOut);
    }
}
