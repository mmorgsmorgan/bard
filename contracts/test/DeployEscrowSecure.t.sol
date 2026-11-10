// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {DeployBardEscrowSecure} from "../script/DeployEscrowSecure.s.sol";
import {ERC8183} from "../src/vendor/ERC8183.sol";
import {BardJobHookV2} from "../src/BardJobHookV2.sol";
import {MockUSDC} from "../src/vendor/MockUSDC.sol";

contract DeploymentHarness is DeployBardEscrowSecure {
    function deploy(address admin, address token) external returns (ERC8183, BardJobHookV2, address) {
        return _run(token, admin, address(0));
    }
}

contract DeployEscrowSecureTest is Test {
    MockUSDC internal token;

    function setUp() public {
        token = new MockUSDC();
    }

    function test_DistinctBootstrapLosesAllRoles() public {
        address admin = makeAddr("final-admin");
        (ERC8183 commerce, BardJobHookV2 hook, address deployer) = new DeploymentHarness().deploy(admin, address(token));
        assertTrue(commerce.hasRole(commerce.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(commerce.hasRole(commerce.ADMIN_ROLE(), admin));
        assertFalse(commerce.hasRole(commerce.DEFAULT_ADMIN_ROLE(), deployer));
        assertFalse(commerce.hasRole(commerce.ADMIN_ROLE(), deployer));
        assertEq(hook.owner(), admin);
        assertEq(commerce.platformTreasury(), admin);
        assertTrue(commerce.whitelistedHooks(address(hook)));
    }

    function test_SameDeployerAndAdminRetainsAuthority() public {
        (,, address broadcastSigner) = new DeploymentHarness().deploy(makeAddr("probe-admin"), address(token));
        (ERC8183 commerce, BardJobHookV2 hook, address deployer) = new DeploymentHarness().deploy(broadcastSigner, address(token));
        assertEq(deployer, broadcastSigner);
        assertTrue(commerce.hasRole(commerce.DEFAULT_ADMIN_ROLE(), broadcastSigner));
        assertTrue(commerce.hasRole(commerce.ADMIN_ROLE(), broadcastSigner));
        assertEq(hook.owner(), broadcastSigner);
    }

    function test_ZeroAdminIsRejected() public {
        DeploymentHarness script = new DeploymentHarness();
        vm.expectRevert("SECURE_ADMIN required");
        script.deploy(address(0), address(token));
    }

    function test_KnownCompromisedAdminIsRejected() public {
        DeploymentHarness script = new DeploymentHarness();
        vm.expectRevert("Compromised test admin prohibited");
        script.deploy(0xA1a16e5eE45A999845eF6c7CF99b16666b2Ba3c8, address(token));
    }
}
