// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC8183Hook} from "./vendor/IERC8183Hook.sol";

/**
 * @title BardJobHook
 * @notice IERC-8183 hook + side-car escrow for BARD-specific bounty logic on top
 *         of the AgenticCommerce reference implementation (ERC-8183).
 *
 *  Design — "best of all sides"
 *  ────────────────────────────
 *  ERC-8183's reference contract is strict: every role (client / provider /
 *  evaluator) calls it directly, so a wrapper cannot impersonate any of them.
 *  This hook therefore sits BESIDE AgenticCommerce, not in front of it:
 *
 *    Client/Provider/Evaluator -> AgenticCommerce  (custody of agent earnings)
 *                                       │
 *                                       │ before/after hook callbacks
 *                                       ▼
 *                                  BardJobHook  (custody of platform fee,
 *                                                min-rep gate, fee cap)
 *
 *  The standard custodies the agent's earnings. This hook custodies the
 *  platform fee separately AND enforces BARD-specific policy via hook
 *  callbacks. The user-facing tx flow is:
 *
 *    1. client    -> AgenticCommerce.createJob(provider, evaluator, expiredAt,
 *                                              desc, hook = this, providerAgentId)
 *    2. client    -> BardJobHook.configureBardJob(jobId, platformFee,
 *                                                 feeRecipient, maxFeeBps,
 *                                                 minRepScore)
 *    3. client    -> AgenticCommerce.setProvider(jobId, agent, agentId)  // first-come
 *    4. provider  -> AgenticCommerce.setBudget(jobId, USDC, agentEarnings, "")
 *                    -> beforeAction(setBudget) enforces min-rep
 *    5. client    -> BardJobHook.depositFee(jobId)            // pulls platformFee
 *    6. client    -> AgenticCommerce.fund(jobId, agentEarnings, "")
 *                    -> beforeAction(fund) enforces fee was deposited
 *    7. provider  -> AgenticCommerce.submit(jobId, hash, "")
 *    8a. evaluator -> AgenticCommerce.complete(jobId, reason, "")
 *                     -> afterAction(complete) sends fee to feeRecipient
 *    8b. evaluator -> AgenticCommerce.reject(jobId, reason, "")
 *                     -> afterAction(reject) refunds fee to client
 *    8c. anyone   -> AgenticCommerce.claimRefund(jobId)       // refunds earnings
 *                    BardJobHook.refundFee(jobId)             // refunds fee
 *
 *  Steps 5+6 are both client-signed and can be relayed as a Multicall or via
 *  ERC-2612 permits. Steps 8c (refund legs) are permissionless on both sides.
 */
