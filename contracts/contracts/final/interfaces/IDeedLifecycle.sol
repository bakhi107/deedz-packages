// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IDeedLifecycle {
    function isRewardEligible(uint256 tokenId) external view returns (bool);
    function ownerOf(uint256 tokenId) external view returns (address);
    function tickerOf(uint256 tokenId) external view returns (bytes32);
}
