// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/// @title MockERC20
/// @notice A test ERC20 with configurable decimals, mintable by a single minter.
///         Used as a stand-in for USDC(6) / WBTC(8) / DAI(18) and similar.
/// @dev    `mint` used to be open to anyone, which is harmless on a dev node the environment owns
///         and is free money on a chain participants can reach (issue #33 / ADR 0021 §7): a
///         competitor who calls it has an unbounded balance and no score means anything. The minter
///         is the deployer, which is also the treasury that funds wallets on a cheatcode-free chain,
///         so nothing in the deploy path changes -- every mint there already came from that account.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;

    /// @notice The only account that may mint. Set to the deployer; transferable so the environment
    ///         can hand minting to a treasury EOA that is not the deployer.
    address public minter;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event MinterChanged(address indexed previous, address indexed next);

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
        minter = msg.sender;
        emit MinterChanged(address(0), msg.sender);
    }

    function setMinter(address next) external {
        require(msg.sender == minter, "MockERC20: not minter");
        emit MinterChanged(minter, next);
        minter = next;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "MockERC20: not minter");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "MockERC20: insufficient allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "MockERC20: insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
