// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BardProof
 * @notice On-chain proof-of-work storage for BARD contributors.
 * @dev Each wallet can submit proofs of contribution. Proofs are immutable once submitted.
 *      Validators can mark proofs as validated (future: DAO governance).
 */
contract BardProof {
    // ──────────────────────────────────────────────
    //  Enums
    // ──────────────────────────────────────────────
    enum ProofStatus {
        UNVALIDATED,
        VALIDATED,
        DISPUTED
    }

    // ──────────────────────────────────────────────
    //  Structs
    // ──────────────────────────────────────────────
    struct Proof {
        address contributor;
        string title;
        string description;
        string ecosystem;        // e.g. "arc", "monad"
        string contributionType; // e.g. "design", "code", "community"
        string externalLink;     // URL to evidence
        ProofStatus status;
        uint256 timestamp;
    }

    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────
    Proof[] public allProofs;
    mapping(address => uint256[]) public contributorProofs; // wallet => proof IDs
    mapping(address => bool) public validators; // authorized validators

    uint256 public totalProofs;
    address public owner;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────
    event ProofSubmitted(
        address indexed contributor,
        uint256 indexed proofId,
        string title,
        string ecosystem,
        string contributionType,
        uint256 timestamp
    );

    event ProofValidated(uint256 indexed proofId, uint256 timestamp);
    event ProofDisputed(uint256 indexed proofId, uint256 timestamp);

    // ──────────────────────────────────────────────
    //  Errors
    // ──────────────────────────────────────────────
    error EmptyTitle();
    error NotOwner();
    error NotValidator();
    error InvalidProofId();

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────
    constructor() {
        owner = msg.sender;
    }

    // ──────────────────────────────────────────────
    //  External — Submit Proof
    // ──────────────────────────────────────────────
    /**
     * @notice Submit a proof of contribution.
     * @param title Short title describing the contribution
     * @param description Detailed description
     * @param ecosystem Ecosystem tag
     * @param contributionType Type of contribution
     * @param externalLink URL to supporting evidence
     */
    function submitProof(
        string memory title,
        string memory description,
        string memory ecosystem,
        string memory contributionType,
        string memory externalLink
    ) external {
        if (bytes(title).length == 0) revert EmptyTitle();

        uint256 proofId = allProofs.length;

        allProofs.push(Proof({
            contributor: msg.sender,
            title: title,
            description: description,
            ecosystem: ecosystem,
            contributionType: contributionType,
            externalLink: externalLink,
            status: ProofStatus.UNVALIDATED,
            timestamp: block.timestamp
        }));

        contributorProofs[msg.sender].push(proofId);
        totalProofs++;

        emit ProofSubmitted(
            msg.sender,
            proofId,
            title,
            ecosystem,
            contributionType,
            block.timestamp
        );
    }

    // ──────────────────────────────────────────────
    //  External — Manage Validators
    // ──────────────────────────────────────────────
    function addValidator(address validator) external {
        if (msg.sender != owner) revert NotOwner();
        validators[validator] = true;
    }

    function removeValidator(address validator) external {
        if (msg.sender != owner) revert NotOwner();
        validators[validator] = false;
    }

    // ──────────────────────────────────────────────
    //  External — Validate/Dispute (owner or validators)
    // ──────────────────────────────────────────────
    function validateProof(uint256 proofId) external {
        if (msg.sender != owner && !validators[msg.sender]) revert NotValidator();
        if (proofId >= allProofs.length) revert InvalidProofId();

        allProofs[proofId].status = ProofStatus.VALIDATED;
        emit ProofValidated(proofId, block.timestamp);
    }

    function disputeProof(uint256 proofId) external {
        if (msg.sender != owner && !validators[msg.sender]) revert NotValidator();
        if (proofId >= allProofs.length) revert InvalidProofId();

        allProofs[proofId].status = ProofStatus.DISPUTED;
        emit ProofDisputed(proofId, block.timestamp);
    }

    // ──────────────────────────────────────────────
    //  View — Query Proofs
    // ──────────────────────────────────────────────
    function getProof(uint256 proofId) external view returns (Proof memory) {
        if (proofId >= allProofs.length) revert InvalidProofId();
        return allProofs[proofId];
    }

    function getContributorProofIds(address contributor) external view returns (uint256[] memory) {
        return contributorProofs[contributor];
    }

    function getContributorProofCount(address contributor) external view returns (uint256) {
        return contributorProofs[contributor].length;
    }

    function getProofsByContributor(address contributor) external view returns (Proof[] memory) {
        uint256[] storage ids = contributorProofs[contributor];
        Proof[] memory result = new Proof[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            result[i] = allProofs[ids[i]];
        }
        return result;
    }
}
