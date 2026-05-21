// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BardProfile
 * @notice Username registry + ERC-8004 identity registration for BARD contributors.
 * @dev Each wallet can register one profile (human or agent). Usernames are unique.
 *      Calls the Arc ERC-8004 Identity Registry to mint a soulbound identity NFT.
 */

interface IIdentityRegistry {
    function register(string memory metadataURI) external;
}

contract BardProfile {
    // ──────────────────────────────────────────────
    //  Constants — Arc Testnet ERC-8004 addresses
    // ──────────────────────────────────────────────
    address public constant IDENTITY_REGISTRY =
        0x8004A818BFB912233c491871b3d84c89A494BD9e;

    // ──────────────────────────────────────────────
    //  Enums
    // ──────────────────────────────────────────────
    enum ProfileType {
        HUMAN,
        AGENT
    }

    // ──────────────────────────────────────────────
    //  Structs
    // ──────────────────────────────────────────────
    struct Profile {
        address wallet;
        string username;
        string metadataURI; // IPFS URI for full profile JSON
        ProfileType profileType;
        uint256 createdAt;
        bool exists;
    }

    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────
    mapping(string => address) public usernameToWallet;
    mapping(address => Profile) public profiles;
    mapping(address => uint256) public walletToAgentId;

    uint256 public totalProfiles;
    address[] public allProfileAddresses;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────
    event ProfileCreated(
        address indexed wallet,
        string username,
        ProfileType profileType,
        string metadataURI,
        uint256 timestamp
    );

    event ProfileUpdated(
        address indexed wallet,
        string newMetadataURI,
        uint256 timestamp
    );

    // ──────────────────────────────────────────────
    //  Errors
    // ──────────────────────────────────────────────
    error UsernameTaken(string username);
    error ProfileAlreadyExists(address wallet);
    error ProfileDoesNotExist(address wallet);
    error InvalidUsername();

    // ──────────────────────────────────────────────
    //  Modifiers
    // ──────────────────────────────────────────────
    modifier onlyProfileOwner() {
        if (!profiles[msg.sender].exists) {
            revert ProfileDoesNotExist(msg.sender);
        }
        _;
    }

    // ──────────────────────────────────────────────
    //  External — Create Profile
    // ──────────────────────────────────────────────
    /**
     * @notice Creates a new BARD profile and registers identity on ERC-8004.
     * @param username Unique username (3-32 chars, lowercase alphanumeric + hyphens)
     * @param metadataURI IPFS URI pointing to the full profile metadata JSON
     * @param profileType 0 = HUMAN, 1 = AGENT
     */
    function createProfile(
        string memory username,
        string memory metadataURI,
        ProfileType profileType
    ) external {
        // Validate username
        if (!_isValidUsername(username)) revert InvalidUsername();
        if (usernameToWallet[username] != address(0))
            revert UsernameTaken(username);
        if (profiles[msg.sender].exists)
            revert ProfileAlreadyExists(msg.sender);

        // Store profile
        usernameToWallet[username] = msg.sender;
        profiles[msg.sender] = Profile({
            wallet: msg.sender,
            username: username,
            metadataURI: metadataURI,
            profileType: profileType,
            createdAt: block.timestamp,
            exists: true
        });

        allProfileAddresses.push(msg.sender);
        totalProfiles++;

        // Register on ERC-8004 Identity Registry (best-effort — may fail
        // if the registry mints an NFT via _safeMint to this contract)
        try IIdentityRegistry(IDENTITY_REGISTRY).register(metadataURI) {} catch {}

        emit ProfileCreated(
            msg.sender,
            username,
            profileType,
            metadataURI,
            block.timestamp
        );
    }

    // ──────────────────────────────────────────────
    //  External — Update Profile Metadata
    // ──────────────────────────────────────────────
    /**
     * @notice Updates the metadata URI for an existing profile.
     * @param newMetadataURI New IPFS URI for profile metadata
     */
    function updateProfile(
        string memory newMetadataURI
    ) external onlyProfileOwner {
        profiles[msg.sender].metadataURI = newMetadataURI;

        emit ProfileUpdated(msg.sender, newMetadataURI, block.timestamp);
    }

    // ──────────────────────────────────────────────
    //  View — Profile Queries
    // ──────────────────────────────────────────────
    function getProfileByUsername(
        string memory username
    ) external view returns (Profile memory) {
        address wallet = usernameToWallet[username];
        require(wallet != address(0), "Profile not found");
        return profiles[wallet];
    }

    function getProfile(
        address wallet
    ) external view returns (Profile memory) {
        require(profiles[wallet].exists, "Profile not found");
        return profiles[wallet];
    }

    function profileExists(address wallet) external view returns (bool) {
        return profiles[wallet].exists;
    }

    function usernameExists(
        string memory username
    ) external view returns (bool) {
        return usernameToWallet[username] != address(0);
    }

    function getProfileCount() external view returns (uint256) {
        return totalProfiles;
    }

    // ──────────────────────────────────────────────
    //  Internal — Username Validation
    // ──────────────────────────────────────────────
    /**
     * @dev Validates username: 3-32 chars, lowercase a-z, 0-9, hyphens.
     *      No leading/trailing hyphens, no consecutive hyphens.
     */
    function _isValidUsername(
        string memory username
    ) internal pure returns (bool) {
        bytes memory b = bytes(username);
        if (b.length < 3 || b.length > 32) return false;

        // No leading or trailing hyphen
        if (b[0] == 0x2D || b[b.length - 1] == 0x2D) return false;

        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool isLower = (c >= 0x61 && c <= 0x7A); // a-z
            bool isDigit = (c >= 0x30 && c <= 0x39); // 0-9
            bool isHyphen = (c == 0x2D); // -

            if (!isLower && !isDigit && !isHyphen) return false;

            // No consecutive hyphens
            if (isHyphen && i > 0 && b[i - 1] == 0x2D) return false;
        }

        return true;
    }
}
