// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TickerRegistry
/// @notice Canonical configuration for Stock Tokens supported by DEEDS.
contract TickerRegistry is Ownable {
    error InvalidAddress();
    error InvalidDeedSupply();
    error TickerAlreadyListed(bytes32 ticker);
    error TickerNotListed(bytes32 ticker);

    struct TickerConfig {
        address stockToken;
        address priceFeed;
        uint16 deedSupply;
        bool active;
    }

    mapping(bytes32 ticker => TickerConfig config) private _tickers;

    event TickerListed(bytes32 indexed ticker, address indexed stockToken, address indexed priceFeed, uint16 deedSupply);
    event TickerStatusChanged(bytes32 indexed ticker, bool active);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function listTicker(bytes32 ticker, address stockToken, address priceFeed, uint16 deedSupply) external onlyOwner {
        if (stockToken == address(0) || priceFeed == address(0)) revert InvalidAddress();
        if (deedSupply == 0) revert InvalidDeedSupply();
        if (_tickers[ticker].stockToken != address(0)) revert TickerAlreadyListed(ticker);

        _tickers[ticker] = TickerConfig({stockToken: stockToken, priceFeed: priceFeed, deedSupply: deedSupply, active: true});
        emit TickerListed(ticker, stockToken, priceFeed, deedSupply);
    }

    function setTickerActive(bytes32 ticker, bool active) external onlyOwner {
        if (_tickers[ticker].stockToken == address(0)) revert TickerNotListed(ticker);
        _tickers[ticker].active = active;
        emit TickerStatusChanged(ticker, active);
    }

    function getTicker(bytes32 ticker) external view returns (TickerConfig memory) {
        TickerConfig memory config = _tickers[ticker];
        if (config.stockToken == address(0)) revert TickerNotListed(ticker);
        return config;
    }
}

