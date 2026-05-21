// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BardPFP
 * @notice Soulbound profile picture NFT for BARD contributors.
 * @dev Non-transferable. One PFP per wallet. 6-month cooldown before changes.
 *      Image stored as tokenURI (data URI or IPFS hash).
 */
contract BardPFP {
    // ── Constants ──
    uint256 public constant CHANGE_COOLDOWN = 180 days; // 6 months

    // ── State ──
    mapping(address => uint256) public walletToTokenId;
    mapping(uint256 => address) public tokenToWallet;
    mapping(uint256 => string) private _tokenURIs;
    mapping(uint256 => uint256) public mintedAt;
    mapping(uint256 => uint256) public lastChangedAt;

    uint256 public totalSupply;

    // ── Events ──
    event PFPMinted(address indexed wallet, uint256 tokenId, string tokenURI, uint256 timestamp);
    event PFPUpdated(address indexed wallet, uint256 tokenId, string newTokenURI, uint256 timestamp);

    // ── Errors ──
    error AlreadyHasPFP(address wallet);
    error NoPFP(address wallet);
    error CooldownActive(uint256 availableAt);
    error EmptyURI();

    // ── Mint ──
    /**
     * @notice Mint a soulbound PFP. One per wallet.
     * @param tokenURI The image URI (data URI or IPFS)
     */
    function mint(string memory tokenURI) external {
        if (walletToTokenId[msg.sender] != 0) revert AlreadyHasPFP(msg.sender);
        if (bytes(tokenURI).length == 0) revert EmptyURI();

        totalSupply++;
        uint256 tokenId = totalSupply;

        walletToTokenId[msg.sender] = tokenId;
        tokenToWallet[tokenId] = msg.sender;
        _tokenURIs[tokenId] = tokenURI;
        mintedAt[tokenId] = block.timestamp;
        lastChangedAt[tokenId] = block.timestamp;

        emit PFPMinted(msg.sender, tokenId, tokenURI, block.timestamp);
    }

    // ── Update ──
    /**
     * @notice Update PFP image. Only after 6-month cooldown.
     * @param newTokenURI The new image URI
     */
    function updatePFP(string memory newTokenURI) external {
        uint256 tokenId = walletToTokenId[msg.sender];
        if (tokenId == 0) revert NoPFP(msg.sender);
        if (bytes(newTokenURI).length == 0) revert EmptyURI();

        uint256 availableAt = lastChangedAt[tokenId] + CHANGE_COOLDOWN;
        if (block.timestamp < availableAt) revert CooldownActive(availableAt);

        _tokenURIs[tokenId] = newTokenURI;
        lastChangedAt[tokenId] = block.timestamp;

        emit PFPUpdated(msg.sender, tokenId, newTokenURI, block.timestamp);
    }

    // ── View ──
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(tokenToWallet[tokenId] != address(0), "Token does not exist");
        return _tokenURIs[tokenId];
    }

    function getPFP(address wallet) external view returns (string memory) {
        uint256 tokenId = walletToTokenId[wallet];
        if (tokenId == 0) return "";
        return _tokenURIs[tokenId];
    }

    function hasPFP(address wallet) external view returns (bool) {
        return walletToTokenId[wallet] != 0;
    }

    function getChangeAvailableAt(address wallet) external view returns (uint256) {
        uint256 tokenId = walletToTokenId[wallet];
        if (tokenId == 0) return 0;
        return lastChangedAt[tokenId] + CHANGE_COOLDOWN;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = tokenToWallet[tokenId];
        require(owner != address(0), "Token does not exist");
        return owner;
    }

    // ── Soulbound: No transfers ──
    // This contract intentionally does NOT implement ERC-721 transfer functions.
    // Tokens are permanently bound to the minting wallet.
}
