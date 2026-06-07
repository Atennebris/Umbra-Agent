// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IToken {
  function mint(address to, uint256 amount) external;
  function burn(uint256 amount) external;
}

library SafeMath {
  function add(uint256 a, uint256 b) internal pure returns (uint256) {
    return a + b;
  }
}

contract UmbraToken is ERC20, Ownable {
  uint256 public maxSupply;

  event TokensMinted(address indexed to, uint256 amount);

  struct Vesting {
    uint256 amount;
    uint256 releaseTime;
  }

  enum Phase {
    Seed,
    Public,
    Closed
  }

  modifier onlyInPhase(Phase phase) {
    require(currentPhase == phase, "Wrong phase");
    _;
  }

  Phase public currentPhase;

  constructor(uint256 _maxSupply) ERC20("UmbraToken", "UMB") Ownable(msg.sender) {
    maxSupply = _maxSupply;
    currentPhase = Phase.Seed;
  }

  function mint(address to, uint256 amount) external onlyOwner {
    require(totalSupply() + amount <= maxSupply, "Exceeds max supply");
    _mint(to, amount);
    emit TokensMinted(to, amount);
  }

  error InsufficientBalance(uint256 available, uint256 required);
}
