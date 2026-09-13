// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.26;
import {BasePaymaster} from "@account-abstraction/contracts/core/BasePaymaster.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice ERC-4337 v0.7 launch sponsorship. Only audited account runtimes and signed,
/// identity-bound vouchers for one DEEDS call are accepted. No arbitrary sponsored calls.
contract PaymasterV6 is BasePaymaster, EIP712 {
    address public immutable deed;
    uint48 public immutable launchAt;
    uint48 public immutable endsAt;
    address public signer;
    bool public enabled;
    uint256 public immutable identityBudget;
    uint256 public immutable operationCap;
    uint256 public immutable totalBudget;
    uint256 public reserved;
    mapping(bytes32 => bool) public accountCodeHash;
    mapping(bytes32 => uint256) public identityReserved;
    mapping(bytes32 => uint8) public mintAttempts;
    mapping(bytes32 => uint8) public lightAttempts;
    mapping(bytes32 => bool) public used;
    bytes32 public constant TYPEHASH = keccak256("Sponsorship(bytes32 operation,bytes32 identity,uint48 validUntil,uint256 maxCost)");
    event Sponsored(bytes32 indexed operation, bytes32 indexed identity, uint256 reservedCost);
    event SponsorshipSettled(bytes32 indexed operation, bool success, uint256 gasCost);
    constructor(IEntryPoint entryPoint_, address deed_, address signer_, uint48 launch,
        uint256 perIdentity, uint256 perOperation, uint256 budget)
        BasePaymaster(entryPoint_) EIP712("DEEDS launch sponsorship", "6") {
        require(deed_.code.length != 0 && signer_ != address(0) && perOperation > 0 && perIdentity >= perOperation && budget >= perIdentity, "Invalid policy");
        deed = deed_; signer = signer_; launchAt = launch; endsAt = launch + 7 days;
        identityBudget = perIdentity; operationCap = perOperation; totalBudget = budget;
    }
    function configure(bool enabled_, address signer_) external onlyOwner {
        require(signer_ != address(0), "Invalid signer"); enabled = enabled_; signer = signer_;
    }
    function allowAccountCode(bytes32 codeHash, bool allowed) external onlyOwner {
        require(codeHash != bytes32(0) && codeHash != keccak256(""), "Invalid code"); accountCodeHash[codeHash] = allowed;
    }
    function sponsorshipHash(PackedUserOperation calldata op, bytes32 identity, uint48 validUntil, uint256 maxCost)
        public view returns (bytes32) {
        bytes32 operation = keccak256(abi.encode(op.sender, op.nonce, keccak256(op.initCode), keccak256(op.callData),
            op.accountGasLimits, op.preVerificationGas, op.gasFees, keccak256(op.paymasterAndData[:52]), address(entryPoint)));
        return _hashTypedDataV4(keccak256(abi.encode(TYPEHASH, operation, identity, validUntil, maxCost)));
    }
    function _validatePaymasterUserOp(PackedUserOperation calldata op, bytes32, uint256 maxCost)
        internal override returns (bytes memory context, uint256 validationData) {
        require(enabled && accountCodeHash[op.sender.codehash] && op.initCode.length == 0, "Unsupported account");
        require(op.paymasterAndData.length >= 52 && op.callData.length >= 4, "Malformed operation");
        require(bytes4(op.callData[:4]) == bytes4(keccak256("execute(address,uint256,bytes)")), "Single execute required");
        (address target, uint256 value, bytes memory callData) = abi.decode(op.callData[4:], (address, uint256, bytes));
        require(target == deed && callData.length >= 4, "Only DEEDS");
        bytes4 selector = bytes4(callData);
        bool mint = selector == bytes4(keccak256("mintDark(bytes32)"));
        require((mint && value == 0 && callData.length == 36) ||
            (selector == bytes4(keccak256("lightUp(uint256,uint256)")) && callData.length == 68), "Unsupported action");
        (bytes32 identity, uint48 validUntil, uint256 limit, bytes memory signature) = abi.decode(op.paymasterAndData[52:], (bytes32, uint48, uint256, bytes));
        uint48 starts = mint ? launchAt : launchAt + 2 days;
        require(identity != bytes32(0) && validUntil > starts && validUntil <= endsAt && maxCost <= limit && maxCost <= operationCap, "Invalid voucher");
        bytes32 digest = sponsorshipHash(op, identity, validUntil, limit);
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
        if (error != ECDSA.RecoverError.NoError || recovered != signer) return ("", 1);
        require(!used[digest] && reserved + maxCost <= totalBudget && identityReserved[identity] + maxCost <= identityBudget, "Budget exhausted");
        if (mint) { require(mintAttempts[identity] < 5, "Mint sponsorship used"); ++mintAttempts[identity]; }
        else { require(lightAttempts[identity] == 0, "First light only"); ++lightAttempts[identity]; }
        used[digest] = true; reserved += maxCost; identityReserved[identity] += maxCost;
        emit Sponsored(digest, identity, maxCost);
        // Conservative reservation includes postOp gas and is not recycled by reverted attempts.
        return (abi.encode(digest), (uint256(validUntil) << 160) | (uint256(starts) << 208));
    }
    function _postOp(PostOpMode mode, bytes calldata context, uint256 actualGasCost, uint256) internal override {
        emit SponsorshipSettled(abi.decode(context, (bytes32)), mode == PostOpMode.opSucceeded, actualGasCost);
    }
}
