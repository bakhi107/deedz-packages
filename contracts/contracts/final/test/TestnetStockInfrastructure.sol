// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Valueless testnet dependencies. Never use these addresses on mainnet.
contract TestnetWrappedEther is ERC20 {
    constructor() ERC20("DEEDZ Test Wrapped Ether", "tWETH") {
        require(block.chainid == 46630 || block.chainid == 31337, "Test networks only");
    }
    function deposit() external payable { _mint(msg.sender, msg.value); }
    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "ETH transfer failed");
    }
}

/// @dev Synthetic $2,500 price with a current timestamp, for public testnet UX only.
/// Production uses the independently verified Chainlink proxy, never this feed.
contract TestnetChainlinkFeed {
    uint8 public constant decimals = 8;
    constructor() { require(block.chainid == 46630 || block.chainid == 31337, "Test networks only"); }
    function description() external pure returns (string memory) { return "TEST ONLY ETH / USD"; }
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, 2500e8, block.timestamp, block.timestamp, 1);
    }
}

interface ISeedV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function mint(address, int24, int24, uint128, bytes calldata) external returns (uint256, uint256);
}

/// @dev Owner-funded liquidity for the testnet's real V3 pool bytecode.
contract TestnetV3Seeder is Ownable {
    using SafeERC20 for IERC20;
    address private activePool;
    address private payer;
    constructor(address owner_) Ownable(owner_) {
        require(block.chainid == 46630 || block.chainid == 31337, "Test networks only");
    }
    function seed(address pool, uint128 amount) external onlyOwner {
        require(activePool == address(0), "Seed active");
        activePool = pool; payer = msg.sender;
        ISeedV3Pool(pool).mint(address(this), -887220, 887220, amount, "");
        activePool = address(0); payer = address(0);
    }
    function uniswapV3MintCallback(uint256 amount0, uint256 amount1, bytes calldata) external {
        require(msg.sender == activePool && activePool != address(0), "Unauthorized callback");
        if (amount0 != 0) IERC20(ISeedV3Pool(activePool).token0()).safeTransferFrom(payer, msg.sender, amount0);
        if (amount1 != 0) IERC20(ISeedV3Pool(activePool).token1()).safeTransferFrom(payer, msg.sender, amount1);
    }
}
