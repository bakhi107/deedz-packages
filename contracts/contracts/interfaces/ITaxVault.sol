// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ITaxVault {
    function openPosition(
        uint256 tokenId,
        address holder,
        address stockToken,
        address priceOracle,
        uint256 assessedPriceUsd6,
        uint256 depositAmount
    ) external;

    function deposit(uint256 tokenId, address payer, uint256 amount) external;
    function schedulePrice(uint256 tokenId, uint256 assessedPriceUsd6, uint64 effectiveBlock) external;
    function replaceHolder(uint256 tokenId, address newHolder, uint256 newPriceUsd6, uint256 depositAmount) external;
    function accrue(uint256 tokenId) external returns (uint256);
    function closeDepleted(uint256 tokenId) external;
    function balanceOf(uint256 tokenId) external view returns (uint256);
}
