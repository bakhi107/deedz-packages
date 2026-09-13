// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ITickerRegistry {
    struct TickerConfig {
        address stockToken;
        address priceFeed;
        uint16 deedSupply;
        bool active;
    }

    function getTicker(bytes32 ticker) external view returns (TickerConfig memory);
}

