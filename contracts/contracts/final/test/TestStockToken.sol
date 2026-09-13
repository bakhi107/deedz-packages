// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet-only stand-in for an equity token unavailable from the Robinhood faucet.
contract TestStockToken is ERC20, Ownable {
    constructor(string memory ticker, address owner_) ERC20(ticker, ticker) Ownable(owner_) {
        require(bytes(ticker).length != 0 && owner_ != address(0), "Invalid configuration");
    }

    function mint(address recipient, uint256 amount) external onlyOwner {
        require(recipient != address(0), "Invalid recipient");
        _mint(recipient, amount);
    }
}
