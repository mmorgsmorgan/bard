// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BardVouch
 * @notice USDC-staked vouching system with tiered influence and quadratic scaling.
 * @dev Vouchers lock USDC behind a trust statement for a contributor.
 *      Automatically records feedback on the Arc ERC-8004 Reputation Registry.
 *      Vouch stakes are locked for 30 days.
 */

interface IERC20 {
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);

    function transfer(address to, uint256 amount) external returns (bool);

    function balanceOf(address account) external view returns (uint256);

    function approve(address spender, uint256 amount) external returns (bool);
}

interface IReputationRegistry {
    function giveFeedback(
        uint256 agentId,
        int128 score,
        uint8 feedbackType,
        string memory tag,
        string memory metadataURI,
        string memory evidenceURI,
        string memory comment,
        bytes32 feedbackHash
    ) external;
}

contract BardVouch {
    // ──────────────────────────────────────────────
    //  Constants — Arc Testnet addresses
    // ──────────────────────────────────────────────
    address public constant USDC =
        0x3600000000000000000000000000000000000000;
    address public constant REPUTATION_REGISTRY =
        0x8004B663056A597Dffe9eCcC1965A193B7388713;

    uint256 public constant LOCK_DURATION = 30 days;

    // ──────────────────────────────────────────────
    //  Enums
    // ──────────────────────────────────────────────
    enum VouchTier {
        MICRO,      // Min 1 USDC,   multiplier 0.5x
        STANDARD,   // Min 10 USDC,  multiplier 1.0x
        ENDORSED,   // Min 100 USDC, multiplier 1.5x
        FOUNDER     // Min 500 USDC, multiplier 2.0x
    }

    // ──────────────────────────────────────────────
    //  Structs
    // ──────────────────────────────────────────────
    struct Vouch {
        address voucher;
        uint256 contributorId;  // ERC-8004 agent/profile token ID
        uint256 stakedAmount;   // USDC amount (6 decimals)
        uint256 influence;      // sqrt(stake) * tierMultiplier (scaled by 1e6)
        VouchTier tier;
        string statement;
        string ecosystem;
        string evidenceURI;
        int128 score;           // 0-100
        uint256 timestamp;
        uint256 lockExpiry;
        bool active;
        bool withdrawn;
    }

    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────
    mapping(uint256 => Vouch[]) public contributorVouches;
    mapping(address => uint256[]) public voucherContributors; // voucher => contributor IDs
    mapping(address => uint256) public totalStakedByVoucher;
    mapping(uint256 => uint256) public totalStakedForContributor;
    mapping(uint256 => uint256) public activeVouchCount;      // O(1) active count
    mapping(uint256 => uint256) public activeTotalInfluence;  // O(1) influence sum

    uint256 public totalVouches;
    uint256 public totalStaked;

    // Tier minimums in USDC (6 decimals)
    mapping(VouchTier => uint256) public tierMinimum;
    // Tier multipliers (scaled by 100, so 50 = 0.5x, 100 = 1.0x, 150 = 1.5x)
    mapping(VouchTier => uint256) public tierMultiplier;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────
    event VouchCreated(
        address indexed voucher,
        uint256 indexed contributorId,
        uint256 stakedAmount,
        uint256 influence,
        VouchTier tier,
        string ecosystem,
        uint256 lockExpiry,
        uint256 vouchIndex
    );

    event VouchWithdrawn(
        address indexed voucher,
        uint256 indexed contributorId,
        uint256 amount,
        uint256 vouchIndex
    );

    // ──────────────────────────────────────────────
    //  Errors
    // ──────────────────────────────────────────────
    error InsufficientStake(uint256 provided, uint256 minimum);
    error VouchLocked(uint256 unlockTime);
    error NotVoucher();
    error AlreadyWithdrawn();
    error TransferFailed();
    error SelfVouch();

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────
    constructor() {
        // USDC has 6 decimals
        tierMinimum[VouchTier.MICRO] = 1e6;       // 1 USDC
        tierMinimum[VouchTier.STANDARD] = 10e6;    // 10 USDC
        tierMinimum[VouchTier.ENDORSED] = 100e6;   // 100 USDC
        tierMinimum[VouchTier.FOUNDER] = 500e6;    // 500 USDC

        tierMultiplier[VouchTier.MICRO] = 50;      // 0.5x
        tierMultiplier[VouchTier.STANDARD] = 100;  // 1.0x
        tierMultiplier[VouchTier.ENDORSED] = 150;  // 1.5x
        tierMultiplier[VouchTier.FOUNDER] = 200;   // 2.0x
    }

    // ──────────────────────────────────────────────
    //  External — Create Vouch
    // ──────────────────────────────────────────────
    /**
     * @notice Vouch for a contributor by staking USDC.
     * @param contributorId The ERC-8004 identity token ID of the contributor
     * @param stakeAmount Amount of USDC to stake (6 decimals)
     * @param tier Vouch tier (MICRO=0, STANDARD=1, ENDORSED=2, FOUNDER=3)
     * @param statement Written endorsement statement
     * @param ecosystem Ecosystem tag (e.g. "monad", "arc", "base")
     * @param evidenceURI IPFS link to supporting evidence
     * @param score Reputation score 0-100
     */
    function vouch(
        uint256 contributorId,
        uint256 stakeAmount,
        VouchTier tier,
        string memory statement,
        string memory ecosystem,
        string memory evidenceURI,
        int128 score
    ) external {
        // No self-vouching: contributorId is wallet address as uint256
        if (contributorId == uint256(uint160(msg.sender))) revert SelfVouch();

        // Validate stake meets tier minimum
        uint256 minStake = tierMinimum[tier];
        if (stakeAmount < minStake) {
            revert InsufficientStake(stakeAmount, minStake);
        }

        // Transfer USDC from voucher to this contract
        bool success = IERC20(USDC).transferFrom(
            msg.sender,
            address(this),
            stakeAmount
        );
        if (!success) revert TransferFailed();

        // Calculate quadratic influence: sqrt(stake) * tierMultiplier / 100
        // We scale by 1e6 for precision since USDC has 6 decimals
        uint256 influence = (_sqrt(stakeAmount) * tierMultiplier[tier]) / 100;

        uint256 lockExpiry = block.timestamp + LOCK_DURATION;
        uint256 vouchIndex = contributorVouches[contributorId].length;

        // Store vouch
        contributorVouches[contributorId].push(
            Vouch({
                voucher: msg.sender,
                contributorId: contributorId,
                stakedAmount: stakeAmount,
                influence: influence,
                tier: tier,
                statement: statement,
                ecosystem: ecosystem,
                evidenceURI: evidenceURI,
                score: score,
                timestamp: block.timestamp,
                lockExpiry: lockExpiry,
                active: true,
                withdrawn: false
            })
        );

        voucherContributors[msg.sender].push(contributorId);
        totalStakedByVoucher[msg.sender] += stakeAmount;
        totalStakedForContributor[contributorId] += stakeAmount;
        totalStaked += stakeAmount;
        totalVouches++;
        activeVouchCount[contributorId]++;
        activeTotalInfluence[contributorId] += influence;

        // Record on ERC-8004 Reputation Registry (best-effort)
        bytes32 feedbackHash = keccak256(
            abi.encodePacked(statement, msg.sender, contributorId, block.timestamp)
        );

        try IReputationRegistry(REPUTATION_REGISTRY).giveFeedback(
            contributorId,
            score,
            uint8(tier),
            ecosystem,
            evidenceURI,
            evidenceURI,
            statement,
            feedbackHash
        ) {} catch {}

        emit VouchCreated(
            msg.sender,
            contributorId,
            stakeAmount,
            influence,
            tier,
            ecosystem,
            lockExpiry,
            vouchIndex
        );
    }

    // ──────────────────────────────────────────────
    //  External — Withdraw Stake
    // ──────────────────────────────────────────────
    /**
     * @notice Withdraw staked USDC after the lock period expires.
     * @param contributorId The contributor the vouch was for
     * @param vouchIndex The index of the vouch in the contributor's vouch array
     */
    function withdrawStake(
        uint256 contributorId,
        uint256 vouchIndex
    ) external {
        Vouch storage v = contributorVouches[contributorId][vouchIndex];

        if (v.voucher != msg.sender) revert NotVoucher();
        if (v.withdrawn) revert AlreadyWithdrawn();
        if (block.timestamp < v.lockExpiry)
            revert VouchLocked(v.lockExpiry);

        v.withdrawn = true;
        v.active = false;

        totalStakedByVoucher[msg.sender] -= v.stakedAmount;
        totalStakedForContributor[contributorId] -= v.stakedAmount;
        totalStaked -= v.stakedAmount;
        activeVouchCount[contributorId]--;
        activeTotalInfluence[contributorId] -= v.influence;

        bool success = IERC20(USDC).transfer(msg.sender, v.stakedAmount);
        if (!success) revert TransferFailed();

        emit VouchWithdrawn(
            msg.sender,
            contributorId,
            v.stakedAmount,
            vouchIndex
        );
    }

    // ──────────────────────────────────────────────
    //  View — Query Vouches
    // ──────────────────────────────────────────────
    function getVouches(
        uint256 contributorId
    ) external view returns (Vouch[] memory) {
        return contributorVouches[contributorId];
    }

    function getVouchCount(
        uint256 contributorId
    ) external view returns (uint256) {
        return contributorVouches[contributorId].length;
    }

    function getActiveVouchCount(
        uint256 contributorId
    ) external view returns (uint256) {
        return activeVouchCount[contributorId];
    }

    function getTotalInfluence(
        uint256 contributorId
    ) external view returns (uint256) {
        return activeTotalInfluence[contributorId];
    }

    function getVoucherContributors(
        address voucher
    ) external view returns (uint256[] memory) {
        return voucherContributors[voucher];
    }

    // ──────────────────────────────────────────────
    //  Internal — Integer Square Root (Babylonian)
    // ──────────────────────────────────────────────
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }
}
