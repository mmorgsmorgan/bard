// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Anvil has no Arc CallFrom precompile. This fixture reproduces the memo
// wrapper's ERC20 transfer effect using approvals installed by the fixture.
// It is never deployed to Arc and grants no permissions in application code.
contract ArcMemoFixture {
    function memo(address target, bytes calldata data, bytes32, bytes calldata) external {
        require(data.length == 68 && bytes4(data[:4]) == IERC20.transfer.selector, "transfer only");
        (address recipient, uint256 amount) = abi.decode(data[4:], (address, uint256));
        require(IERC20(target).transferFrom(msg.sender, recipient, amount), "transfer failed");
    }
}
