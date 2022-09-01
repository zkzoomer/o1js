import {
  Account,
  Bool,
  Circuit,
  CircuitValue,
  DeployArgs,
  Experimental,
  Field,
  Int64,
  isReady,
  method,
  Mina,
  Party,
  Permissions,
  PrivateKey,
  prop,
  PublicKey,
  SmartContract,
  Token,
  UInt64,
} from 'snarkyjs';

/*
Supply Liquidity:
Action: Supply liquidity for X and Y tokens (extension: with vesting) + 1 MINA to optionally create the lqXY token
At the start: Your wallet must have two tokens (X and Y) in proportion to each other (based on the current balance of the liquidity pool)
At the end: Your wallet does not have custody of those two tokens, and instead has custody of a “coat-check-claim-ticket”
(lqXY token) token that can be redeemed later for your two tokens

Redeem Liquidity:
Action: Redeem original liquidity for lqXY tokens
At the start: Your wallet has a balance for lqXY
At the end: Your wallet has a balance for the equivalent amount of X and Y tokens and fewer lqXY tokens

Swap:
Action: Swap some amount of token X for an equivalent amount of token Y
At the start: Your wallet must have that amount of token X that you want to swap
At the end: Your wallet as less of token X (the amount you swapped) and more on the proportional amount of token Y
*/

class Dex extends SmartContract {
  /**
   * Mint liquidity tokens in exchange for X and Y tokens
   * @param user caller address
   * @param dx input amount of X tokens
   * @param dy input amount of Y tokens
   * @return output amount of lqXY tokens
   *
   * This function fails if the X and Y token amounts don't match the current X/Y ratio in the pool.
   * This can also be used if the pool is empty. In that case, there is no check on X/Y;
   * instead, the input X and Y amounts determine the initial ratio.
   *
   * The transaction needs to be signed by the user's private key.
   */
  @method supplyLiquidityBase(user: PublicKey, dx: UInt64, dy: UInt64): UInt64 {
    let tokenX = new TokenContract(addresses.tokenX);
    let tokenY = new TokenContract(addresses.tokenY);

    // get balances of X and Y token
    // TODO: this creates extra parties. we need to reuse these by passing them to transfer()
    // but for that, we need the @method argument generalization
    let dexX = Party.create(addresses.dex, tokenX.experimental.token.id);
    let x = dexX.account.balance.get();
    dexX.account.balance.assertEquals(x);

    let dexY = Party.create(addresses.dex, tokenY.experimental.token.id);
    let y = dexY.account.balance.get();
    dexY.account.balance.assertEquals(y);

    // assert dy == [dx * y/x], or x == 0
    let isXZero = x.equals(UInt64.zero);
    let xSafe = Circuit.if(isXZero, UInt64.one, x);
    dy.equals(dx.mul(y).div(xSafe)).or(isXZero).assertTrue();

    tokenX.transfer(user, addresses.dex, dx);
    tokenY.transfer(user, addresses.dex, dy);

    // calculate liquidity token output simply as dl = dx + dx
    // => maintains ratio x/l, y/l
    let dl = dy.add(dx);
    this.experimental.token.mint({ address: user, amount: dl });

    return dl;
  }

  /**
   * Mint liquidity tokens in exchange for X and Y tokens
   * @param user caller address
   * @param dx input amount of X tokens
   * @return output amount of lqXY tokens
   *
   * This uses supplyLiquidityBase as the circuit, but for convenience,
   * the input amount of Y tokens is calculated automatically from the X tokens.
   * Fails if the liquidity pool is empty, so can't be used for the first deposit.
   *
   * The transaction needs to be signed by the user's private key.
   */
  supplyLiquidity(user: PublicKey, dx: UInt64): UInt64 {
    // calculate dy outside circuit
    let x = Account(addresses.dex, idX).balance.get();
    let y = Account(addresses.dex, idY).balance.get();
    if (x.value.isZero().toBoolean()) {
      throw Error(
        'Cannot call `supplyLiquidity` when reserves are zero. Use `supplyLiquidityBase`.'
      );
    }
    let dy = dx.mul(y).div(x);
    return this.supplyLiquidityBase(user, dx, dy);
  }

  /**
   * Burn liquidity tokens to get back X and Y tokens
   * @param user caller address
   * @param dl input amount of lqXY token
   * @return output amount of X and Y tokens, as a tuple [outputX, outputY]
   *
   * The transaction needs to be signed by the user's private key.
   */
  @method redeemLiquidity(user: PublicKey, dl: UInt64): UInt64x2 {}

