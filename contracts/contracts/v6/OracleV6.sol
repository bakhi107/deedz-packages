// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
interface IAggregatorV6 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}
/// @notice Read-only production feed normalization. No administrator can publish a price.
contract EthUsdOracleV6 {
    IAggregatorV6 public immutable feed;
    uint8 public immutable decimals;
    constructor(address feed_) {
        require(feed_.code.length != 0, "Feed contract required"); feed = IAggregatorV6(feed_);
        decimals = feed.decimals(); require(decimals <= 18, "Unsupported precision");
    }
    function latestPriceUsd6() external view returns (uint256 price, uint256 updatedAt) {
        (uint80 round, int256 answer,, uint256 timestamp, uint80 answeredInRound) = feed.latestRoundData();
        require(answer > 0 && timestamp != 0 && timestamp <= block.timestamp && answeredInRound >= round, "Invalid oracle round");
        price = decimals >= 6 ? uint256(answer) / 10 ** (decimals - 6) : uint256(answer) * 10 ** (6 - decimals);
        require(price != 0, "Oracle rounds to zero"); updatedAt = timestamp;
    }
}
