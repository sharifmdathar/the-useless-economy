// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title UselessNFT
 * @notice The pointless asset of "The Useless Economy" — an AI agent that
 *         hires other AI agents hires NFTs for equally pointless reasons.
 *
 * WHY THIS CONTRACT EXISTS
 * ------------------------
 * Week 2 of the RiseIn AI-agent programme asks for a deployed smart contract
 * that the agent can call through its own tools. This is that contract: a
 * self-contained ERC-721 with a tiny on-chain marketplace bolted onto it, so
 * one deployment covers all three operations the brief names — MINTING,
 * BUYING and SELLING.
 *
 * It is deliberately dependency-free (no OpenZeppelin import) so it compiles
 * with a bare `solc` and can be deployed from a plain Node script.
 *
 * THE ROLES
 * ----------
 *   owner    — the deployer. Can move the minter and the treasury.
 *   minter   — the agent's wallet. Only the minter may mint. Minting is what
 *              the agent's `mint_nft` tool calls.
 *   treasury — where sale proceeds are sent when a listing names no seller
 *              payout address. Defaults to the seller.
 *
 * MONEY
 * -----
 * Prices are denominated in USDC base units (6 decimals) and paid with a
 * plain ERC-20 `transferFrom`. The buyer approves the contract first, which
 * is what the agent's `buy_nft` tool does before it calls `buy()`. Keeping
 * the payment in plain USDC (rather than EIP-3009) means the contract has no
 * opinion about how the buyer authorised the spend — MetaMask, the agent's
 * own key, or anything else that can sign an `approve`.
 *
 * TESTNET ONLY. Base Sepolia. The chain id is not enforced here on purpose:
 * the contract is chain-agnostic, and every caller in this repo pins
 * Base Sepolia in code.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);

    function approve(address spender, uint256 amount) external returns (bool);

    function balanceOf(address account) external view returns (uint256);
}