contract BardJobHook is IERC8183Hook {
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────
    //  Selectors of the AgenticCommerce functions we hook
    // ──────────────────────────────────────────────
    bytes4 internal constant SEL_SET_BUDGET = bytes4(keccak256("setBudget(uint256,address,uint256,bytes)"));
    bytes4 internal constant SEL_FUND       = bytes4(keccak256("fund(uint256,uint256,bytes)"));
    bytes4 internal constant SEL_SUBMIT     = bytes4(keccak256("submit(uint256,bytes32,bytes)"));
    bytes4 internal constant SEL_COMPLETE   = bytes4(keccak256("complete(uint256,bytes32,bytes)"));
    bytes4 internal constant SEL_REJECT     = bytes4(keccak256("reject(uint256,bytes32,bytes)"));

    // ──────────────────────────────────────────────
    //  Immutables
    // ──────────────────────────────────────────────
    address public immutable agenticCommerce;
    IERC20  public immutable paymentToken;

    // ──────────────────────────────────────────────
    //  Optional ERC-8004 reputation reader for on-chain min-rep gate
    // ──────────────────────────────────────────────
    IReputationReader public reputationReader;

    // ──────────────────────────────────────────────
    //  Per-job platform-fee bookkeeping
    // ──────────────────────────────────────────────
    struct FeeMeta {
        uint128 platformFee;
        address feeRecipient;
        uint16  maxFeeBps;
        uint16  minRepScore;
        bool    configured;
        bool    feeDeposited;
        bool    feeSettled;
    }
    mapping(uint256 => FeeMeta) internal _feeMeta;

    address public owner;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────
    event BardJobConfigured(
        uint256 indexed jobId,
        uint128 platformFee,
        address indexed feeRecipient,
        uint16 maxFeeBps,
        uint16 minRepScore
    );
    event BardFeeDeposited(uint256 indexed jobId, address indexed client, uint128 amount);
    event BardFeeReleased(uint256 indexed jobId, address indexed feeRecipient, uint128 amount);
    event BardFeeRefunded(uint256 indexed jobId, address indexed client, uint128 amount, RefundCause cause);
    event ReputationReaderSet(address indexed reader);
    event OwnerTransferred(address indexed previous, address indexed next);

    enum RefundCause { Rejected, Expired }

    // ──────────────────────────────────────────────
    //  Errors
    // ──────────────────────────────────────────────
    error NotOwner();
    error NotAgenticCommerce();
    error NotClient();
    error AlreadyConfigured();
    error NotConfigured();
    error AlreadyDeposited();
    error AlreadySettled();
    error FeeNotDeposited();
    error FeeExceedsCap(uint16 actualBps, uint16 maxBps);
    error JobNotInRefundState();
    error ReputationTooLow(uint256 score, uint16 required);
    error InvalidAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgenticCommerce() {
        if (msg.sender != agenticCommerce) revert NotAgenticCommerce();
        _;
    }

    constructor(address _agenticCommerce, address _paymentToken, address _reputationReader) {
        if (_agenticCommerce == address(0) || _paymentToken == address(0)) revert InvalidAddress();
        agenticCommerce  = _agenticCommerce;
        paymentToken     = IERC20(_paymentToken);
        reputationReader = IReputationReader(_reputationReader);
        owner = msg.sender;
    }

    // ──────────────────────────────────────────────
    //  Configure BARD policy for a job
    //  Must be called by job.client, exactly once, after AgenticCommerce.createJob.
    // ──────────────────────────────────────────────

    function configureBardJob(
        uint256 jobId,
        uint128 platformFee,
        address feeRecipient,
        uint16 maxFeeBps,
        uint16 minRepScore
    ) external {
        FeeMeta storage fm = _feeMeta[jobId];
        if (fm.configured) revert AlreadyConfigured();
        if (platformFee > 0 && feeRecipient == address(0)) revert InvalidAddress();

        address client = _readClient(jobId);
        if (msg.sender != client) revert NotClient();

        // Compute the fee bps against the worst-case total upfront so a future
        // depositFee/fund pair cannot sneak past the consented cap.
        if (maxFeeBps > 0 && platformFee > 0) {
            // We don't know agentEarnings yet (provider hasn't set budget),
            // so we defer the cap check to depositFee/fund where budget is known.
        }

        fm.platformFee  = platformFee;
        fm.feeRecipient = feeRecipient;
        fm.maxFeeBps    = maxFeeBps;
        fm.minRepScore  = minRepScore;
        fm.configured   = true;

        emit BardJobConfigured(jobId, platformFee, feeRecipient, maxFeeBps, minRepScore);
    }

    // ──────────────────────────────────────────────
    //  Client deposits the platform-fee portion before funding the standard escrow
    // ──────────────────────────────────────────────

    function depositFee(uint256 jobId) external {
        FeeMeta storage fm = _feeMeta[jobId];
        if (!fm.configured) revert NotConfigured();
        if (fm.feeDeposited) revert AlreadyDeposited();

        address client = _readClient(jobId);
        if (msg.sender != client) revert NotClient();

        // Verify the consented cap now that agentEarnings (job.budget) is set.
        uint128 platformFee = fm.platformFee;
        if (fm.maxFeeBps > 0 && platformFee > 0) {
            uint256 agentEarnings = _readBudget(jobId);
            uint256 total = uint256(platformFee) + agentEarnings;
            if (total > 0) {
                uint256 actualBps = (uint256(platformFee) * 10_000) / total;
                if (actualBps > fm.maxFeeBps) revert FeeExceedsCap(uint16(actualBps), fm.maxFeeBps);
            }
        }

        fm.feeDeposited = true;
        if (platformFee > 0) {
            paymentToken.safeTransferFrom(msg.sender, address(this), platformFee);
        }

        emit BardFeeDeposited(jobId, msg.sender, platformFee);
    }

    // ──────────────────────────────────────────────
    //  Permissionless safety-net refund
    //  Required because AgenticCommerce.claimRefund() is intentionally
    //  not hookable, so an Expired job never fires our afterAction.
    // ──────────────────────────────────────────────

    function refundFee(uint256 jobId) external {
        FeeMeta storage fm = _feeMeta[jobId];
        if (!fm.feeDeposited) revert FeeNotDeposited();
        if (fm.feeSettled) revert AlreadySettled();

        uint8 status = _readStatus(jobId);
        RefundCause cause;
        if (status == 4) {                  // Rejected
            cause = RefundCause.Rejected;
        } else if (status == 5) {           // Expired
            cause = RefundCause.Expired;
        } else {
            revert JobNotInRefundState();
        }

        uint128 amount = fm.platformFee;
        fm.feeSettled = true;
        address client = _readClient(jobId);
        if (amount > 0) {
            paymentToken.safeTransfer(client, amount);
        }
        emit BardFeeRefunded(jobId, client, amount, cause);
    }

    // ──────────────────────────────────────────────
    //  Hook callbacks
    // ──────────────────────────────────────────────

    function beforeAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata /* data */
    ) external onlyAgenticCommerce {
        FeeMeta storage fm = _feeMeta[jobId];

        if (selector == SEL_SET_BUDGET) {
            // Min-rep gate when provider is being onboarded with a budget.
            if (fm.minRepScore > 0 && address(reputationReader) != address(0)) {
                uint256 agentId = _readProviderAgentId(jobId);
                if (agentId != 0) {
                    uint256 score = reputationReader.getScore(agentId);
                    if (score < fm.minRepScore) revert ReputationTooLow(score, fm.minRepScore);
                }
            }
            return;
        }

        if (selector == SEL_FUND) {
            // Reject funding until the platform fee has been parked here.
            // For zero-fee jobs (human bounties), configureBardJob may have
            // been skipped — only enforce when a fee was configured.
            if (fm.configured && fm.platformFee > 0 && !fm.feeDeposited) {
                revert FeeNotDeposited();
            }
            return;
        }
        // submit / complete / reject: nothing to gate beforehand.
    }

    function afterAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata /* data */
    ) external onlyAgenticCommerce {
        FeeMeta storage fm = _feeMeta[jobId];

        if (selector == SEL_COMPLETE) {
            if (fm.feeDeposited && !fm.feeSettled && fm.platformFee > 0) {
                uint128 amount = fm.platformFee;
                address recipient = fm.feeRecipient;
                fm.feeSettled = true;
                paymentToken.safeTransfer(recipient, amount);
                emit BardFeeReleased(jobId, recipient, amount);
            }
            return;
        }

        if (selector == SEL_REJECT) {
            if (fm.feeDeposited && !fm.feeSettled && fm.platformFee > 0) {
                uint128 amount = fm.platformFee;
                fm.feeSettled = true;
                address client = _readClient(jobId);
                paymentToken.safeTransfer(client, amount);
                emit BardFeeRefunded(jobId, client, amount, RefundCause.Rejected);
            }
            return;
        }
        // Other selectors: no-op.
    }

    // ──────────────────────────────────────────────
    //  Admin
    // ──────────────────────────────────────────────

    function setReputationReader(address reader) external onlyOwner {
        reputationReader = IReputationReader(reader);
        emit ReputationReaderSet(reader);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    // ──────────────────────────────────────────────
    //  Views
    // ──────────────────────────────────────────────

    function getFeeMeta(uint256 jobId) external view returns (FeeMeta memory) {
        return _feeMeta[jobId];
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return
            interfaceId == type(IERC8183Hook).interfaceId ||
            interfaceId == type(IERC165).interfaceId;
    }

    // ──────────────────────────────────────────────
    //  Internal — read fields off AgenticCommerce
    //  via the public auto-generated `jobs(uint256)` getter.
    // ──────────────────────────────────────────────

    /// @dev Job tuple layout from `mapping(uint256 => Job) public jobs`:
    ///      (client, status, provider, expiredAt, evaluator, submittedAt,
    ///       budget, hook, paymentToken, providerAgentId, description)
    ///      `description` is dynamic so it does not appear in the auto-getter return.

    function _readClient(uint256 jobId) internal view returns (address client) {
        (client,,,,,,,,,) = IAgenticCommerceView(agenticCommerce).jobs(jobId);
    }

    function _readStatus(uint256 jobId) internal view returns (uint8 status) {
        (, status,,,,,,,,) = IAgenticCommerceView(agenticCommerce).jobs(jobId);
    }

    function _readBudget(uint256 jobId) internal view returns (uint256 budget) {
        (,,,,,, budget,,,) = IAgenticCommerceView(agenticCommerce).jobs(jobId);
    }

    function _readProviderAgentId(uint256 jobId) internal view returns (uint256 agentId) {
        (,,,,,,,,, agentId) = IAgenticCommerceView(agenticCommerce).jobs(jobId);
    }
}

// ──────────────────────────────────────────────
//  External interfaces
// ──────────────────────────────────────────────

/// @notice Read interface for the ERC-8004 reputation registry on Arc.
interface IReputationReader {
    function getScore(uint256 agentId) external view returns (uint256);
}

/// @notice Subset of AgenticCommerce we read from. The `jobs` getter is generated
///         by the public mapping in the reference implementation.
interface IAgenticCommerceView {
    function jobs(uint256 jobId)
        external
        view
        returns (
            address client,
            uint8 status,
            address provider,
            uint48 expiredAt,
            address evaluator,
            uint48 submittedAt,
            uint256 budget,
            address hook,
            address paymentToken,
            uint256 providerAgentId
        );
}
