// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BardBadge
 * @notice Soulbound (non-transferable) reputation badges for BARD contributors.
 * @dev Implements a minimal ERC-721 with transfer restrictions.
 *      Only the contract owner can mint badges. Badges cannot be transferred.
 */

contract BardBadge {
    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────
    string public name = "BARD Badge";
    string public symbol = "BADGE";

    address public owner;

    uint256 private _nextTokenId = 1;

    struct Badge {
        address holder;
        string badgeType;  // e.g. "verified_builder", "trusted_voucher"
        string ecosystem;  // e.g. "monad", "arc", "" for global
        string metadataURI;
        uint256 mintedAt;
    }

    mapping(uint256 => Badge) public badges;
    mapping(address => uint256[]) public holderBadges;

    // Badge type => wallet => has badge (prevent duplicates)
    mapping(string => mapping(address => bool)) public hasBadge;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────
    event BadgeMinted(
        address indexed holder,
        uint256 indexed tokenId,
        string badgeType,
        string ecosystem
    );

    // ──────────────────────────────────────────────
    //  Errors
    // ──────────────────────────────────────────────
    error NotOwner();
    error BadgeAlreadyHeld();
    error TransferBlocked();

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────
    constructor() {
        owner = msg.sender;
    }

    // ──────────────────────────────────────────────
    //  External — Mint Badge
    // ──────────────────────────────────────────────
    /**
     * @notice Mint a soulbound badge to a contributor.
     * @param holder The wallet address receiving the badge
     * @param badgeType The badge category string
     * @param ecosystem The ecosystem this badge is specific to (empty for global)
     * @param metadataURI IPFS URI with badge metadata/image
     */
    function mintBadge(
        address holder,
        string memory badgeType,
        string memory ecosystem,
        string memory metadataURI
    ) external {
        if (msg.sender != owner) revert NotOwner();
        if (hasBadge[badgeType][holder]) revert BadgeAlreadyHeld();

        uint256 tokenId = _nextTokenId++;

        badges[tokenId] = Badge({
            holder: holder,
            badgeType: badgeType,
            ecosystem: ecosystem,
            metadataURI: metadataURI,
            mintedAt: block.timestamp
        });

        holderBadges[holder].push(tokenId);
        hasBadge[badgeType][holder] = true;

        emit BadgeMinted(holder, tokenId, badgeType, ecosystem);
    }

    // ──────────────────────────────────────────────
    //  View — Query Badges
    // ──────────────────────────────────────────────
    function getBadge(uint256 tokenId) external view returns (Badge memory) {
        return badges[tokenId];
    }

    function getHolderBadges(
        address holder
    ) external view returns (uint256[] memory) {
        return holderBadges[holder];
    }

    function getBadgeCount(address holder) external view returns (uint256) {
        return holderBadges[holder].length;
    }

    // ──────────────────────────────────────────────
    //  Soulbound — Block All Transfers
    // ──────────────────────────────────────────────
    function transferFrom(address, address, uint256) external pure {
        revert TransferBlocked();
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert TransferBlocked();
    }

    function safeTransferFrom(
        address,
        address,
        uint256,
        bytes memory
    ) external pure {
        revert TransferBlocked();
    }

    function approve(address, uint256) external pure {
        revert TransferBlocked();
    }

    function setApprovalForAll(address, bool) external pure {
        revert TransferBlocked();
    }
}
