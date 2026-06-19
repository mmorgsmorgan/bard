// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/BardJobHook.sol";
import "../src/vendor/ERC8183.sol";
import "../src/vendor/MockUSDC.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title BardJobHook tests
 * @notice End-to-end tests for the side-car hook design.
 *
 *  Client/Provider/Evaluator -> AgenticCommerce  (custody of agent earnings)
 *                                     │
 *                                     │ before/after hook callbacks
 *                                     ▼
 *                                BardJobHook  (custody of platform fee)
 *
 *  Roles:
 *      admin     — owns ERC8183, whitelists hook + USDC
 *      client    — funds the bounty
 *      provider  — agent doing the work
 *      evaluator — platform verifier (would be a Safe in prod)
 *      treasury  — fee recipient
 */
contract BardJobHookTest is Test {
    ERC8183     internal ac;
    BardJobHook internal hook;
    MockUSDC    internal usdc;

    address internal admin     = makeAddr("admin");
    address internal client    = makeAddr("client");
    address internal provider  = makeAddr("provider");
    address internal evaluator = makeAddr("evaluator");
    address internal treasury  = makeAddr("treasury");
    address internal stranger  = makeAddr("stranger");

    uint128 internal constant AGENT_EARNINGS = 100e6;  // 100 USDC
    uint128 internal constant PLATFORM_FEE   = 20e6;   // 20 USDC (~16.67% of total)
    uint128 internal constant TOTAL          = AGENT_EARNINGS + PLATFORM_FEE;
    uint16  internal constant MAX_BPS        = 2500;   // 25% cap
    uint48  internal constant EXPIRY_72H     = 72 * 60 * 60;

    function setUp() public {
        usdc = new MockUSDC();

        // Deploy ERC-8183 behind an ERC-1967 proxy (it's upgradeable).
        ERC8183 impl = new ERC8183();
        bytes memory initCall = abi.encodeWithSelector(
            ERC8183.initialize.selector,
            treasury,
            admin
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initCall);
        ac = ERC8183(address(proxy));

        // Deploy the hook (test contract is owner).
        hook = new BardJobHook(address(ac), address(usdc), address(0));

        // Admin: allow USDC + whitelist the hook.
        vm.startPrank(admin);
        ac.setPaymentTokenAllowed(address(usdc), true);
        ac.setHookWhitelist(address(hook), true);
        vm.stopPrank();

        usdc.mint(client, 1_000e6);
    }

    // ──────────────────────────────────────────────
    //  Helpers
    // ──────────────────────────────────────────────

    /// @dev Creates a job, configures BARD policy, deposits the fee, and funds
    ///      the standard escrow. Returns the new job id in Funded state.
    function _createAndFund(address pProvider) internal returns (uint256 jobId) {
        // 1. Client creates the job directly on AgenticCommerce, with the hook attached.
        vm.prank(client);
        jobId = ac.createJob(
            pProvider,
            evaluator,
            uint48(block.timestamp + EXPIRY_72H),
            "test bounty",
            address(hook),
            0                         // providerAgentId — set later via setProvider if first-come
        );

        // 2. Client configures BARD policy on the hook.
        vm.prank(client);
        hook.configureBardJob(jobId, PLATFORM_FEE, treasury, MAX_BPS, 0);

        // 3. First-come: client assigns provider.
        if (pProvider == address(0)) {
            vm.prank(client);
            ac.setProvider(jobId, provider, 0);
        }

        // 4. Provider sets budget on the standard.
        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), AGENT_EARNINGS, "");

        // 5. Client deposits platform fee on the hook, then funds standard escrow.
        vm.startPrank(client);
        usdc.approve(address(hook), PLATFORM_FEE);
        hook.depositFee(jobId);
        usdc.approve(address(ac), AGENT_EARNINGS);
        ac.fund(jobId, AGENT_EARNINGS, "");
        vm.stopPrank();
    }

    // ──────────────────────────────────────────────
    //  Happy path
    // ──────────────────────────────────────────────

    function test_HappyPath_FirstCome_PaysAgentAndTreasury() public {
        uint256 jobId = _createAndFund(address(0));

        vm.prank(provider);
        ac.submit(jobId, keccak256("deliverable"), "");

        uint256 providerBefore = usdc.balanceOf(provider);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(evaluator);
        ac.complete(jobId, keccak256("approved"), "");

        assertEq(usdc.balanceOf(provider) - providerBefore, AGENT_EARNINGS, "provider paid");
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, PLATFORM_FEE,   "treasury paid");

        assertEq(usdc.balanceOf(address(hook)), 0, "hook drained");
        assertEq(usdc.balanceOf(address(ac)),   0, "ac drained");

        BardJobHook.FeeMeta memory fm = hook.getFeeMeta(jobId);
        assertTrue(fm.feeSettled, "fee settled flag");
    }

    function test_HappyPath_ProposalMode_PaysAgentAndTreasury() public {
        uint256 jobId = _createAndFund(provider);  // provider pre-bound at createJob

        vm.prank(provider);
        ac.submit(jobId, keccak256("deliverable"), "");

        vm.prank(evaluator);
        ac.complete(jobId, keccak256("approved"), "");

        assertEq(usdc.balanceOf(provider), AGENT_EARNINGS);
        assertEq(usdc.balanceOf(treasury), PLATFORM_FEE);
        assertEq(usdc.balanceOf(address(hook)), 0);
    }

    // ──────────────────────────────────────────────
    //  Reject
    // ──────────────────────────────────────────────

    function test_Reject_RefundsClientFully() public {
        uint256 jobId = _createAndFund(address(0));

        vm.prank(provider);
        ac.submit(jobId, keccak256("deliverable"), "");

        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(evaluator);
        ac.reject(jobId, keccak256("nope"), "");

        // Standard refunded agent leg via _afterHook-free path (reject loop in core),
        // hook afterAction refunded the platform fee.
        assertEq(usdc.balanceOf(client) - clientBefore, TOTAL, "full refund");
        assertEq(usdc.balanceOf(provider), 0);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(address(hook)), 0);
        assertEq(usdc.balanceOf(address(ac)),   0);
    }

    // ──────────────────────────────────────────────
    //  Expiry — critical safety property
    // ──────────────────────────────────────────────

    function test_Expiry_PermissionlessRefundsBothLegs() public {
        uint256 jobId = _createAndFund(address(0));

        // Time travel past expiry while still in Funded state.
        vm.warp(block.timestamp + EXPIRY_72H + 1);

        // Step 1: anyone can claim the agent-earnings leg via the standard.
        uint256 clientBefore = usdc.balanceOf(client);
        vm.prank(stranger);
        ac.claimRefund(jobId);
        assertEq(usdc.balanceOf(client) - clientBefore, AGENT_EARNINGS, "agent leg refunded");

        // claimRefund isn't hookable, so the fee is still parked here.
        assertEq(usdc.balanceOf(address(hook)), PLATFORM_FEE, "fee still in hook");

        // Step 2: anyone can sweep the fee leg via the hook.
        clientBefore = usdc.balanceOf(client);
        vm.prank(stranger);
        hook.refundFee(jobId);
        assertEq(usdc.balanceOf(client) - clientBefore, PLATFORM_FEE, "fee refunded");
        assertEq(usdc.balanceOf(address(hook)), 0, "hook drained");
    }

    function test_Expiry_SubmittedThenExpired_RefundsBothAfterGrace() public {
        uint256 jobId = _createAndFund(address(0));

        vm.prank(provider);
        ac.submit(jobId, keccak256("deliverable"), "");

        // Past expiry but inside grace period — claimRefund should revert.
        vm.warp(block.timestamp + EXPIRY_72H + 1);
        vm.prank(stranger);
        vm.expectRevert(ERC8183.GracePeriodActive.selector);
        ac.claimRefund(jobId);

        // After grace, anyone can sweep both legs.
        vm.warp(block.timestamp + 1 hours + 1);
        vm.prank(stranger);
        ac.claimRefund(jobId);
        vm.prank(stranger);
        hook.refundFee(jobId);

        assertEq(usdc.balanceOf(client), 1_000e6, "client made whole");
    }

    // ──────────────────────────────────────────────
    //  Fee cap enforcement
    // ──────────────────────────────────────────────

    function test_RevertWhen_FeeExceedsConsentedCap() public {
        // 50 USDC fee on a 100 USDC budget → 33% of total. Cap at 10% should reject.
        vm.prank(client);
        uint256 jobId = ac.createJob(
            address(0),
            evaluator,
            uint48(block.timestamp + EXPIRY_72H),
            "capped",
            address(hook),
            0
        );

        vm.prank(client);
        hook.configureBardJob(jobId, 50e6, treasury, 1000, 0);  // 10% cap

        vm.prank(client);
        ac.setProvider(jobId, provider, 0);

        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), 100e6, "");

        vm.startPrank(client);
        usdc.approve(address(hook), 50e6);
        vm.expectRevert();  // FeeExceedsCap(3333, 1000)
        hook.depositFee(jobId);
        vm.stopPrank();
    }

    // ──────────────────────────────────────────────
    //  Authorization
    // ──────────────────────────────────────────────

    function test_RevertWhen_HookCallbacksCalledByStranger() public {
        vm.expectRevert(BardJobHook.NotAgenticCommerce.selector);
        vm.prank(stranger);
        hook.beforeAction(1, bytes4(0), "");

        vm.expectRevert(BardJobHook.NotAgenticCommerce.selector);
        vm.prank(stranger);
        hook.afterAction(1, bytes4(0), "");
    }

    function test_RevertWhen_NonClientCallsConfigure() public {
        vm.prank(client);
        uint256 jobId = ac.createJob(
            provider,
            evaluator,
            uint48(block.timestamp + EXPIRY_72H),
            "t",
            address(hook),
            0
        );

        vm.prank(stranger);
        vm.expectRevert(BardJobHook.NotClient.selector);
        hook.configureBardJob(jobId, PLATFORM_FEE, treasury, MAX_BPS, 0);
    }

    function test_RevertWhen_NonClientCallsDepositFee() public {
        vm.prank(client);
        uint256 jobId = ac.createJob(
            provider,
            evaluator,
            uint48(block.timestamp + EXPIRY_72H),
            "t",
            address(hook),
            0
        );
        vm.prank(client);
        hook.configureBardJob(jobId, PLATFORM_FEE, treasury, MAX_BPS, 0);
        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), AGENT_EARNINGS, "");

        vm.prank(stranger);
        vm.expectRevert(BardJobHook.NotClient.selector);
        hook.depositFee(jobId);
    }

    function test_RevertWhen_FundBeforeFeeDeposited() public {
        // Job is configured with a non-zero fee but the client tries to fund
        // the standard escrow before depositing the fee on the hook.
        vm.prank(client);
        uint256 jobId = ac.createJob(
            provider,
            evaluator,
            uint48(block.timestamp + EXPIRY_72H),
            "t",
            address(hook),
            0
        );
        vm.prank(client);
        hook.configureBardJob(jobId, PLATFORM_FEE, treasury, MAX_BPS, 0);
        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), AGENT_EARNINGS, "");

        vm.startPrank(client);
        usdc.approve(address(ac), AGENT_EARNINGS);
        vm.expectRevert(BardJobHook.FeeNotDeposited.selector);
        ac.fund(jobId, AGENT_EARNINGS, "");
        vm.stopPrank();
    }

    function test_RevertWhen_RefundFeeBeforeRefundState() public {
        uint256 jobId = _createAndFund(address(0));
        // Job is Funded — not a refund state.
        vm.prank(stranger);
        vm.expectRevert(BardJobHook.JobNotInRefundState.selector);
        hook.refundFee(jobId);
    }

    function test_RevertWhen_DoubleConfigure() public {
        vm.prank(client);
        uint256 jobId = ac.createJob(
            provider,
            evaluator,
            uint48(block.timestamp + EXPIRY_72H),
            "t",
            address(hook),
            0
        );
        vm.prank(client);
        hook.configureBardJob(jobId, PLATFORM_FEE, treasury, MAX_BPS, 0);

        vm.prank(client);
        vm.expectRevert(BardJobHook.AlreadyConfigured.selector);
        hook.configureBardJob(jobId, PLATFORM_FEE, treasury, MAX_BPS, 0);
    }

    function test_RevertWhen_DoubleDeposit() public {
        uint256 jobId = _createAndFund(address(0));
        vm.startPrank(client);
        usdc.approve(address(hook), PLATFORM_FEE);
        vm.expectRevert(BardJobHook.AlreadyDeposited.selector);
        hook.depositFee(jobId);
        vm.stopPrank();
    }

    // ──────────────────────────────────────────────
    //  Min-reputation gate (mocked reader)
    // ──────────────────────────────────────────────

    function test_MinReputation_BlocksUnderqualifiedAgent() public {
        MockReputationReader reader = new MockReputationReader(5);
        hook.setReputationReader(address(reader));  // test contract is owner

        vm.prank(client);
        uint256 jobId = ac.createJob(
            address(0),
            evaluator,
            uint48(block.timestamp + EXPIRY_72H),
            "rep-gated",
            address(hook),
            0
        );

        vm.prank(client);
        hook.configureBardJob(jobId, PLATFORM_FEE, treasury, MAX_BPS, 50);  // require score >= 50

        // setProvider stores agentId on the job; min-rep is enforced at setBudget time.
        vm.prank(client);
        ac.setProvider(jobId, provider, 99);  // agent id 99, reader says score 5

        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(BardJobHook.ReputationTooLow.selector, 5, 50));
        ac.setBudget(jobId, address(usdc), AGENT_EARNINGS, "");
    }

    function test_MinReputation_PassesQualifiedAgent() public {
        MockReputationReader reader = new MockReputationReader(75);
        hook.setReputationReader(address(reader));

        vm.prank(client);
        uint256 jobId = ac.createJob(
            address(0),
            evaluator,
            uint48(block.timestamp + EXPIRY_72H),
            "rep-gated",
            address(hook),
            0
        );
        vm.prank(client);
        hook.configureBardJob(jobId, PLATFORM_FEE, treasury, MAX_BPS, 50);

        vm.prank(client);
        ac.setProvider(jobId, provider, 99);

        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), AGENT_EARNINGS, "");

        ERC8183.Job memory job = ac.getJob(jobId);
        assertEq(job.provider, provider);
        assertEq(job.budget, AGENT_EARNINGS);
    }

    // ──────────────────────────────────────────────
    //  Zero-fee jobs (human, non-swarm)
    // ──────────────────────────────────────────────

    function test_ZeroFee_NonSwarmBounty_PaysAgentOnly() public {
        // Client doesn't bother configuring the hook — zero-fee jobs skip it
        // entirely. The hook's beforeAction(fund) check is gated on `configured`.
        vm.prank(client);
        uint256 jobId = ac.createJob(
            provider,
            evaluator,
            uint48(block.timestamp + EXPIRY_72H),
            "human bounty",
            address(hook),
            0
        );

        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), AGENT_EARNINGS, "");

        vm.startPrank(client);
        usdc.approve(address(ac), AGENT_EARNINGS);
        ac.fund(jobId, AGENT_EARNINGS, "");
        vm.stopPrank();

        vm.prank(provider);
        ac.submit(jobId, keccak256("d"), "");

        vm.prank(evaluator);
        ac.complete(jobId, keccak256("ok"), "");

        assertEq(usdc.balanceOf(provider), AGENT_EARNINGS);
        assertEq(usdc.balanceOf(treasury), 0);
        assertEq(usdc.balanceOf(address(hook)), 0);
    }
}

/// @dev Trivial reputation reader stub for the min-rep gate tests.
contract MockReputationReader is IReputationReader {
    uint256 public fixedScore;
    constructor(uint256 score) { fixedScore = score; }
    function getScore(uint256) external view returns (uint256) { return fixedScore; }
}
