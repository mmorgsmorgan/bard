// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/BardJobHookV2.sol";
import "../src/vendor/ERC8183.sol";
import "../src/vendor/MockUSDC.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title BardJobHookV2 tests — audit fixes M-1, M-2, L-1
 * @notice Regression of the happy path plus targeted coverage of the three fixes.
 */
contract BardJobHookV2Test is Test {
    ERC8183       internal ac;
    BardJobHookV2 internal hook;
    MockUSDC      internal usdc;

    address internal admin     = makeAddr("admin");
    address internal secure    = makeAddr("secureAdmin");
    address internal client    = makeAddr("client");
    address internal provider  = makeAddr("provider");
    address internal evaluator = makeAddr("evaluator");
    address internal treasury  = makeAddr("treasury");

    uint128 internal constant AGENT_EARNINGS = 100e6;  // 100 USDC
    uint128 internal constant PLATFORM_FEE   = 20e6;   // 20 USDC (~16.67% of 120 total)
    uint16  internal constant MAX_BPS        = 2500;   // 25% cap
    uint48  internal constant EXPIRY_72H     = 72 * 60 * 60;

    function setUp() public {
        usdc = new MockUSDC();

        ERC8183 impl = new ERC8183();
        bytes memory initCall = abi.encodeWithSelector(ERC8183.initialize.selector, treasury, admin);
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initCall);
        ac = ERC8183(address(proxy));

        // Owner set explicitly to `secure` via the new constructor arg.
        hook = new BardJobHookV2(address(ac), address(usdc), address(0), secure);

        vm.startPrank(admin);
        ac.setPaymentTokenAllowed(address(usdc), true);
        ac.setHookWhitelist(address(hook), true);
        vm.stopPrank();

        usdc.mint(client, 1_000e6);
    }

    // ── helpers ──────────────────────────────────────

    function _create(address pEvaluator) internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = ac.createJob(provider, pEvaluator, uint48(block.timestamp + EXPIRY_72H), "job", address(hook), 0);
        vm.prank(client);
        hook.configureBardJob(jobId, PLATFORM_FEE, treasury, MAX_BPS, 0);
        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), AGENT_EARNINGS, "");
    }

    function _createAndFund() internal returns (uint256 jobId) {
        jobId = _create(evaluator);
        vm.startPrank(client);
        usdc.approve(address(hook), PLATFORM_FEE);
        hook.depositFee(jobId);
        usdc.approve(address(ac), AGENT_EARNINGS);
        ac.fund(jobId, AGENT_EARNINGS, "");
        vm.stopPrank();
    }

    // ── constructor / ownership ──────────────────────

    function test_Constructor_SetsExplicitOwner() public view {
        assertEq(hook.owner(), secure);
    }

    function test_Constructor_ZeroOwnerFallsBackToSender() public {
        BardJobHookV2 h = new BardJobHookV2(address(ac), address(usdc), address(0), address(0));
        assertEq(h.owner(), address(this));
    }

    // ── regression: happy path still pays agent + treasury ──

    function test_HappyPath_PaysAgentAndTreasury() public {
        uint256 jobId = _createAndFund();
        vm.prank(provider);
        ac.submit(jobId, keccak256("deliverable"), "");
        vm.prank(evaluator);
        ac.complete(jobId, "ok", "");

        assertEq(usdc.balanceOf(provider), AGENT_EARNINGS);
        assertEq(usdc.balanceOf(treasury), PLATFORM_FEE);
        assertTrue(hook.getFeeMeta(jobId).feeSettled);
    }

    // ── L-1: client cannot also be the evaluator ─────

    function test_RevertWhen_ClientIsEvaluator_AtFund() public {
        uint256 jobId = _create(client); // evaluator == client
        vm.startPrank(client);
        usdc.approve(address(hook), PLATFORM_FEE);
        hook.depositFee(jobId);
        usdc.approve(address(ac), AGENT_EARNINGS);
        vm.expectRevert(BardJobHookV2.ClientCannotBeEvaluator.selector);
        ac.fund(jobId, AGENT_EARNINGS, "");
        vm.stopPrank();
    }

    // ── M-1: fee cap re-checked at fund, not just deposit ──

    function test_RevertWhen_ProviderLowersBudgetBelowCap_AtFund() public {
        // Deposit passes the cap at budget=100 (20/120 = 16.6% < 25%).
        uint256 jobId = _create(evaluator);
        vm.startPrank(client);
        usdc.approve(address(hook), PLATFORM_FEE);
        hook.depositFee(jobId);
        vm.stopPrank();

        // Provider lowers budget to 40 (still Open): 20/60 = 33.3% > 25% cap.
        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), 40e6, "");

        vm.startPrank(client);
        usdc.approve(address(ac), 40e6);
        vm.expectRevert(abi.encodeWithSelector(BardJobHookV2.FeeExceedsCap.selector, uint16(3333), MAX_BPS));
        ac.fund(jobId, 40e6, "");
        vm.stopPrank();
    }

    function test_FundSucceeds_WhenBudgetStillWithinCap() public {
        // Provider raises budget after deposit: 20/140 = 14.3% < 25%, fund OK.
        uint256 jobId = _create(evaluator);
        vm.startPrank(client);
        usdc.approve(address(hook), PLATFORM_FEE);
        hook.depositFee(jobId);
        vm.stopPrank();

        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), 120e6, "");

        vm.startPrank(client);
        usdc.approve(address(ac), 120e6);
        ac.fund(jobId, 120e6, "");
        vm.stopPrank();
        assertEq(uint8(_status(jobId)), 1); // Funded
    }

    function test_ZeroCap_SkipsFundReCheck() public {
        // maxFeeBps == 0 disables the cap entirely.
        vm.prank(client);
        uint256 jobId = ac.createJob(provider, evaluator, uint48(block.timestamp + EXPIRY_72H), "j", address(hook), 0);
        vm.prank(client);
        hook.configureBardJob(jobId, PLATFORM_FEE, treasury, 0, 0); // maxFeeBps=0
        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), 1e6, ""); // tiny budget, huge fee ratio
        vm.startPrank(client);
        usdc.approve(address(hook), PLATFORM_FEE);
        hook.depositFee(jobId);
        usdc.approve(address(ac), 1e6);
        ac.fund(jobId, 1e6, ""); // no revert
        vm.stopPrank();
        assertEq(uint8(_status(jobId)), 1);
    }

    // ── M-2: settleFee recovers a fee stranded by hook detachment ──

    function test_SettleFee_RecoversStrandedFeeAfterDetach() public {
        uint256 jobId = _createAndFund();
        vm.prank(provider);
        ac.submit(jobId, keccak256("d"), "");

        // Admin detaches the hook BEFORE completion → afterAction won't fire.
        uint256[] memory ids = new uint256[](1);
        ids[0] = jobId;
        vm.prank(admin);
        ac.batchDetachHook(ids);

        // Evaluator completes: agent paid by core, but fee stuck in the hook.
        vm.prank(evaluator);
        ac.complete(jobId, "ok", "");
        assertEq(usdc.balanceOf(provider), AGENT_EARNINGS);
        assertEq(usdc.balanceOf(treasury), 0);                 // fee NOT yet delivered
        assertFalse(hook.getFeeMeta(jobId).feeSettled);
        assertEq(usdc.balanceOf(address(hook)), PLATFORM_FEE); // stranded

        // Anyone can recover it to the intended recipient.
        hook.settleFee(jobId);
        assertEq(usdc.balanceOf(treasury), PLATFORM_FEE);
        assertTrue(hook.getFeeMeta(jobId).feeSettled);
        assertEq(usdc.balanceOf(address(hook)), 0);
    }

    function test_RevertWhen_SettleFee_JobNotCompleted() public {
        uint256 jobId = _createAndFund(); // Funded, not Completed
        vm.expectRevert(BardJobHookV2.JobNotSettleable.selector);
        hook.settleFee(jobId);
    }

    function test_RevertWhen_SettleFee_FeeNotDeposited() public {
        uint256 jobId = _create(evaluator); // configured but not deposited
        vm.expectRevert(BardJobHookV2.FeeNotDeposited.selector);
        hook.settleFee(jobId);
    }

    function test_RevertWhen_SettleFee_AlreadySettledByNormalComplete() public {
        uint256 jobId = _createAndFund();
        vm.prank(provider);
        ac.submit(jobId, keccak256("d"), "");
        vm.prank(evaluator);
        ac.complete(jobId, "ok", ""); // afterAction settles fee normally
        assertEq(usdc.balanceOf(treasury), PLATFORM_FEE);
        vm.expectRevert(BardJobHookV2.AlreadySettled.selector);
        hook.settleFee(jobId);
    }

    // ── regression: reject + expiry refund fee paths ──

    function test_Reject_RefundsFeeToClient() public {
        uint256 jobId = _createAndFund();
        vm.prank(provider);
        ac.submit(jobId, keccak256("d"), "");
        uint256 before = usdc.balanceOf(client);
        vm.prank(evaluator);
        ac.reject(jobId, "bad", "");
        // core refunds earnings, hook afterAction refunds fee → client whole again.
        assertEq(usdc.balanceOf(client), before + AGENT_EARNINGS + PLATFORM_FEE);
        assertEq(usdc.balanceOf(provider), 0);
    }

    function test_ExpiryRefund_ReturnsFeeViaRefundFee() public {
        uint256 jobId = _createAndFund();
        vm.warp(block.timestamp + EXPIRY_72H + 1);
        ac.claimRefund(jobId);          // core → Expired, earnings back to client
        uint256 before = usdc.balanceOf(client);
        hook.refundFee(jobId);          // hook → fee back to client
        assertEq(usdc.balanceOf(client), before + PLATFORM_FEE);
    }

    // ── util ─────────────────────────────────────────
    function _status(uint256 jobId) internal view returns (ERC8183.JobStatus s) {
        (,,,,, s) = _unpackStatus(jobId);
    }

    function _unpackStatus(uint256 jobId)
        internal view
        returns (address, address, address, uint48, uint48, ERC8183.JobStatus)
    {
        ERC8183.Job memory j = ac.getJob(jobId);
        return (j.client, j.provider, j.evaluator, j.expiredAt, j.submittedAt, j.status);
    }
}
