// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title BardRecordBoard
 * @notice Permanently records verified agent contributions on-chain.
 *         When a contribution reaches 3+ endorsements, it is recorded here
 *         with a content hash — creating a tamper-proof, public audit trail.
 *
 *         Inspired by OpenStoa's RecordBoard, adapted for BARD's public
 *         identity model (wallets, not nullifiers).
 */
contract BardRecordBoard is Ownable, Pausable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ── Types ──

    struct ContributionRecord {
        bytes32 contentHash;      // keccak256(contributionId + proofHash)
        address contributor;      // Agent owner wallet
        address[] endorsers;      // Wallets that endorsed (up to 10 stored)
        string contributionType;  // "research", "code_review", etc.
        uint256 timestamp;
        uint256 reputationAtRecord; // Agent's reputation when recorded
    }

    // ── State ──

    address public service; // BARD backend service wallet

    // contributionHash → record
    mapping(bytes32 => ContributionRecord) internal _records;
    mapping(bytes32 => bool) public isRecorded;

    // contributor → their recorded contribution hashes
    mapping(address => bytes32[]) public contributorRecords;

    uint256 public totalRecords;

    // ── Events ──

    event ContributionRecorded(
        bytes32 indexed contentHash,
        address indexed contributor,
        string contributionType,
        uint256 timestamp,
        uint256 reputationAtRecord
    );
    event ServiceUpdated(address indexed oldService, address indexed newService);

    // ── Errors ──

    error NotAuthorized();
    error AlreadyRecorded();
    error SignatureExpired();
    error InvalidServiceSignature();

    modifier onlyService() {
        if (msg.sender != service) revert NotAuthorized();
        _;
    }

    constructor(address _service) Ownable(msg.sender) {
        service = _service;
    }

    // ── Configuration ──

    function setService(address _newService) external onlyOwner {
        address old = service;
        service = _newService;
        emit ServiceUpdated(old, _newService);
    }

    // ── Service-proxied recording (free for contributor) ──

    /**
     * @notice Record a verified contribution via the backend service.
     * @param contentHash       keccak256(contributionId + proofHash)
     * @param contributor       Agent owner's wallet address
     * @param endorsers         Up to 10 endorser wallets
     * @param contributionType  Type string ("research", "code_review", etc.)
     * @param reputationAtRecord Agent reputation score at time of recording
     */
    function record(
        bytes32 contentHash,
        address contributor,
        address[] calldata endorsers,
        string calldata contributionType,
        uint256 reputationAtRecord
    ) external onlyService whenNotPaused {
        _record(contentHash, contributor, endorsers, contributionType, reputationAtRecord);
    }

    /**
     * @notice Direct user recording with backend signature (gasless pattern).
     *         Allows contributors to record themselves using a signed payload.
     */
    function recordDirect(
        bytes32 contentHash,
        address contributor,
        address[] calldata endorsers,
        string calldata contributionType,
        uint256 reputationAtRecord,
        uint256 expiry,
        bytes calldata serviceSignature
    ) external whenNotPaused {
        if (block.timestamp > expiry) revert SignatureExpired();

        bytes32 digest = keccak256(abi.encode(
            contentHash, contributor, contributionType, reputationAtRecord, expiry
        ));
        bytes32 ethSignedHash = digest.toEthSignedMessageHash();
        address signer = ethSignedHash.recover(serviceSignature);
        if (signer != service) revert InvalidServiceSignature();

        _record(contentHash, contributor, endorsers, contributionType, reputationAtRecord);
    }

    // ── Internal ──

    function _record(
        bytes32 contentHash,
        address contributor,
        address[] calldata endorsers,
        string calldata contributionType,
        uint256 reputationAtRecord
    ) internal {
        if (isRecorded[contentHash]) revert AlreadyRecorded();
        isRecorded[contentHash] = true;

        // Store up to 10 endorsers
        address[] memory storedEndorsers = new address[](endorsers.length > 10 ? 10 : endorsers.length);
        for (uint256 i = 0; i < storedEndorsers.length; i++) {
            storedEndorsers[i] = endorsers[i];
        }

        _records[contentHash] = ContributionRecord({
            contentHash: contentHash,
            contributor: contributor,
            endorsers: storedEndorsers,
            contributionType: contributionType,
            timestamp: block.timestamp,
            reputationAtRecord: reputationAtRecord
        });

        contributorRecords[contributor].push(contentHash);
        totalRecords++;

        emit ContributionRecorded(
            contentHash, contributor, contributionType, block.timestamp, reputationAtRecord
        );
    }

    // ── View ──

    function getRecord(bytes32 contentHash) external view returns (ContributionRecord memory) {
        return _records[contentHash];
    }

    function getContributorRecords(address contributor) external view returns (bytes32[] memory) {
        return contributorRecords[contributor];
    }

    function getContributorRecordCount(address contributor) external view returns (uint256) {
        return contributorRecords[contributor].length;
    }

    // ── Admin ──

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
