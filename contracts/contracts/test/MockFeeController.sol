// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract MockFeeController {
    uint24 public configuredFeeBps = 5;

    function setFee(uint24 feeBps_) external {
        configuredFeeBps = feeBps_;
    }

    function feeBps(bytes32) external view returns (uint24) {
        return configuredFeeBps;
    }
}
