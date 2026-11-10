// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import {BardJobHookV2} from "../src/BardJobHookV2.sol";
import {ERC8183} from "../src/vendor/ERC8183.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * @title DeployBardEscrowSecure
 * @notice Fresh, securely-owned redeploy of the BARD escrow stack (audit fix C-1).
 *
 *  The previous deployment's ERC8183 admin + hook owner + treasury were all a test
 *  EOA whose private key is committed to the repo — total escrow compromise. This
 *  script deploys a NEW stock ERC-8183 proxy + BardJobHookV2 and leaves ALL authority
 *  with the configured secure wallet (`SECURE_ADMIN`). A different bootstrap
 *  deployer renounces its roles; if it is the final admin, its roles are retained.
 *
 *  A distinct bootstrap signer holds ADMIN_ROLE transiently for configuration,
 *  grants every role to SECURE_ADMIN and renounces its own. A signer that is itself
 *  SECURE_ADMIN retains both roles. Never use a published test key as SECURE_ADMIN.
 *
 *  Env vars:
 *    SECURE_ADMIN      — required; final admin/owner/treasury (e.g. platform Turnkey wallet or a Safe).
 *    PAYMENT_TOKEN     — optional; defaults to Arc testnet USDC.
 *    REPUTATION_READER — optional; ERC-8004 reader adapter (else address(0)).
 *
 *  Import the signer in your own terminal (hidden key and password prompts):
 *    cast wallet import bard-deployer --interactive
 *
 *  Simulate with the encrypted keystore. Omit --password-file to unlock manually
 *  in your terminal, or use a mode-0600 password file outside the repository:
 *    forge script script/DeployEscrowSecure.s.sol \
 *      --rpc-url "$ARC_RPC" --sender "$SECURE_ADMIN" \
 *      --keystore "$HOME/.foundry/keystores/bard-deployer" \
 *      --password-file "$HOME/.config/bard/deployer-password"
 *  Add --broadcast after reviewing a successful simulation. The example assumes
 *  the selected signer is SECURE_ADMIN; a distinct bootstrap signer is supported.
 */
contract DeployBardEscrowSecure is Script {
    address internal constant DEFAULT_PAYMENT_TOKEN = 0x3600000000000000000000000000000000000000;
    // SECURITY-AUDIT-escrow.md records this wallet's permanently exposed key.
    address internal constant COMPROMISED_TEST_ADMIN = 0xA1a16e5eE45A999845eF6c7CF99b16666b2Ba3c8;

    function run() external returns (ERC8183 commerce, BardJobHookV2 hook, address deployer) {
        address paymentToken = vm.envOr("PAYMENT_TOKEN", DEFAULT_PAYMENT_TOKEN);
        address secureAdmin  = vm.envAddress("SECURE_ADMIN");
        address reader       = vm.envOr("REPUTATION_READER", address(0));
        return _run(paymentToken, secureAdmin, reader);
    }

    function _run(address paymentToken, address secureAdmin, address reader)
        internal returns (ERC8183 commerce, BardJobHookV2 hook, address deployer)
    {
        require(secureAdmin != address(0), "SECURE_ADMIN required");
        require(secureAdmin != COMPROMISED_TEST_ADMIN, "Compromised test admin prohibited");

        vm.startBroadcast();
        // Read the actual broadcast signer, including Foundry --sender overrides.
        (, deployer,) = vm.readCallers();

        // ── 1. ERC-8183 (stock reference impl) behind a proxy.
        //    admin = deployer (bootstrap so inline config works); treasury = secureAdmin.
        ERC8183 impl = new ERC8183();
        bytes memory initCall = abi.encodeWithSelector(
            ERC8183.initialize.selector,
            secureAdmin,   // treasury_
            deployer       // admin_ (bootstrap, renounced below)
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initCall);
        address agenticCommerce = address(proxy);
        commerce = ERC8183(agenticCommerce);

        // ── 2. Hook — owner set directly to the secure wallet at construction.
        hook = new BardJobHookV2(agenticCommerce, paymentToken, reader, secureAdmin);

        // ── 3. Bootstrap config (deployer still holds ADMIN_ROLE here).
        ERC8183(agenticCommerce).setPaymentTokenAllowed(paymentToken, true);
        ERC8183(agenticCommerce).setHookWhitelist(address(hook), true);

        // ── 4. Hand ALL authority to secureAdmin, then renounce the bootstrap deployer.
        bytes32 adminRole        = ERC8183(agenticCommerce).ADMIN_ROLE();
        bytes32 defaultAdminRole = ERC8183(agenticCommerce).DEFAULT_ADMIN_ROLE();
        if (deployer != secureAdmin) {
            commerce.grantRole(defaultAdminRole, secureAdmin);
            commerce.grantRole(adminRole, secureAdmin);
            commerce.renounceRole(adminRole, deployer);
            commerce.renounceRole(defaultAdminRole, deployer);
        }

        vm.stopBroadcast();

        require(commerce.hasRole(defaultAdminRole, secureAdmin), "Final admin role missing");
        require(commerce.hasRole(adminRole, secureAdmin), "Final operator role missing");
        require(hook.owner() == secureAdmin, "Final hook owner mismatch");
        require(commerce.platformTreasury() == secureAdmin, "Final treasury mismatch");
        require(commerce.platformFeeBP() == 0 && commerce.evaluatorFeeBP() == 0, "Core fees must remain zero");
        require(commerce.allowedPaymentTokens(paymentToken), "Payment token not allowed");
        require(commerce.whitelistedHooks(address(hook)), "Hook not allowed");
        if (deployer != secureAdmin) {
            require(!commerce.hasRole(defaultAdminRole, deployer), "Bootstrap admin remains");
            require(!commerce.hasRole(adminRole, deployer), "Bootstrap operator remains");
        }

        console.log("=== BARD Escrow (secure redeploy) ===");
        console.log("ERC8183 impl   :", address(impl));
        console.log("ERC8183 proxy  :", agenticCommerce);
        console.log("BardJobHookV2  :", address(hook));
        console.log("paymentToken   :", paymentToken);
        console.log("reputationReader:", reader);
        console.log("secureAdmin    :", secureAdmin);
        console.log("deployer:", deployer);
        console.log("");
        console.log("Set on backend:  AGENTIC_COMMERCE_ADDRESS =", agenticCommerce);
        console.log("Set on backend:  BARD_JOB_HOOK_ADDRESS    =", address(hook));
    }
}
