// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {RentFeeRouterV6} from "./RentFeeRouterV6.sol";
import {RentVaultV6} from "./RentVaultV6.sol";
import {DeedV6} from "./DeedV6.sol";
import {LiquidityV6} from "./LiquidityV6.sol";

contract FairLaunchV6 is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    RentFeeRouterV6 public router;
    RentVaultV6 public vault;
    LiquidityV6 public liquidity;
    address public launcher;
    bool public seeded;
    event LauncherChanged(address indexed previousLauncher, address indexed newLauncher);
    constructor(address governor) Ownable(governor) { launcher = governor; }
    function configure(address router_, address vault_, address liquidity_) external onlyOwner {
        require(address(router) == address(0) && router_.code.length != 0 && vault_.code.length != 0 && liquidity_.code.length != 0, "Invalid configuration");
        router = RentFeeRouterV6(payable(router_)); vault = RentVaultV6(payable(vault_)); liquidity = LiquidityV6(payable(liquidity_));
    }
    function setLauncher(address value) external onlyOwner {
        require(!seeded && value != address(0), "Invalid launcher");
        emit LauncherChanged(launcher, value); launcher = value;
    }
    function seed() external nonReentrant {
        require(msg.sender == launcher, "Only launcher");
        require(!seeded && address(this).balance >= vault.usdToEth(3000e6), "Seed unavailable");
        seeded = true;
        IERC20(address(router.rent())).safeTransfer(address(liquidity), 50_000_000 ether);
        (bool ok,) = address(liquidity).call{value: address(this).balance}(""); require(ok, "Seed failed");
    }
    function open() external {
        require(seeded && liquidity.totalLiquidity() != 0, "Liquidity required");
        router.enableLaunch();
    }
    receive() external payable {}
}

/// @notice Five percent of gross protocol revenue is paid from existing team receipts only.
/// Any shortfall remains explicit founder debt; holder, LP and jackpot funds are unreachable.
contract FounderShareV6 is Ownable, ReentrancyGuard {
    RentFeeRouterV6 public router;
    RentVaultV6 public vault;
    DeedV6 public deed;
    address payable public immutable founder;
    address payable public immutable treasury;
    uint256 public founderPaid;
    uint256 public treasuryPaid;
    mapping(address => uint256) public credits;
    event RevenueAllocated(uint256 founderAmount, uint256 treasuryAmount, uint256 founderDebt);
    constructor(address governor, address payable founder_, address payable treasury_) Ownable(governor) {
        require(founder_ != address(0) && treasury_ != address(0), "Invalid recipients"); founder = founder_; treasury = treasury_;
    }
    function configure(address router_, address vault_, address deed_) external onlyOwner {
        require(address(router) == address(0) && router_.code.length != 0 && vault_.code.length != 0 && deed_.code.length != 0, "Invalid configuration");
        router = RentFeeRouterV6(payable(router_)); vault = RentVaultV6(payable(vault_)); deed = DeedV6(deed_);
    }
    function entitlement() public view returns (uint256) {
        return (router.totalFeesCollected() + vault.totalRentCollected() + deed.totalSaleFeesCollected()) * 5 / 100;
    }
    function pullAndAllocate() external nonReentrant {
        uint256 received = router.claimBucket() + vault.claimBucket();
        uint256 debt = entitlement() - founderPaid;
        uint256 share = received < debt ? received : debt;
        founderPaid += share; treasuryPaid += received - share;
        credits[founder] += share; credits[treasury] += received - share;
        emit RevenueAllocated(share, received - share, debt - share);
    }
    function claim(address payable recipient) external nonReentrant {
        require(recipient != address(0), "Invalid recipient");
        uint256 amount = credits[msg.sender]; credits[msg.sender] = 0;
        (bool ok,) = recipient.call{value: amount}(""); require(ok, "Claim failed");
    }
    receive() external payable { require(msg.sender == address(router) || msg.sender == address(vault), "Only revenue sources"); }
}

contract DeedsTimelockV6 is TimelockController {
    constructor(address multisig) TimelockController(2 days, _single(multisig), _single(multisig), address(0)) {
        require(multisig.code.length != 0, "Multisig contract required");
    }
    function _single(address value) private pure returns (address[] memory values) {
        values = new address[](1); values[0] = value;
    }
}
