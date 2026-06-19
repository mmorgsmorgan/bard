// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/BardJobHook.sol";
import "../src/vendor/ERC8183.sol";
import "../src/vendor/MockUSDC.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "../src/vendor/IERC8183Hook.sol";

/**
 * @title BardJobHookEdgeCases
 * @notice Unit tests for constructor invariants, admin paths, refund-state
 *         branches, supportsInterface, and selector no-ops — the bits the
 *         end-to-end suite doesn't directly cover.
 */
contract BardJobHookEdgeCases is Test {
    ERC8183     internal ac;
    BardJobHook internal hook;
    MockUSDC    internal usdc;

    address internal admin     = makeAddr("admin");
    address internal client    = makeAddr("client");
    address internal provider  = makeAddr("provider");
    address internal evaluator = makeAddr("evaluator");
    address internal treasury  = makeAddr("treasury");
    address internal stranger  = makeAddr("stranger");

    uint128 internal constant AGENT_EARNINGS = 100e6;
    uint128 internal constant PLATFORM_FEE   = 20e6;
    uint48  internal constant EXPIRY_72H     = 72 * 60 * 60;

    function setUp() public {
        usdc = new MockUSDC();
        ERC8183 impl = new ERC8183();
        bytes memory initCall = abi.encodeWithSelector(
            ERC8183.initialize.selector,
            treasury,
            admin
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initCall);
        ac = ERC8183(address(proxy));
        hook = new BardJobHook(address(ac), address(usdc), address(0));

        vm.startPrank(admin);
        ac.setPaymentTokenAllowed(address(usdc), true);
        ac.setHookWhitelist(address(hook), true);
        vm.stopPrank();

        usdc.mint(client, 1_000e6);
    }

    // ──────────────────────────────────────────────
    //  Constructor invariants
    // ──────────────────────────────────────────────

    function test_Constructor_RevertWhen_ZeroAgenticCommerce() public {
        vm.expectRevert(BardJobHook.InvalidAddress.selector);
        new BardJobHook(address(0), address(usdc), address(0));
    }

    function test_Constructor_RevertWhen_ZeroPaymentToken() public {
        vm.expectRevert(BardJobHook.InvalidAddress.selector);
        new BardJobHook(address(ac), address(0), address(0));
    }

    function test_Constructor_SetsOwnerToDeployer() public {
        BardJobHook fresh = new BardJobHook(address(ac), address(usdc), address(0));
        assertEq(fresh.owner(), address(this), "owner is deployer");
    }

    function test_Constructor_AcceptsZeroReputationReader() public {
        BardJobHook fresh = new BardJobHook(address(ac), address(usdc), address(0));
        assertEq(address(fresh.reputationReader()), address(0));
    }

    // ──────────────────────────────────────────────
    //  configureBardJob edge cases
    // ──────────────────────────────────────────────

    function test_RevertWhen_ConfigureWithFeeButZeroRecipient() public {
        vm.prank(client);
        uint256 jobId = ac.createJob(
            provider, evaluator, uint48(block.timestamp + EXPIRY_72H),
            "t", address(hook), 0
        );
        vm.prank(client);
        vm.expectRevert(BardJobHook.InvalidAddress.selector);
        hook.configureBardJob(jobId, PLATFORM_FEE, address(0), 2500, 0);
    }

    function test_ConfigureWithZeroFee_AllowsZeroRecipient() public {
        vm.prank(client);
        uint256 jobId = ac.createJob(
            provider, evaluator, uint48(block.timestamp + EXPIRY_72H),
            "t", address(hook), 0
        );
        vm.prank(client);
        hook.configureBardJob(jobId, 0, address(0), 0, 0);

        BardJobHook.FeeMeta memory fm = hook.getFeeMeta(jobId);
        assertTrue(fm.configured);
        assertEq(fm.platformFee, 0);
    }

    function test_ConfigureOnNonexistentJob_RevertsNotClient() public {
        // No job 42 exists; _readClient returns address(0); msg.sender != 0 → NotClient.
        vm.prank(client);
        vm.expectRevert(BardJobHook.NotClient.selector);
        hook.configureBardJob(42, PLATFORM_FEE, treasury, 2500, 0);
    }

    // ──────────────────────────────────────────────
    //  depositFee edge cases
    // ──────────────────────────────────────────────

    function test_RevertWhen_DepositBeforeConfigure() public {
        vm.prank(client);
        uint256 jobId = ac.createJob(
            provider, evaluator, uint48(block.timestamp + EXPIRY_72H),
            "t", address(hook), 0
        );
        vm.prank(client);
        vm.expectRevert(BardJobHook.NotConfigured.selector);
        hook.depositFee(jobId);
    }

    function test_DepositFee_ZeroFee_NoTokenMovement() public {
        vm.prank(client);
        uint256 jobId = ac.createJob(
            provider, evaluator, uint48(block.timestamp + EXPIRY_72H),
            "t", address(hook), 0
        );
        vm.prank(client);
        hook.configureBardJob(jobId, 0, address(0), 0, 0);

        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), AGENT_EARNINGS, "");

        uint256 hookBefore = usdc.balanceOf(address(hook));
        vm.prank(client);
        hook.depositFee(jobId);
        assertEq(usdc.balanceOf(address(hook)), hookBefore, "no transfer for zero fee");

        BardJobHook.FeeMeta memory fm = hook.getFeeMeta(jobId);
        assertTrue(fm.feeDeposited);
    }

    function test_DepositFee_ZeroCap_SkipsCapCheck() public {
        // maxFeeBps = 0 means "no cap configured" — accept any fee.
        vm.prank(client);
        uint256 jobId = ac.createJob(
            provider, evaluator, uint48(block.timestamp + EXPIRY_72H),
            "t", address(hook), 0
        );
        vm.prank(client);
        hook.configureBardJob(jobId, 90e6, treasury, 0, 0);  // 90% would be insane, but no cap

        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), AGENT_EARNINGS, "");

        vm.startPrank(client);
        usdc.approve(address(hook), 90e6);
        hook.depositFee(jobId);  // does not revert
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(hook)), 90e6);
    }

    // ──────────────────────────────────────────────
    //  refundFee branches
    // ──────────────────────────────────────────────

    function test_RevertWhen_RefundFeeBeforeDeposit() public {
        vm.prank(client);
        uint256 jobId = ac.createJob(
            provider, evaluator, uint48(block.timestamp + EXPIRY_72H),
            "t", address(hook), 0
        );
        vm.prank(client);
        hook.configureBardJob(jobId, PLATFORM_FEE, treasury, 2500, 0);

        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), AGENT_EARNINGS, "");

        // Configured but not deposited.
        vm.expectRevert(BardJobHook.FeeNotDeposited.selector);
        hook.refundFee(jobId);
    }

    function test_RevertWhen_RefundFeeOnCompletedJob() public {
        uint256 jobId = _createAndFund();

        vm.prank(provider);
        ac.submit(jobId, keccak256("d"), "");
        vm.prank(evaluator);
        ac.complete(jobId, keccak256("ok"), "");

        // afterAction(complete) already settled the fee.
        vm.expectRevert(BardJobHook.AlreadySettled.selector);
        hook.refundFee(jobId);
    }

    function test_RevertWhen_RefundFeeTwiceAfterExpiry() public {
        uint256 jobId = _createAndFund();
        vm.warp(block.timestamp + EXPIRY_72H + 1);
        ac.claimRefund(jobId);

        hook.refundFee(jobId);
        vm.expectRevert(BardJobHook.AlreadySettled.selector);
        hook.refundFee(jobId);
    }

    function test_RefundFee_RejectedPath_FiresWhenHookDetached() public {
        // Cover the Rejected branch of refundFee: realistic when admin has
        // detached the hook between depositFee and reject, so afterAction
        // never fires and the safety-net has to recover the fee.
        uint256 jobId = _createAndFund();

        // Admin detaches the hook from this job.
        uint256[] memory ids = new uint256[](1);
        ids[0] = jobId;
        vm.prank(admin);
        ac.batchDetachHook(ids);

        // Reject now skips _afterHook because job.hook == address(0).
        vm.prank(evaluator);
        ac.reject(jobId, keccak256("nope"), "");

        // Fee is still parked here.
        assertEq(usdc.balanceOf(address(hook)), PLATFORM_FEE);

        // Permissionless sweep via the Rejected branch.
        uint256 clientBefore = usdc.balanceOf(client);
        vm.expectEmit(true, true, false, true, address(hook));
        emit BardJobHook.BardFeeRefunded(jobId, client, PLATFORM_FEE, BardJobHook.RefundCause.Rejected);
        hook.refundFee(jobId);

        assertEq(usdc.balanceOf(client) - clientBefore, PLATFORM_FEE);
        assertEq(usdc.balanceOf(address(hook)), 0);
    }

    function test_RefundFee_AfterReject_AlreadySettledByHook() public {
        uint256 jobId = _createAndFund();
        vm.prank(provider);
        ac.submit(jobId, keccak256("d"), "");
        vm.prank(evaluator);
        ac.reject(jobId, keccak256("no"), "");

        // afterAction(reject) already refunded — calling refundFee again must revert.
        vm.expectRevert(BardJobHook.AlreadySettled.selector);
        hook.refundFee(jobId);
    }

    // ──────────────────────────────────────────────
    //  Hook callback no-op selectors
    // ──────────────────────────────────────────────

    function test_BeforeAction_UnhandledSelector_IsNoOp() public {
        // submit's beforeAction is intentionally a no-op in our hook.
        // We exercise it by submitting on a real funded job and asserting state.
        uint256 jobId = _createAndFund();
        vm.prank(provider);
        ac.submit(jobId, keccak256("d"), "");

        ERC8183.Job memory job = ac.getJob(jobId);
        assertEq(uint8(job.status), 2, "submitted");  // JobStatus.Submitted
    }

    function test_AfterAction_UnhandledSelector_IsNoOp() public {
        // setBudget / fund / submit afterAction is a no-op — covered by happy path
        // not exploding. Here we sanity-check feeMeta is untouched after submit.
        uint256 jobId = _createAndFund();
        BardJobHook.FeeMeta memory before_ = hook.getFeeMeta(jobId);

        vm.prank(provider);
        ac.submit(jobId, keccak256("d"), "");

        BardJobHook.FeeMeta memory after_ = hook.getFeeMeta(jobId);
        assertEq(after_.platformFee, before_.platformFee);
        assertEq(after_.feeSettled, before_.feeSettled);
    }

    // ──────────────────────────────────────────────
    //  Admin
    // ──────────────────────────────────────────────

    function test_RevertWhen_NonOwnerSetsReputationReader() public {
        vm.prank(stranger);
        vm.expectRevert(BardJobHook.NotOwner.selector);
        hook.setReputationReader(address(0xBEEF));
    }

    function test_TransferOwnership_NewOwnerCanSetReader() public {
        address newOwner = makeAddr("newOwner");

        hook.transferOwnership(newOwner);
        assertEq(hook.owner(), newOwner);

        // Old owner (this test contract) is locked out.
        vm.expectRevert(BardJobHook.NotOwner.selector);
        hook.setReputationReader(address(0xBEEF));

        // New owner can.
        vm.prank(newOwner);
        hook.setReputationReader(address(0xBEEF));
        assertEq(address(hook.reputationReader()), address(0xBEEF));
    }

    function test_RevertWhen_TransferOwnershipToZero() public {
        vm.expectRevert(BardJobHook.InvalidAddress.selector);
        hook.transferOwnership(address(0));
    }

    function test_RevertWhen_NonOwnerTransfersOwnership() public {
        vm.prank(stranger);
        vm.expectRevert(BardJobHook.NotOwner.selector);
        hook.transferOwnership(stranger);
    }

    // ──────────────────────────────────────────────
    //  ERC-165
    // ──────────────────────────────────────────────

    function test_SupportsInterface_IERC8183Hook() public view {
        assertTrue(hook.supportsInterface(type(IERC8183Hook).interfaceId));
    }

    function test_SupportsInterface_IERC165() public view {
        assertTrue(hook.supportsInterface(type(IERC165).interfaceId));
    }

    function test_SupportsInterface_Unknown() public view {
        assertFalse(hook.supportsInterface(0xdeadbeef));
    }

    // ──────────────────────────────────────────────
    //  Min-rep gate: short-circuits
    // ──────────────────────────────────────────────

    function test_MinRep_SkippedWhenReaderNotSet() public {
        // reader is address(0); even with minRepScore set, no revert.
        vm.prank(client);
        uint256 jobId = ac.createJob(
            address(0), evaluator, uint48(block.timestamp + EXPIRY_72H),
            "t", address(hook), 0
        );
        vm.prank(client);
        hook.configureBardJob(jobId, PLATFORM_FEE, treasury, 2500, 99);
        vm.prank(client);
        ac.setProvider(jobId, provider, 7);

        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), AGENT_EARNINGS, "");  // no revert
    }

    function test_MinRep_SkippedWhenAgentIdZero() public {
        // Reader is set, threshold high, but agent has no ERC-8004 id ⇒ skip gate.
        AlwaysHighReader reader = new AlwaysHighReader();
        hook.setReputationReader(address(reader));

        vm.prank(client);
        uint256 jobId = ac.createJob(
            provider, evaluator, uint48(block.timestamp + EXPIRY_72H),
            "t", address(hook), 0
        );
        vm.prank(client);
        hook.configureBardJob(jobId, PLATFORM_FEE, treasury, 2500, 50);

        // Provider was bound at createJob without an agentId — gate is skipped.
        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), AGENT_EARNINGS, "");
    }

    // ──────────────────────────────────────────────
    //  Fuzz: fee cap math
    // ──────────────────────────────────────────────

    /// @dev For any (earnings, fee, cap) the contract accepts the deposit iff
    ///      fee/(fee+earnings) ≤ cap/10000 (with integer floor on actualBps).
    function testFuzz_DepositFee_HonorsCap(
        uint96 earnings,
        uint96 fee,
        uint16 capBps
    ) public {
        // Bound to realistic ranges so we don't blow approvals or run out of mint.
        earnings = uint96(bound(uint256(earnings), 1, 1_000_000e6));
        fee      = uint96(bound(uint256(fee),       0, 1_000_000e6));
        capBps   = uint16(bound(uint256(capBps),   0, 10_000));

        // Give the client enough USDC.
        usdc.mint(client, uint256(fee));

        vm.prank(client);
        uint256 jobId = ac.createJob(
            provider, evaluator, uint48(block.timestamp + EXPIRY_72H),
            "fuzz", address(hook), 0
        );

        address recipient = fee == 0 ? address(0) : treasury;
        vm.prank(client);
        hook.configureBardJob(jobId, fee, recipient, capBps, 0);

        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), earnings, "");

        vm.startPrank(client);
        usdc.approve(address(hook), fee);

        uint256 total = uint256(fee) + uint256(earnings);
        uint256 actualBps = (uint256(fee) * 10_000) / total;
        bool shouldRevert = capBps > 0 && fee > 0 && actualBps > capBps;

        if (shouldRevert) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    BardJobHook.FeeExceedsCap.selector,
                    uint16(actualBps),
                    capBps
                )
            );
            hook.depositFee(jobId);
        } else {
            hook.depositFee(jobId);
            BardJobHook.FeeMeta memory fm = hook.getFeeMeta(jobId);
            assertTrue(fm.feeDeposited);
            assertEq(usdc.balanceOf(address(hook)), fee);
        }
        vm.stopPrank();
    }

    // ──────────────────────────────────────────────
    //  Helper
    // ──────────────────────────────────────────────

    function _createAndFund() internal returns (uint256 jobId) {
        vm.prank(client);
        jobId = ac.createJob(
            provider, evaluator, uint48(block.timestamp + EXPIRY_72H),
            "t", address(hook), 0
        );
        vm.prank(client);
        hook.configureBardJob(jobId, PLATFORM_FEE, treasury, 2500, 0);
        vm.prank(provider);
        ac.setBudget(jobId, address(usdc), AGENT_EARNINGS, "");
        vm.startPrank(client);
        usdc.approve(address(hook), PLATFORM_FEE);
        hook.depositFee(jobId);
        usdc.approve(address(ac), AGENT_EARNINGS);
        ac.fund(jobId, AGENT_EARNINGS, "");
        vm.stopPrank();
    }
}

/// @dev Reader stub returning a fixed high score (used in agentId-zero gate test).
contract AlwaysHighReader is IReputationReader {
    function getScore(uint256) external pure returns (uint256) {
        return 9999;
    }
}
