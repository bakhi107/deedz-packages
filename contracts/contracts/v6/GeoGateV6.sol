// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Attester assigns opaque, stable identity commitments, never personal data.
contract GeoGateV6 is Ownable {
    struct Attestation { bytes32 identity; uint64 expiry; }
    address public attester;
    mapping(address => Attestation) public attestations;
    mapping(bytes32 => bool) public revokedIdentity;
    mapping(address => mapping(bytes32 => bool)) public tickerDenied;
    event Attested(address indexed wallet, bytes32 indexed identity, uint64 expiry);
    event AttesterChanged(address indexed previousAttester, address indexed newAttester);
    constructor(address initialAttester) Ownable(initialAttester) {
        require(initialAttester != address(0), "Invalid attester");
        attester = initialAttester;
    }
    modifier onlyAttester() { require(msg.sender == attester, "Only attester"); _; }
    function setAttester(address value) external onlyOwner {
        require(value != address(0), "Invalid attester");
        emit AttesterChanged(attester, value);
        attester = value;
    }
    function attest(address wallet, bytes32 identity, uint64 expiry) external onlyAttester {
        require(wallet != address(0) && identity != bytes32(0) && expiry > block.timestamp, "Invalid attestation");
        bytes32 prior = attestations[wallet].identity;
        require(prior == bytes32(0) || prior == identity, "Identity is permanent");
        attestations[wallet] = Attestation(identity, expiry);
        emit Attested(wallet, identity, expiry);
    }
    function revoke(bytes32 identity, bool revoked) external onlyAttester { revokedIdentity[identity] = revoked; }
    function restrictTicker(address wallet, bytes32 ticker, bool denied) external onlyAttester { tickerDenied[wallet][ticker] = denied; }
    function identityOf(address wallet) external view returns (bytes32) { return attestations[wallet].identity; }
    function isAllowed(address wallet) public view returns (bool) {
        Attestation memory a = attestations[wallet];
        return a.identity != bytes32(0) && a.expiry > block.timestamp && !revokedIdentity[a.identity];
    }
    function isAllowedFor(address wallet, bytes32 ticker) external view returns (bool) {
        return isAllowed(wallet) && !tickerDenied[wallet][ticker];
    }
}
