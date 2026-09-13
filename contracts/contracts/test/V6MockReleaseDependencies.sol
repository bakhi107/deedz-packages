// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Testnet-only ticker-shaped token. Never use on mainnet.
contract TestStockTokenV6 is ERC20 {
    constructor(string memory ticker) ERC20(string.concat("Test ", ticker), ticker) {}
    function mint(address recipient, uint256 amount) external { _mint(recipient, amount); }
}

/// @dev Testnet-only Chainlink-compatible ETH/USD feed. Never use on mainnet.
contract TestEthUsdFeedV6 {
    int256 public answer;
    uint80 public round = 1;

    constructor(int256 answer_) { require(answer_ > 0, "Invalid price"); answer = answer_; }
    function decimals() external pure returns (uint8) { return 8; }
    function setAnswer(int256 answer_) external { require(answer_ > 0, "Invalid price"); answer = answer_; ++round; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (round, answer, block.timestamp, block.timestamp, round);
    }
}

/// @dev Testnet-only single-owner contract wallet used to keep mock roles at distinct addresses.
contract TestRoleWalletV6 {
    address public immutable owner;
    constructor(address owner_) { require(owner_ != address(0), "Invalid owner"); owner = owner_; }
    function execute(address target, uint256 value, bytes calldata data) external payable returns (bytes memory result) {
        require(msg.sender == owner, "Only owner");
        (bool ok, bytes memory output) = target.call{value: value}(data);
        if (!ok) assembly ("memory-safe") { revert(add(output, 32), mload(output)) }
        return output;
    }
    receive() external payable {}
}