  /**
   * Swap X and Y tokens
   * @param user caller address
   * @param inputX input amount of X tokens
   * @param inputY input amount of Y tokens
   * @return output amount of X and Y tokens, as a tuple [outputX, outputY]
   *
   * This can be used to swap X for Y OR swap Y for X.
   * To swap X for Y, pass in inputY = 0, and inputX = the amount of X tokens you want to spend.
   * To swap Y for X, pass in inputX = 0, and inputY = the amount of Y tokens you want to spend.
   */
  @method swap(user: PublicKey, inputX: UInt64, inputY: UInt64): UInt64x2 {}
}

// TODO: this is a pain -- let's define circuit values in one line, with a factory pattern
// we just have to make circuitValue return a class, that's it!
// class UInt64x2 extends circuitValue([UInt64, UInt64]) {}
class UInt64x2 extends CircuitValue {
  @prop 0: UInt64;
  @prop 1: UInt64;
}

class DexTokenHolder extends SmartContract {}

/**
 * Simple token with API flexible enough to handle all our use cases
 */
class TokenContract extends SmartContract {
  // constant supply
  SUPPLY = UInt64.from(10n ** 18n);

  deploy(args: DeployArgs) {
    super.deploy(args);
    this.setPermissions({
      ...Permissions.default(),
      send: Permissions.proof(),
    });
  }
  @method init() {
    // mint the entire supply to the token account with the same address as this contract
    let address = this.self.body.publicKey;
    let receiver = this.experimental.token.mint({
      address,
      amount: this.SUPPLY,
    });
    // assert that the receiving account is new, so this can be only done once
    receiver.account.isNew.assertEquals(Bool(true));
    // pay fees for opened account
    this.balance.subInPlace(Mina.accountCreationFee());
  }

  // this is a very standardized deploy method. instead, we could also take the party from a callback
  // => need callbacks for signatures
  @method deployZkapp(zkappKey: PrivateKey) {
    let address = zkappKey.toPublicKey();
    let tokenId = this.experimental.token.id;
    let zkapp = Experimental.createChildParty(this.self, address, tokenId);
    Party.setValue(zkapp.update.permissions, {
      ...Permissions.default(),
      send: Permissions.proof(),
    });
    // TODO pass in verification key --> make it a circuit value --> make circuit values able to hold auxiliary data
    // Party.setValue(zkapp.update.verificationKey, verificationKey);
    zkapp.signInPlace(zkappKey, true);
  }

  // let a zkapp do whatever it wants, as long as the token supply stays constant
  @method authorize(callback: Experimental.Callback) {
    let layout = [[2, 0], 0]; // these are 7 child parties we allow, in a left-biased tree
    let zkappParty = Experimental.partyFromCallback(this, layout, callback);
    // walk parties to see if balances for this token cancel
    let balance = balanceSum(zkappParty, this.experimental.token.id);
    balance.assertEquals(Int64.zero);
  }

  @method transfer(from: PublicKey, to: PublicKey, value: UInt64) {
    this.experimental.token.send({ from, to, amount: value });
  }
}

await isReady;
let { keys, addresses } = randomAccounts('tokenX', 'tokenY', 'dex', 'user');
let idX = Token.getId(addresses.tokenX);
let idY = Token.getId(addresses.tokenY);

/**
 * Sum of balances of the party and all its descendants
 */
function balanceSum(party: Party, tokenId: Field) {
  let myTokenId = party.body.tokenId;
  let myBalance = Int64.fromObject(party.body.balanceChange);
  let balance = Circuit.if(myTokenId.equals(tokenId), myBalance, Int64.zero);
  for (let child of party.children.parties) {
    balance.add(balanceSum(child, tokenId));
  }
  return balance;
}

/**
 * Random accounts keys, labeled by the input strings
 */
function randomAccounts<K extends string>(
  ...names: [K, ...K[]]
): { keys: Record<K, PrivateKey>; addresses: Record<K, PublicKey> } {
  let keys = Object.fromEntries(
    names.map((name) => [name, PrivateKey.random()])
  ) as Record<K, PrivateKey>;
  let addresses = Object.fromEntries(
    names.map((name) => [name, keys[name].toPublicKey()])
  ) as Record<K, PublicKey>;
  return { keys, addresses };
}
