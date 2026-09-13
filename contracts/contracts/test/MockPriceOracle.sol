// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPriceOracle} from "../interfaces/IPriceOracle.sol";

contract MockPriceOracle is IPriceOracle {
    uint256 public priceUsd6;
    uint256 public updatedAt;

    function setPrice(uint256 priceUsd6_, uint256 updatedAt_) external {
        priceUsd6 = priceUsd6_;
        updatedAt = updatedAt_;
    }

    function latestPriceUsd6() external view returns (uint256, uint256) {
        return (priceUsd6, updatedAt);
    }
}

