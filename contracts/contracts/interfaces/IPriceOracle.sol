// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Returns the value of one whole Stock Token in six-decimal USD units.
interface IPriceOracle {
    function latestPriceUsd6() external view returns (uint256 priceUsd6, uint256 updatedAt);
}