contract UselessNFT {
    // ─── ERC-721 identity ────────────────────────────────────────────────

    string public constant name = "Useless Economy NFT";
    string public constant symbol = "USELESS";

    // ─── ERC-721 storage ─────────────────────────────────────────────────

    mapping(uint256 => address) private _owners;
    mapping(address => uint256) private _balances;
    mapping(uint256 => address) private _tokenApprovals;
    mapping(address => mapping(address => bool)) private _operatorApprovals;
    mapping(uint256 => string) private _tokenURIs;

    /// @dev Token ids start at 1 so that id 0 can mean "no token".
    uint256 private _nextTokenId = 1;

    // ─── Marketplace storage ─────────────────────────────────────────────

    struct Listing {
        uint256 price; // USDC base units
        address seller;
        bool active;
    }

    mapping(uint256 => Listing) private _listings;

    // ─── Roles and configuration ─────────────────────────────────────────

    /// @notice The deployer. Owns the configuration of this contract.
    address public immutable owner;

    /// @notice The only address allowed to mint. In production: the agent wallet.
    address public minter;

    /// @notice Where proceeds go when a listing names no seller.
    address public treasury;

    /// @notice The ERC-20 that prices are paid in (USDC on Base Sepolia).
    address public immutable paymentToken;

    // ─── Events ──────────────────────────────────────────────────────────

    event Transfer(
        address indexed from,
        address indexed to,
        uint256 indexed tokenId
    );
    event Approval(
        address indexed owner,
        address indexed approved,
        uint256 indexed tokenId
    );
    event ApprovalForAll(
        address indexed owner,
        address indexed operator,
        bool approved
    );
    event Minted(uint256 indexed tokenId, address indexed to, string tokenURI);
    event Listed(
        uint256 indexed tokenId,
        address indexed seller,
        uint256 price
    );
    event ListingCancelled(uint256 indexed tokenId);
    event Sold(
        uint256 indexed tokenId,
        address indexed buyer,
        address indexed seller,
        uint256 price
    );
    event MinterChanged(address indexed previousMinter, address indexed newMinter);
    event TreasuryChanged(address indexed previousTreasury, address indexed newTreasury);

    // ─── Errors ──────────────────────────────────────────────────────────

    error NotAuthorized();
    error NotOwner();
    error ZeroAddress();
    error ZeroPrice();
    error TokenDoesNotExist();
    error TokenAlreadyExists();
    error NotForSale();
    error AlreadyListed();
    error NotListed();
    error PaymentFailed();
    error UnsupportedPaymentToken();

    // ─── Constructor ─────────────────────────────────────────────────────

    constructor(address initialMinter, address usdcAddress) {
        if (initialMinter == address(0) || usdcAddress == address(0)) {
            revert ZeroAddress();
        }
        owner = msg.sender;
        minter = initialMinter;
        treasury = msg.sender;
        paymentToken = usdcAddress;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotAuthorized();
        _;
    }

    // ─── ERC-721 views ───────────────────────────────────────────────────

    function totalSupply() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address tokenOwner = _owners[tokenId];
        if (tokenOwner == address(0)) revert TokenDoesNotExist();
        return tokenOwner;
    }

    function balanceOf(address account) external view returns (uint256) {
        return _balances[account];
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        return _tokenApprovals[tokenId];
    }

    function isApprovedForAll(
        address owner_,
        address operator
    ) external view returns (bool) {
        return _operatorApprovals[owner_][operator];
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (_owners[tokenId] == address(0)) revert TokenDoesNotExist();
        return _tokenURIs[tokenId];
    }

    // ─── Marketplace views ───────────────────────────────────────────────

    function listingOf(
        uint256 tokenId
    ) external view returns (uint256 price, address seller, bool active) {
        Listing memory l = _listings[tokenId];
        return (l.price, l.seller, l.active);
    }

    function isListed(uint256 tokenId) external view returns (bool) {
        return _listings[tokenId].active;
    }

    /// @notice Every token id currently on sale.
    function listedTokenIds() external view returns (uint256[] memory) {
        uint256 total = _nextTokenId - 1;
        uint256 count = 0;
        for (uint256 i = 1; i <= total; i++) {
            if (_listings[i].active) count++;
        }
        uint256[] memory ids = new uint256[](count);
        uint256 k = 0;
        for (uint256 i = 1; i <= total; i++) {
            if (_listings[i].active) {
                ids[k] = i;
                k++;
            }
        }
        return ids;
    }

    // ─── Configuration ───────────────────────────────────────────────────

    function setMinter(address newMinter) external onlyOwner {
        if (newMinter == address(0)) revert ZeroAddress();
        emit MinterChanged(minter, newMinter);
        minter = newMinter;
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryChanged(treasury, newTreasury);
        treasury = newTreasury;
    }

    // ─── MINTING ─────────────────────────────────────────────────────────

    /**
     * @notice Mint a token to `to` with the given metadata URI.
     * @dev Only the minter may call this. The agent's `mint_nft` tool calls it.
     * @param to Recipient of the token.
     * @param uri Metadata URI (the app serves these; IPFS in production).
     * @return tokenId The id of the freshly minted token.
     */
    function mint(
        address to,
        string calldata uri
    ) external onlyMinter returns (uint256 tokenId) {
        if (to == address(0)) revert ZeroAddress();

        tokenId = _nextTokenId++;
        _mint(to, tokenId);
        _tokenURIs[tokenId] = uri;

        emit Minted(tokenId, to, uri);
    }

    // ─── SELLING ─────────────────────────────────────────────────────────

    /**
     * @notice Put a token up for sale at `price` USDC base units.
     * @dev The caller must own the token or be approved for it.
     */
    function listForSale(uint256 tokenId, uint256 price) external {
        if (price == 0) revert ZeroPrice();
        address tokenOwner = ownerOf(tokenId);
        if (
            msg.sender != tokenOwner &&
            !_operatorApprovals[tokenOwner][msg.sender] &&
            _tokenApprovals[tokenId] != msg.sender
        ) {
            revert NotAuthorized();
        }
        if (_listings[tokenId].active) revert AlreadyListed();

        _listings[tokenId] = Listing({
            price: price,
            seller: tokenOwner,
            active: true
        });

        emit Listed(tokenId, tokenOwner, price);
    }

    /// @notice Take a token off the market. Only the seller may do this.
    function cancelListing(uint256 tokenId) external {
        Listing memory l = _listings[tokenId];
        if (!l.active) revert NotListed();
        if (msg.sender != l.seller) revert NotAuthorized();

        delete _listings[tokenId];

        emit ListingCancelled(tokenId);
    }

    // ─── BUYING ──────────────────────────────────────────────────────────

    /**
     * @notice Buy a listed token. The caller must have approved this contract
     *         to spend their USDC.
     * @dev The USDC transferFrom is the last thing that happens: if the
     *      payment fails the whole transaction reverts, so a token can never
     *      change hands without the money moving.
     */
    function buy(uint256 tokenId) external {
        Listing memory l = _listings[tokenId];
        if (!l.active) revert NotForSale();

        address seller = l.seller;
        address proceedsTo = seller == address(0) ? treasury : seller;

        // Effects: the listing is closed and the token moves.
        delete _listings[tokenId];
        _transfer(seller, msg.sender, tokenId);

        // Interaction: the payment, last, and it must succeed.
        bool ok = IERC20(paymentToken).transferFrom(
            msg.sender,
            proceedsTo,
            l.price
        );
        if (!ok) revert PaymentFailed();

        emit Sold(tokenId, msg.sender, seller, l.price);
    }

    /// @notice Convenience view: the full on-chain state of one token.
    function tokenInfo(
        uint256 tokenId
    )
        external
        view
        returns (
            address tokenOwner,
            string memory uri,
            uint256 price,
            address seller,
            bool active
        )
    {
        tokenOwner = ownerOf(tokenId);
        uri = _tokenURIs[tokenId];
        Listing memory l = _listings[tokenId];
        price = l.price;
        seller = l.seller;
        active = l.active;
    }

    // ─── ERC-721 mutations ───────────────────────────────────────────────

    function approve(address to, uint256 tokenId) external {
        address tokenOwner = ownerOf(tokenId);
        if (msg.sender != tokenOwner && !_operatorApprovals[tokenOwner][msg.sender]) {
            revert NotAuthorized();
        }
        _tokenApprovals[tokenId] = to;
        emit Approval(tokenOwner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    /**
     * @notice Transfer a token. The marketplace's `buy` moves tokens
     *         internally, so this is only for ordinary transfers.
     */
    function transferFrom(
        address from,
        address to,
        uint256 tokenId
    ) external {
        if (
            msg.sender != from &&
            !_operatorApprovals[from][msg.sender] &&
            _tokenApprovals[tokenId] != msg.sender
        ) {
            revert NotAuthorized();
        }
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 tokenId
    ) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(
        address from,
        address to,
        uint256 tokenId,
        bytes memory data
    ) public {
        if (
            msg.sender != from &&
            !_operatorApprovals[from][msg.sender] &&
            _tokenApprovals[tokenId] != msg.sender
        ) {
            revert NotAuthorized();
        }
        _transfer(from, to, tokenId);
        if (to.code.length != 0) {
            // A contract recipient must acknowledge the transfer.
            (bool ok, bytes memory returned) = to.call(
                abi.encodeWithSelector(0x150b7a02, msg.sender, from, tokenId, data)
            );
            if (!ok || (returned.length != 0 && !abi.decode(returned, (bool)))) {
                revert PaymentFailed();
            }
        }
    }

    // ─── Internals ───────────────────────────────────────────────────────

    function _mint(address to, uint256 tokenId) internal {
        if (_owners[tokenId] != address(0)) revert TokenAlreadyExists();
        _owners[tokenId] = to;
        _balances[to] += 1;
        emit Transfer(address(0), to, tokenId);
    }

    function _transfer(address from, address to, uint256 tokenId) internal {
        address tokenOwner = ownerOf(tokenId);
        if (tokenOwner != from) revert NotAuthorized();
        if (to == address(0)) revert ZeroAddress();

        // Clear the stale per-token approval, the way ERC-721 requires.
        delete _tokenApprovals[tokenId];

        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[tokenId] = to;

        emit Transfer(from, to, tokenId);
    }
}
