import {
  provable,
  provablePure,
  cloneCircuitValue,
  memoizationContext,
  memoizeWitness,
  FlexibleProvable,
} from './circuit_value.js';
import { Field, Bool, Ledger, Circuit, Pickles } from '../snarky.js';
import { jsLayout } from '../provable/gen/js-layout.js';
import { Types, toJSONEssential } from '../provable/types.js';
import { PrivateKey, PublicKey } from './signature.js';
import { UInt64, UInt32, Int64, Sign } from './int.js';
import * as Mina from './mina.js';
import { SmartContract } from './zkapp.js';
import * as Precondition from './precondition.js';
import { inCheckedComputation, Proof, Prover } from './proof_system.js';
import { hashWithPrefix, packToFields, prefixes, TokenSymbol } from './hash.js';
import * as Encoding from './encoding.js';
import { Context } from './global-context.js';
import { Events, SequenceEvents } from '../provable/transaction-leaves.js';
import { Memo } from '../mina-signer/src/memo.js';

// external API
export { Permissions, AccountUpdate, ZkappPublicInput };

// internal API
export {
  smartContractContext,
  SetOrKeep,
  Permission,
  Preconditions,
  Body,
  Authorization,
  FeePayerUnsigned,
  ZkappCommand,
  addMissingSignatures,
  addMissingProofs,
  signJsonTransaction,
  ZkappStateLength,
  Events,
  SequenceEvents,
  TokenId,
  Token,
  CallForest,
  createChildAccountUpdate,
  AccountUpdatesLayout,
  zkAppProver,
};

const ZkappStateLength = 8;

let smartContractContext = Context.create<{
  this: SmartContract;
  methodCallDepth: number;
  isCallback: boolean;
  selfUpdate: AccountUpdate;
}>();

let zkAppProver = Prover<{
  transaction: ZkappCommand;
  accountUpdate: AccountUpdate;
  index: number;
}>();

type AuthRequired = Types.Json.AuthRequired;

type AccountUpdateBody = Types.AccountUpdate['body'];
type Update = AccountUpdateBody['update'];

/**
 * Preconditions for the network and accounts
 */
type Preconditions = AccountUpdateBody['preconditions'];

/**
 * Timing info inside an account.
 */
type Timing = Update['timing']['value'];

/**
 * Either set a value or keep it the same.
 */
type SetOrKeep<T> = { isSome: Bool; value: T };

function keep<T>(dummy: T): SetOrKeep<T> {
  return { isSome: Bool(false), value: dummy };
}

const True = () => Bool(true);
const False = () => Bool(false);

/**
 * One specific permission value.
 *
 * A {@link Permission} tells one specific permission for our zkapp how it should behave
 * when presented with requested modifications.
 *
 * Use static factory methods on this class to use a specific behavior. See
 * documentation on those methods to learn more.
 */
type Permission = Types.AuthRequired;
let Permission = {
  /**
   * Modification is impossible.
   */
  impossible: (): Permission => ({
    constant: True(),
    signatureNecessary: True(),
    signatureSufficient: False(),
  }),

  /**
   * Modification is always permitted
   */
  none: (): Permission => ({
    constant: True(),
    signatureNecessary: False(),
    signatureSufficient: True(),
  }),

  /**
   * Modification is permitted by zkapp proofs only
   */
  proof: (): Permission => ({
    constant: False(),
    signatureNecessary: False(),
    signatureSufficient: False(),
  }),

  /**
   * Modification is permitted by signatures only, using the private key of the zkapp account
   */
  signature: (): Permission => ({
    constant: False(),
    signatureNecessary: True(),
    signatureSufficient: True(),
  }),

  /**
   * Modification is permitted by zkapp proofs or signatures
   */
  proofOrSignature: (): Permission => ({
    constant: False(),
    signatureNecessary: False(),
    signatureSufficient: True(),
  }),
};

// TODO: we could replace the interface below if we could bridge annotations from OCaml
type Permissions_ = Update['permissions']['value'];

/**
 * Permissions specify how specific aspects of the zkapp account are allowed to
 * be modified. All fields are denominated by a {@link Permission}.
 */
interface Permissions extends Permissions_ {
  /**
   * The {@link Permission} corresponding to the 8 state fields associated with an
   * account.
   */
  editState: Permission;

  /**
   * The {@link Permission} corresponding to the ability to send transactions from this
   * account.
   */
  send: Permission;

  /**
   * The {@link Permission} corresponding to the ability to receive transactions to this
   * account.
   */
  receive: Permission;

  /**
   * The {@link Permission} corresponding to the ability to set the delegate field of
   * the account.
   */
  setDelegate: Permission;

  /**
   * The {@link Permission} corresponding to the ability to set the permissions field of
   * the account.
   */
  setPermissions: Permission;

  /**
   * The {@link Permission} corresponding to the ability to set the verification key
   * associated with the circuit tied to this account. Effectively
   * "upgradeability" of the smart contract.
   */
  setVerificationKey: Permission;

  /**
   * The {@link Permission} corresponding to the ability to set the zkapp uri typically
   * pointing to the source code of the smart contract. Usually this should be
   * changed whenever the {@link Permissions.setVerificationKey} is changed.
   * Effectively "upgradeability" of the smart contract.
   */
  setZkappUri: Permission;

  /**
   * The {@link Permission} corresponding to the ability to change the sequence state
   * associated with the account.
   *
   * TODO: Define sequence state here as well.
   */
  editSequenceState: Permission;

  /**
   * The {@link Permission} corresponding to the ability to set the token symbol for
   * this account.
   */
  setTokenSymbol: Permission;

  // TODO: doccomments
  incrementNonce: Permission;
  setVotingFor: Permission;
}
let Permissions = {
  ...Permission,
  /**
   * Default permissions are:
   *
   *   {@link Permissions.editState} = {@link Permission.proof}
   *
   *   {@link Permissions.send} = {@link Permission.signature}
   *
   *   {@link Permissions.receive} = {@link Permission.none}
   *
   *   {@link Permissions.setDelegate} = {@link Permission.signature}
   *
   *   {@link Permissions.setPermissions} = {@link Permission.signature}
   *
   *   {@link Permissions.setVerificationKey} = {@link Permission.signature}
   *
   *   {@link Permissions.setZkappUri} = {@link Permission.signature}
   *
   *   {@link Permissions.editSequenceState} = {@link Permission.proof}
   *
   *   {@link Permissions.setTokenSymbol} = {@link Permission.signature}
   *
   */
  default: (): Permissions => ({
    editState: Permission.proof(),
    send: Permission.proof(),
    receive: Permission.none(),
    setDelegate: Permission.signature(),
    setPermissions: Permission.signature(),
    setVerificationKey: Permission.signature(),
    setZkappUri: Permission.signature(),
    editSequenceState: Permission.proof(),
    setTokenSymbol: Permission.signature(),
    incrementNonce: Permission.signature(),
    setVotingFor: Permission.signature(),
  }),

  initial: (): Permissions => ({
    editState: Permission.signature(),
    send: Permission.signature(),
    receive: Permission.none(),
    setDelegate: Permission.signature(),
    setPermissions: Permission.signature(),
    setVerificationKey: Permission.signature(),
    setZkappUri: Permission.signature(),
    editSequenceState: Permission.signature(),
    setTokenSymbol: Permission.signature(),
    incrementNonce: Permission.signature(),
    setVotingFor: Permission.signature(),
  }),

  dummy: (): Permissions => ({
    editState: Permission.none(),
    send: Permission.none(),
    receive: Permission.none(),
    setDelegate: Permission.none(),
    setPermissions: Permission.none(),
    setVerificationKey: Permission.none(),
    setZkappUri: Permission.none(),
    editSequenceState: Permission.none(),
    setTokenSymbol: Permission.none(),
    incrementNonce: Permission.none(),
    setVotingFor: Permission.none(),
  }),

  fromString: (permission: AuthRequired): Permission => {
    switch (permission) {
      case 'None':
        return Permission.none();
      case 'Either':
        return Permission.proofOrSignature();
      case 'Proof':
        return Permission.proof();
      case 'Signature':
        return Permission.signature();
      case 'Impossible':
        return Permission.impossible();
      default:
        throw Error(
          `Cannot parse invalid permission. ${permission} does not exist.`
        );
    }
  },

  fromJSON: (permissions: {
    editState: AuthRequired;
    send: AuthRequired;
    receive: AuthRequired;
    setDelegate: AuthRequired;
    setPermissions: AuthRequired;
    setVerificationKey: AuthRequired;
    setZkappUri: AuthRequired;
    editSequenceState: AuthRequired;
    setTokenSymbol: AuthRequired;
    incrementNonce: AuthRequired;
    setVotingFor: AuthRequired;
  }): Permissions => {
    return Object.fromEntries(
      Object.entries(permissions).map(([k, v]) => [
        k,
        Permissions.fromString(v),
      ])
    ) as unknown as Permissions;
  },
};

// TODO: get docstrings from OCaml and delete this interface
// TODO: We need to rename this still.

/**
 * The body of describing how some [[ AccountUpdate ]] should change.
 */
interface Body extends AccountUpdateBody {
  /**
   * The address for this body.
   */
  publicKey: PublicKey;

  /**
   * Specify {@link Update}s to tweakable pieces of the account record backing
   * this address in the ledger.
   */
  update: Update;

  /**
   * The TokenId for this account.
   */
  tokenId: Field;

  /**
   * By what {@link Int64} should the balance of this account change. All
   * balanceChanges must balance by the end of smart contract execution.
   */
  balanceChange: {
    magnitude: UInt64;
    sgn: Sign;
  };

  /**
   * Recent events that have been emitted from this account.
   * Events can be collected by archive nodes.
   *
   * [Check out our documentation about Events!](https://docs.minaprotocol.com/zkapps/advanced-snarkyjs/events)
   */
  events: Events;
  /**
   * Recent sequence events (also know as {@link Action}s) emitted from this account.
   * Sequence events can be collected by archive nodes and used in combination with a {@link Reducer}.
   *
   * [Check out our documentation about Actions!](https://docs.minaprotocol.com/zkapps/advanced-snarkyjs/actions-and-reducer)
   */
  sequenceEvents: Events;
  caller: Field;
  callData: Field;
  callDepth: number;
  /**
   * A list of {@link Preconditions} that need to be fulfilled in order for the {@link AccountUpdate} to be valid.
   */
  preconditions: Preconditions;
  /**
   * Defines if a full commitment is required for this transaction.
   */
  useFullCommitment: Bool;
  /**
   * Defines if the nonce should be incremented with this {@link AccountUpdate}.
   */
  incrementNonce: Bool;
  /**
   * Defines the type of authorization that is needed for this {@link AccountUpdate}.
   *
   * A authorization can be one of three types: None, Proof or Signature
   */
  authorizationKind: AccountUpdateBody['authorizationKind'];
}
const Body = {
  noUpdate(): Update {
    return {
      appState: Array(ZkappStateLength)
        .fill(0)
        .map(() => keep(Field(0))),
      delegate: keep(PublicKey.empty()),
      // TODO
      verificationKey: keep({ data: '', hash: Field(0) }),
      permissions: keep(Permissions.initial()),
      // TODO don't hard code
      zkappUri: keep({
        data: '',
        hash: Field(
          '22930868938364086394602058221028773520482901241511717002947639863679740444066'
        ),
      }),
      // TODO
      tokenSymbol: keep(TokenSymbol.empty),
      timing: keep<Timing>({
        cliffAmount: UInt64.zero,
        cliffTime: UInt32.zero,
        initialMinimumBalance: UInt64.zero,
        vestingIncrement: UInt64.zero,
        vestingPeriod: UInt32.zero,
      }),
      votingFor: keep(Field(0)),
    };
  },

  /**
   * A body that Don't change part of the underlying account record.
   */
  keepAll(publicKey: PublicKey): Body {
    return {
      publicKey,
      update: Body.noUpdate(),
      tokenId: TokenId.default,
      balanceChange: Int64.zero,
      events: Events.empty(),
      sequenceEvents: SequenceEvents.empty(),
      caller: TokenId.default,
      callData: Field(0),
      callDepth: 0,
      preconditions: Preconditions.ignoreAll(),
      // the default assumption is that snarkyjs transactions don't include the fee payer
      // so useFullCommitment has to be false for signatures to be correct
      useFullCommitment: Bool(false),
      // this should be set to true if accountUpdates are signed
      incrementNonce: Bool(false),
      authorizationKind: { isSigned: Bool(false), isProved: Bool(false) },
    };
  },

  dummy(): Body {
    return Body.keepAll(PublicKey.empty());
  },
};

type FeePayer = Types.ZkappCommand['feePayer'];
type FeePayerBody = FeePayer['body'];
const FeePayerBody = {
  keepAll(publicKey: PublicKey, nonce: UInt32): FeePayerBody {
    return {
      publicKey,
      nonce,
      fee: UInt64.zero,
      validUntil: undefined,
    };
  },
};
type FeePayerUnsigned = FeePayer & {
  lazyAuthorization?: LazySignature | undefined;
};

/**
 * Either check a value or ignore it.
 *
 * Used within [[ AccountPredicate ]]s and [[ ProtocolStatePredicate ]]s.
 */
type OrIgnore<T> = { isSome: Bool; value: T };

/**
 * An interval representing all the values between `lower` and `upper` inclusive
 * of both the `lower` and `upper` values.
 *
 * @typeParam A something with an ordering where one can quantify a lower and
 *            upper bound.
 */
type ClosedInterval<T> = { lower: T; upper: T };

type NetworkPrecondition = Preconditions['network'];
let NetworkPrecondition = {
  ignoreAll(): NetworkPrecondition {
    let stakingEpochData = {
      ledger: { hash: ignore(Field(0)), totalCurrency: ignore(uint64()) },
      seed: ignore(Field(0)),
      startCheckpoint: ignore(Field(0)),
      lockCheckpoint: ignore(Field(0)),
      epochLength: ignore(uint32()),
    };
    let nextEpochData = cloneCircuitValue(stakingEpochData);
    return {
      snarkedLedgerHash: ignore(Field(0)),
      timestamp: ignore(uint64()),
      blockchainLength: ignore(uint32()),
      minWindowDensity: ignore(uint32()),
      totalCurrency: ignore(uint64()),
      globalSlotSinceHardFork: ignore(uint32()),
      globalSlotSinceGenesis: ignore(uint32()),
      stakingEpochData,
      nextEpochData,
    };
  },
};

/**
 * Ignores a `dummy`
 *
 * @param dummy The value to ignore
 * @returns Always an ignored value regardless of the input.
 */
function ignore<T>(dummy: T): OrIgnore<T> {
  return { isSome: Bool(false), value: dummy };
}

/**
 * Ranges between all uint32 values
 */
const uint32 = () => ({ lower: UInt32.from(0), upper: UInt32.MAXINT() });

/**
 * Ranges between all uint64 values
 */
const uint64 = () => ({ lower: UInt64.from(0), upper: UInt64.MAXINT() });

type AccountPrecondition = Preconditions['account'];
const AccountPrecondition = {
  ignoreAll(): AccountPrecondition {
    let appState: Array<OrIgnore<Field>> = [];
    for (let i = 0; i < ZkappStateLength; ++i) {
      appState.push(ignore(Field(0)));
    }
    return {
      balance: ignore(uint64()),
      nonce: ignore(uint32()),
      receiptChainHash: ignore(Field(0)),
      delegate: ignore(PublicKey.empty()),
      state: appState,
      sequenceState: ignore(SequenceEvents.emptySequenceState()),
      provedState: ignore(Bool(false)),
      isNew: ignore(Bool(false)),
    };
  },
  nonce(nonce: UInt32): AccountPrecondition {
    let p = AccountPrecondition.ignoreAll();
    AccountUpdate.assertEquals(p.nonce, nonce);
    return p;
  },
};

const Preconditions = {
  ignoreAll(): Preconditions {
    return {
      account: AccountPrecondition.ignoreAll(),
      network: NetworkPrecondition.ignoreAll(),
    };
  },
};

type Control = Types.AccountUpdate['authorization'];
type LazyNone = { kind: 'lazy-none' };
type LazySignature = { kind: 'lazy-signature'; privateKey?: PrivateKey };
type LazyProof = {
  kind: 'lazy-proof';
  methodName: string;
  args: any[];
  previousProofs: { publicInput: Field[]; proof: Pickles.Proof }[];
  ZkappClass: typeof SmartContract;
  memoized: { fields: Field[]; aux: any[] }[];
  blindingValue: Field;
};

const TokenId = {
  ...Types.TokenId,
  ...Encoding.TokenId,
  get default() {
    return Field(1);
  },
};

class Token {
  readonly id: Field;
  readonly parentTokenId: Field;
  readonly tokenOwner: PublicKey;

  static Id = TokenId;

  static getId(tokenOwner: PublicKey, parentTokenId = TokenId.default) {
    if (tokenOwner.isConstant() && parentTokenId.isConstant()) {
      return Ledger.customTokenId(tokenOwner, parentTokenId);
    } else {
      return Ledger.customTokenIdChecked(tokenOwner, parentTokenId);
    }
  }

  constructor({
    tokenOwner,
    parentTokenId = TokenId.default,
  }: {
    tokenOwner: PublicKey;
    parentTokenId?: Field;
  }) {
    this.parentTokenId = parentTokenId;
    this.tokenOwner = tokenOwner;
    try {
      this.id = Token.getId(tokenOwner, parentTokenId);
    } catch (e) {
      throw new Error(
        `Could not create a custom token id:\nError: ${(e as Error).message}`
      );
    }
  }
}
/**
 * An {@link AccountUpdate} is a set of instructions for the Mina network.
 * It includes {@link Preconditions} and a list of state updates, which need to be authorized by either a {@link Signature} or {@link Proof}.
 */
class AccountUpdate implements Types.AccountUpdate {
  id: number;
  /**
   * A human-readable label for the account update, indicating how that update was created.
   * Can be modified by applications to add richer information.
   */
  label: string = '';
  body: Body;
  isDelegateCall = Bool(false);
  authorization: Control;
  lazyAuthorization: LazySignature | LazyProof | LazyNone | undefined =
    undefined;
  account: Precondition.Account;
  network: Precondition.Network;
  children: {
    callsType:
      | { type: 'None' }
      | { type: 'Witness' }
      | { type: 'Equals'; value: Field };
    accountUpdates: AccountUpdate[];
  } = {
    callsType: { type: 'None' },
    accountUpdates: [],
  };
  parent: AccountUpdate | undefined = undefined;

  private isSelf: boolean;

  static SequenceEvents = SequenceEvents;

  constructor(body: Body, authorization?: Control);
  constructor(body: Body, authorization: Control = {}, isSelf = false) {
    this.id = Math.random();
    this.body = body;
    this.authorization = authorization;
    let { account, network } = Precondition.preconditions(this, isSelf);
    this.account = account;
    this.network = network;
    this.isSelf = isSelf;
  }

  /**
   * Clones the {@link AccountUpdate}.
   */
  static clone(accountUpdate: AccountUpdate) {
    let body = cloneCircuitValue(accountUpdate.body);
    let authorization = cloneCircuitValue(accountUpdate.authorization);
    let cloned: AccountUpdate = new (AccountUpdate as any)(
      body,
      authorization,
      accountUpdate.isSelf
    );
    cloned.lazyAuthorization = accountUpdate.lazyAuthorization;
    cloned.children.callsType = accountUpdate.children.callsType;
    cloned.children.accountUpdates = accountUpdate.children.accountUpdates.map(
      AccountUpdate.clone
    );
    cloned.id = accountUpdate.id;
    cloned.label = accountUpdate.label;
    cloned.parent = accountUpdate.parent;
    cloned.isDelegateCall = accountUpdate.isDelegateCall;
    return cloned;
  }

  token() {
    let thisAccountUpdate = this;
    let customToken = new Token({
      tokenOwner: thisAccountUpdate.body.publicKey,
      parentTokenId: thisAccountUpdate.body.tokenId,
    });

    return {
      id: customToken.id,
      parentTokenId: customToken.parentTokenId,
      tokenOwner: customToken.tokenOwner,

      mint({
        address,
        amount,
      }: {
        address: PublicKey;
        amount: number | bigint | UInt64;
      }) {
        let receiver = AccountUpdate.defaultAccountUpdate(address, this.id);
        thisAccountUpdate.approve(receiver);
        // Add the amount to mint to the receiver's account
        receiver.body.balanceChange = Int64.fromObject(
          receiver.body.balanceChange
        ).add(amount);
        return receiver;
      },

      burn({
        address,
        amount,
      }: {
        address: PublicKey;
        amount: number | bigint | UInt64;
      }) {
        let sender = AccountUpdate.defaultAccountUpdate(address, this.id);
        thisAccountUpdate.approve(sender);
        sender.body.useFullCommitment = Bool(true);

        // Sub the amount to burn from the sender's account
        sender.body.balanceChange = Int64.fromObject(
          sender.body.balanceChange
        ).sub(amount);

        // Require signature from the sender account being deducted
        Authorization.setLazySignature(sender);
      },

      send({
        from,
        to,
        amount,
      }: {
        from: PublicKey;
        to: PublicKey;
        amount: number | bigint | UInt64;
      }) {
        // Create a new accountUpdate for the sender to send the amount to the receiver
        let sender = AccountUpdate.defaultAccountUpdate(from, this.id);
        thisAccountUpdate.approve(sender);
        sender.body.useFullCommitment = Bool(true);
        sender.body.balanceChange = Int64.fromObject(
          sender.body.balanceChange
        ).sub(amount);

        // Require signature from the sender accountUpdate
        Authorization.setLazySignature(sender);

        let receiverAccountUpdate = createChildAccountUpdate(
          thisAccountUpdate,
          to,
          this.id
        );

        // Add the amount to send to the receiver's account
        let i1 = receiverAccountUpdate.body.balanceChange;
        receiverAccountUpdate.body.balanceChange = new Int64(
          i1.magnitude,
          i1.sgn
        ).add(amount);
        return receiverAccountUpdate;
      },
    };
  }

  get tokenId() {
    return this.body.tokenId;
  }

  /**
   * @deprecated use `this.account.tokenSymbol`
   */
  get tokenSymbol() {
    let accountUpdate = this;

    return {
      set(tokenSymbol: string) {
        accountUpdate.account.tokenSymbol.set(tokenSymbol);
      },
    };
  }

  send({
    to,
    amount,
  }: {
    to: PublicKey | AccountUpdate | SmartContract;
    amount: number | bigint | UInt64;
  }) {
    let receiver: AccountUpdate;
    if (to instanceof AccountUpdate) {
      receiver = to;
      receiver.body.tokenId.assertEquals(this.body.tokenId);
    } else if (to instanceof SmartContract) {
      receiver = to.self;
      receiver.body.tokenId.assertEquals(this.body.tokenId);
    } else {
      receiver = AccountUpdate.defaultAccountUpdate(to, this.body.tokenId);
      this.approve(receiver);
    }

    // Sub the amount from the sender's account
    this.body.balanceChange = Int64.fromObject(this.body.balanceChange).sub(
      amount
    );
    // Add the amount to the receiver's account
    receiver.body.balanceChange = Int64.fromObject(
      receiver.body.balanceChange
    ).add(amount);
  }

  /**
   * Makes an {@link AccountUpdate} a child-{@link AccountUpdate} of this and approves it.
   */
  approve(
    childUpdate: AccountUpdate,
    layout: AccountUpdatesLayout = AccountUpdate.Layout.NoDelegation
  ) {
    makeChildAccountUpdate(this, childUpdate);
    this.isDelegateCall = Bool(false);
    AccountUpdate.witnessChildren(childUpdate, layout, { skipCheck: true });
  }

  get balance() {
    let accountUpdate = this;

    return {
      addInPlace(x: Int64 | UInt32 | UInt64 | string | number | bigint) {
        let { magnitude, sgn } = accountUpdate.body.balanceChange;
        accountUpdate.body.balanceChange = new Int64(magnitude, sgn).add(x);
      },
      subInPlace(x: Int64 | UInt32 | UInt64 | string | number | bigint) {
        let { magnitude, sgn } = accountUpdate.body.balanceChange;
        accountUpdate.body.balanceChange = new Int64(magnitude, sgn).sub(x);
      },
    };
  }

  get update(): Update {
    return this.body.update;
  }

  static setValue<T>(maybeValue: SetOrKeep<T>, value: T) {
    maybeValue.isSome = Bool(true);
    maybeValue.value = value;
  }

  /** Constrain a property to lie between lower and upper bounds.
   *
   * @param property The property to constrain
   * @param lower The lower bound
   * @param upper The upper bound
   *
   * Example: To constrain the account balance of a SmartContract to lie between 0 and 20 MINA, you can use
   *
   * ```ts
   * \@method onlyRunsWhenBalanceIsLow() {
   *   let lower = UInt64.zero;
   *   let upper = UInt64.from(20e9);
   *   AccountUpdate.assertBetween(this.self.body.preconditions.account.balance, lower, upper);
   *   // ...
   * }
   * ```
   */
  static assertBetween<T>(
    property: OrIgnore<ClosedInterval<T>>,
    lower: T,
    upper: T
  ) {
    property.isSome = Bool(true);
    property.value.lower = lower;
    property.value.upper = upper;
  }

  // TODO: assertGreaterThan, assertLowerThan?

  /** Fix a property to a certain value.
   *
   * @param property The property to constrain
   * @param value The value it is fixed to
   *
   * Example: To fix the account nonce of a SmartContract to 0, you can use
   *
   * ```ts
   * \@method onlyRunsWhenNonceIsZero() {
   *   AccountUpdate.assertEquals(this.self.body.preconditions.account.nonce, UInt32.zero);
   *   // ...
   * }
   * ```
   */
  static assertEquals<T extends object>(
    property: OrIgnore<ClosedInterval<T> | T>,
    value: T
  ) {
    property.isSome = Bool(true);
    if ('lower' in property.value && 'upper' in property.value) {
      property.value.lower = value;
      property.value.upper = value;
    } else {
      property.value = value;
    }
  }

  get publicKey(): PublicKey {
    return this.body.publicKey;
  }

  /**
   * Use this command if this account update should be signed by the account owner,
   * instead of not having any authorization.
   *
   * If you use this and are not relying on a wallet to sign your transaction, then you should use the following code
   * before sending your transaction:
   *
   * ```ts
   * let tx = Mina.transaction(...); // create transaction as usual, using `requireSignature()` somewhere
   * tx.sign([privateKey]); // pass the private key of this account to `sign()`!
   * ```
   *
   * Note that an account's {@link Permissions} determine which updates have to be (can be) authorized by a signature.
   */
  requireSignature() {
    this.sign();
  }
  /**
   * @deprecated `.sign()` is deprecated in favor of `.requireSignature()`
   */
  sign(privateKey?: PrivateKey) {
    let { nonce, isSameAsFeePayer } = AccountUpdate.getSigningInfo(this);
    // if this account is the same as the fee payer, we use the "full commitment" for replay protection
    this.body.useFullCommitment = isSameAsFeePayer;
    // otherwise, we increment the nonce
    let doIncrementNonce = isSameAsFeePayer.not();
    this.body.incrementNonce = doIncrementNonce;
    // in this case, we also have to set a nonce precondition
    let lower = Circuit.if(doIncrementNonce, UInt32, nonce, UInt32.zero);
    let upper = Circuit.if(doIncrementNonce, UInt32, nonce, UInt32.MAXINT());
    this.body.preconditions.account.nonce.isSome = doIncrementNonce;
    this.body.preconditions.account.nonce.value.lower = lower;
    this.body.preconditions.account.nonce.value.upper = upper;
    // set lazy signature
    Authorization.setLazySignature(this, { privateKey });
  }

  static signFeePayerInPlace(
    feePayer: FeePayerUnsigned,
    privateKey?: PrivateKey
  ) {
    feePayer.body.nonce = this.getNonce(feePayer);
    feePayer.authorization = Ledger.dummySignature();
    feePayer.lazyAuthorization = { kind: 'lazy-signature', privateKey };
  }

  static getNonce(accountUpdate: AccountUpdate | FeePayerUnsigned) {
    return AccountUpdate.getSigningInfo(accountUpdate).nonce;
  }

  private static signingInfo = provable({
    nonce: UInt32,
    isSameAsFeePayer: Bool,
  });

  private static getSigningInfo(
    accountUpdate: AccountUpdate | FeePayerUnsigned
  ) {
    return memoizeWitness(AccountUpdate.signingInfo, () =>
      AccountUpdate.getSigningInfoUnchecked(accountUpdate)
    );
  }

  private static getSigningInfoUnchecked(
    update: AccountUpdate | FeePayerUnsigned
  ) {
    let publicKey = update.body.publicKey;
    let tokenId =
      update instanceof AccountUpdate ? update.body.tokenId : TokenId.default;
    let nonce = Number(
      Precondition.getAccountPreconditions(update.body).nonce.toString()
    );
    // if the fee payer is the same account update as this one, we have to start the nonce predicate at one higher,
    // bc the fee payer already increases its nonce
    let isFeePayer = Mina.currentTransaction()?.sender?.equals(publicKey);
    let isSameAsFeePayer = !!isFeePayer
      ?.and(tokenId.equals(TokenId.default))
      .toBoolean();
    if (isSameAsFeePayer) nonce++;
    // now, we check how often this account update already updated its nonce in this tx, and increase nonce from `getAccount` by that amount
    CallForest.forEachPredecessor(
      Mina.currentTransaction.get().accountUpdates,
      update as AccountUpdate,
      (otherUpdate) => {
        let shouldIncreaseNonce = otherUpdate.publicKey
          .equals(publicKey)
          .and(otherUpdate.tokenId.equals(tokenId))
          .and(otherUpdate.body.incrementNonce);
        if (shouldIncreaseNonce.toBoolean()) nonce++;
      }
    );
    return {
      nonce: UInt32.from(nonce),
      isSameAsFeePayer: Bool(isSameAsFeePayer),
    };
  }

  toJSON() {
    return Types.AccountUpdate.toJSON(this);
  }
  static toJSON(a: AccountUpdate) {
    return Types.AccountUpdate.toJSON(a);
  }
  static fromJSON(json: Types.Json.AccountUpdate) {
    let accountUpdate = Types.AccountUpdate.fromJSON(json);
    return new AccountUpdate(accountUpdate.body, accountUpdate.authorization);
  }

  hash() {
    // these two ways of hashing are (and have to be) consistent / produce the same hash
    // TODO: there's no reason anymore to use two different hashing methods here!
    // -- the "inCheckedComputation" branch works in all circumstances now
    // we just leave this here for a couple more weeks, because it checks consistency between
    // JS & OCaml hashing on *every single accountUpdate proof* we create. It will give us 100%
    // confidence that the two implementations are equivalent, and catch regressions quickly
    if (inCheckedComputation()) {
      let input = Types.AccountUpdate.toInput(this);
      return hashWithPrefix(prefixes.body, packToFields(input));
    } else {
      let json = Types.AccountUpdate.toJSON(this);
      return Ledger.hashAccountUpdateFromJson(JSON.stringify(json));
    }
  }

  toPublicInput(): ZkappPublicInput {
    let accountUpdate = this.hash();
    let calls = CallForest.hashChildren(this);
    return { accountUpdate, calls };
  }

  static defaultAccountUpdate(address: PublicKey, tokenId?: Field) {
    const body = Body.keepAll(address);
    if (tokenId) {
      body.tokenId = tokenId;
      body.caller = tokenId;
    }
    return new AccountUpdate(body);
  }
  static dummy() {
    return this.defaultAccountUpdate(PublicKey.empty());
  }
  isDummy() {
    return this.body.publicKey.isEmpty();
  }

  static defaultFeePayer(address: PublicKey, nonce: UInt32): FeePayerUnsigned {
    let body = FeePayerBody.keepAll(address, nonce);
    return {
      body,
      authorization: Ledger.dummySignature(),
      lazyAuthorization: { kind: 'lazy-signature' },
    };
  }

  static dummyFeePayer(): FeePayerUnsigned {
    let body = FeePayerBody.keepAll(PublicKey.empty(), UInt32.zero);
    return { body, authorization: Ledger.dummySignature() };
  }

  /**
   * Creates an account update. If this is inside a transaction, the account update becomes part of the transaction.
   * If this is inside a smart contract method, the account update will not only become part of the transaction, but
   * also becomes available for the smart contract to modify, in a way that becomes part of the proof.
   */
  static create(publicKey: PublicKey, tokenId?: Field) {
    let accountUpdate = AccountUpdate.defaultAccountUpdate(publicKey, tokenId);
    if (smartContractContext.has()) {
      smartContractContext.get().this.self.approve(accountUpdate);
    } else {
      Mina.currentTransaction()?.accountUpdates.push(accountUpdate);
    }
    return accountUpdate;
  }
  /**
   * Attach account update to the current transaction
   * -- if in a smart contract, to its children
   */
  static attachToTransaction(accountUpdate: AccountUpdate) {
    if (smartContractContext.has()) {
      let selfUpdate = smartContractContext.get().this.self;
      // avoid redundant attaching & cycle in account update structure, happens
      // when calling attachToTransaction(this.self) inside a @method
      // TODO avoid account update cycles more generally
      if (selfUpdate === accountUpdate) return;
      smartContractContext.get().this.self.approve(accountUpdate);
    } else {
      if (!Mina.currentTransaction.has()) return;
      let updates = Mina.currentTransaction.get().accountUpdates;
      if (!updates.find((update) => update.id === accountUpdate.id)) {
        updates.push(accountUpdate);
      }
    }
  }
  /**
   * Disattach an account update from where it's currently located in the transaction
   */
  static unlink(accountUpdate: AccountUpdate) {
    let siblings =
      accountUpdate.parent?.children.accountUpdates ??
      Mina.currentTransaction()?.accountUpdates;
    if (siblings === undefined) return;
    let i = siblings?.findIndex((update) => update.id === accountUpdate.id);
    if (i !== undefined && i !== -1) {
      siblings!.splice(i, 1);
    }
    accountUpdate.parent === undefined;
  }

  /**
   * Creates an account update, like {@link AccountUpdate.create}, but also makes sure
   * this account update will be authorized with a signature.
   *
   * If you use this and are not relying on a wallet to sign your transaction, then you should use the following code
   * before sending your transaction:
   *
   * ```ts
   * let tx = Mina.transaction(...); // create transaction as usual, using `createSigned()` somewhere
   * tx.sign([privateKey]); // pass the private key of this account to `sign()`!
   * ```
   *
   * Note that an account's {@link Permissions} determine which updates have to be (can be) authorized by a signature.
   */
  static createSigned(signer: PublicKey, tokenId?: Field): AccountUpdate;
  /**
   * @deprecated in favor of calling this function with a `PublicKey` as `signer`
   */
  static createSigned(signer: PrivateKey, tokenId?: Field): AccountUpdate;
  static createSigned(signer: PrivateKey | PublicKey, tokenId?: Field) {
    let publicKey =
      signer instanceof PrivateKey ? signer.toPublicKey() : signer;
    let accountUpdate = AccountUpdate.create(publicKey, tokenId);
    if (signer instanceof PrivateKey) {
      accountUpdate.sign(signer);
    } else {
      accountUpdate.requireSignature();
    }
    return accountUpdate;
  }

  /**
   * Use this method to pay the account creation fee for another account (or, multiple accounts using the optional second argument).
   *
   * Beware that you _don't_ need to specify the account that is created!
   * Instead, the protocol will automatically identify that accounts need to be created,
   * and require that the net balance change of the transaction covers the account creation fee.
   *
   * @param feePayer the address of the account that pays the fee
   * @param numberOfAccounts the number of new accounts to fund (default: 1)
   * @returns they {@link AccountUpdate} for the account which pays the fee
   */
  static fundNewAccount(
    feePayer: PublicKey,
    numberOfAccounts?: number
  ): AccountUpdate;
  /**
   * @deprecated Call this function with a `PublicKey` as `feePayer`, and remove the `initialBalance` option.
   * To send an initial balance to the new account, you can use the returned account update:
   * ```
   * let feePayerUpdate = AccountUpdate.fundNewAccount(feePayer);
   * feePayerUpdate.send({ to: receiverAddress, amount: initialBalance });
   * ```
   */
  static fundNewAccount(
    feePayer: PrivateKey | PublicKey,
    options?: { initialBalance: number | string | UInt64 } | number
  ): AccountUpdate;
  static fundNewAccount(
    feePayer: PrivateKey | PublicKey,
    numberOfAccounts?: number | { initialBalance: number | string | UInt64 }
  ) {
    let accountUpdate = AccountUpdate.createSigned(feePayer as PrivateKey);
    let fee = Mina.accountCreationFee();
    numberOfAccounts ??= 1;
    if (typeof numberOfAccounts === 'number') fee = fee.mul(numberOfAccounts);
    else fee = fee.add(UInt64.from(numberOfAccounts.initialBalance ?? 0));
    accountUpdate.balance.subInPlace(fee);
    return accountUpdate;
  }

  // static methods that implement Provable<{ accountUpdate: AccountUpdate, isDelegateCall: Bool }>
  private static provable = provable({
    accountUpdate: Types.AccountUpdate,
    isDelegateCall: Bool,
  });
  private toProvable() {
    return { accountUpdate: this, isDelegateCall: this.isDelegateCall };
  }

  static sizeInFields = AccountUpdate.provable.sizeInFields;

  static toFields(a: AccountUpdate) {
    return AccountUpdate.provable.toFields(a.toProvable());
  }
  static toAuxiliary(a?: AccountUpdate) {
    let aux = AccountUpdate.provable.toAuxiliary(a?.toProvable());
    let children: AccountUpdate['children'] = {
      callsType: { type: 'None' },
      accountUpdates: [],
    };
    let lazyAuthorization = a && a.lazyAuthorization;
    if (a) {
      children.callsType = a.children.callsType;
      children.accountUpdates = a.children.accountUpdates.map(
        AccountUpdate.clone
      );
    }
    let parent = a?.parent;
    let id = a?.id ?? Math.random();
    let label = a?.label ?? '';
    return [{ lazyAuthorization, children, parent, id, label }, aux];
  }
  static toInput(a: AccountUpdate) {
    return AccountUpdate.provable.toInput(a.toProvable());
  }
  static check(a: AccountUpdate) {
    AccountUpdate.provable.check(a.toProvable());
  }
  static fromFields(fields: Field[], [other, aux]: any[]): AccountUpdate {
    let { accountUpdate, isDelegateCall } = AccountUpdate.provable.fromFields(
      fields,
      aux
    );
    return Object.assign(
      new AccountUpdate(accountUpdate.body, accountUpdate.authorization),
      { isDelegateCall },
      other
    );
  }

  static witness<T>(
    type: FlexibleProvable<T>,
    compute: () => { accountUpdate: AccountUpdate; result: T },
    { skipCheck = false } = {}
  ) {
    // construct the circuit type for a accountUpdate + other result
    let accountUpdateType = skipCheck
      ? { ...provable(AccountUpdate), check() {} }
      : AccountUpdate;
    let combinedType = provable({
      accountUpdate: accountUpdateType,
      result: type as any,
    });
    return Circuit.witness(combinedType, compute);
  }

  static witnessChildren(
    accountUpdate: AccountUpdate,
    childLayout: AccountUpdatesLayout,
    options?: { skipCheck: boolean }
  ) {
    // just witness children's hash if childLayout === null
    if (childLayout === AccountUpdate.Layout.AnyChildren) {
      accountUpdate.children.callsType = { type: 'Witness' };
      return;
    }
    if (childLayout === AccountUpdate.Layout.NoDelegation) {
      accountUpdate.children.callsType = { type: 'Witness' };
      accountUpdate.isDelegateCall.assertFalse();
      return;
    }
    let childArray: AccountUpdatesLayout[] =
      typeof childLayout === 'number'
        ? Array(childLayout).fill(AccountUpdate.Layout.NoChildren)
        : childLayout;
    let n = childArray.length;
    for (let i = 0; i < n; i++) {
      accountUpdate.children.accountUpdates[i] = AccountUpdate.witnessTree(
        provable(null),
        childArray[i],
        () => ({
          accountUpdate:
            accountUpdate.children.accountUpdates[i] ?? AccountUpdate.dummy(),
          result: null,
        }),
        options
      ).accountUpdate;
    }
    if (n === 0) {
      accountUpdate.children.callsType = {
        type: 'Equals',
        value: CallForest.emptyHash(),
      };
    }
  }

  /**
   * Like AccountUpdate.witness, but lets you specify a layout for the accountUpdate's children,
   * which also get witnessed
   */
  static witnessTree<T>(
    resultType: FlexibleProvable<T>,
    childLayout: AccountUpdatesLayout,
    compute: () => { accountUpdate: AccountUpdate; result: T },
    options?: { skipCheck: boolean }
  ) {
    // witness the root accountUpdate
    let { accountUpdate, result } = AccountUpdate.witness(
      resultType,
      compute,
      options
    );
    // witness child account updates
    AccountUpdate.witnessChildren(accountUpdate, childLayout, options);
    return { accountUpdate, result };
  }

  /**
   * Describes the children of an account update, which are laid out in a tree.
   *
   * The tree layout is described recursively by using a combination of `AccountUpdate.Layout.NoChildren`, `AccountUpdate.Layout.StaticChildren(...)` and `AccountUpdate.Layout.AnyChildren`.
   * - `NoChildren` means an account update that can't have children
   * - `AnyChildren` means an account update can have an arbitrary amount of children, which means you can't access those children in your circuit (because the circuit is static).
   * - `StaticChildren` means the account update must have a certain static amount of children and expects as arguments a description of each of those children.
   *   As a shortcut, you can also pass `StaticChildren` a number, which means it has that amount of children but no grandchildren.
   *
   * This is best understood by examples:
   *
   * ```ts
   * let { NoChildren, AnyChildren, StaticChildren } = AccounUpdate.Layout;
   *
   * NoChildren                 // an account update with no children
   * AnyChildren                // an account update with arbitrary children
   * StaticChildren(NoChildren) // an account update with 1 child, which doesn't have children itself
   * StaticChildren(1)          // shortcut for StaticChildren(NoChildren)
   * StaticChildren(2)          // shortcut for StaticChildren(NoChildren, NoChildren)
   * StaticChildren(0)          // equivalent to NoChildren
   *
   * // an update with 2 children, of which one has arbitrary children and the other has exactly 1 descendant
   * StaticChildren(AnyChildren, StaticChildren(1))
   * ```
   */
  static Layout = {
    StaticChildren: ((...args: any[]) => {
      if (args.length === 1 && typeof args[0] === 'number') return args[0];
      if (args.length === 0) return 0;
      return args;
    }) as {
      (n: number): AccountUpdatesLayout;
      (...args: AccountUpdatesLayout[]): AccountUpdatesLayout;
    },
    NoChildren: 0,
    AnyChildren: 'AnyChildren' as const,
    NoDelegation: 'NoDelegation' as const,
  };
  /**
   * Returns a JSON representation of only the fields that differ from the default {@link AccountUpdate}.
   */
  toPretty() {
    function short(s: string) {
      return '..' + s.slice(-4);
    }
    let jsonUpdate: Partial<Types.Json.AccountUpdate> = toJSONEssential(
      jsLayout.AccountUpdate as any,
      this
    );
    let body: Partial<Types.Json.AccountUpdate['body']> =
      jsonUpdate.body as any;
    delete body.callData;
    body.publicKey = short(body.publicKey!);
    if (body.balanceChange?.magnitude === '0') delete body.balanceChange;
    if (body.tokenId === TokenId.toBase58(TokenId.default)) {
      delete body.tokenId;
    } else {
      body.tokenId = short(body.tokenId!);
    }
    if (body.callDepth === 0) delete body.callDepth;
    if (body.caller === TokenId.toBase58(TokenId.default)) {
      delete body.caller;
    } else {
      body.caller = short(body.caller!);
    }
    if (body.incrementNonce === false) delete body.incrementNonce;
    if (body.useFullCommitment === false) delete body.useFullCommitment;
    if (body.events?.length === 0) delete body.events;
    if (body.sequenceEvents?.length === 0) delete body.sequenceEvents;
    if (body.preconditions?.account) {
      body.preconditions.account = JSON.stringify(
        body.preconditions.account
      ) as any;
    }
    if (body.preconditions?.network) {
      body.preconditions.network = JSON.stringify(
        body.preconditions.network
      ) as any;
    }
    if (jsonUpdate.authorization?.proof) {
      jsonUpdate.authorization.proof = short(jsonUpdate.authorization.proof);
    }
    if (jsonUpdate.authorization?.signature) {
      jsonUpdate.authorization.signature = short(
        jsonUpdate.authorization.signature
      );
    }
    if (body.update?.verificationKey) {
      body.update.verificationKey = JSON.stringify({
        data: short(body.update.verificationKey.data),
        hash: short(body.update.verificationKey.hash),
      }) as any;
    }
    for (let key of ['permissions', 'appState', 'timing'] as const) {
      if (body.update?.[key]) {
        body.update[key] = JSON.stringify(body.update[key]) as any;
      }
    }
    for (let key of ['events', 'sequenceEvents'] as const) {
      if (body[key]) {
        body[key] = JSON.stringify(body[key]) as any;
      }
    }
    if (
      jsonUpdate.authorization !== undefined ||
      body.authorizationKind !== 'None_given'
    ) {
      (body as any).authorization = jsonUpdate.authorization;
    }
    if (this.isDelegateCall.toBoolean()) (body as any).isDelegateCall = true;
    let pretty: any = { ...body };
    let withId = false;
    if (withId) pretty = { id: Math.floor(this.id * 1000), ...pretty };
    if (this.label) pretty = { label: this.label, ...pretty };
    return pretty;
  }
}

type AccountUpdatesLayout =
  | number
  | 'AnyChildren'
  | 'NoDelegation'
  | AccountUpdatesLayout[];

const CallForest = {
  // similar to Mina_base.ZkappCommand.Call_forest.to_account_updates_list
  // takes a list of accountUpdates, which each can have children, so they form a "forest" (list of trees)
  // returns a flattened list, with `accountUpdate.body.callDepth` specifying positions in the forest
  // also removes any "dummy" accountUpdates
  toFlatList(forest: AccountUpdate[], depth = 0): AccountUpdate[] {
    let accountUpdates = [];
    for (let accountUpdate of forest) {
      if (accountUpdate.isDummy().toBoolean()) continue;
      accountUpdate.body.callDepth = depth;
      let children = accountUpdate.children.accountUpdates;
      accountUpdates.push(
        accountUpdate,
        ...CallForest.toFlatList(children, depth + 1)
      );
    }
    return accountUpdates;
  },

  // Mina_base.Zkapp_command.Digest.Forest.empty
  emptyHash() {
    return Field(0);
  },

  // similar to Mina_base.Zkapp_command.Call_forest.accumulate_hashes
  // hashes a accountUpdate's children (and their children, and ...) to compute the `calls` field of ZkappPublicInput
  hashChildren(update: AccountUpdate): Field {
    let { callsType } = update.children;
    // compute hash outside the circuit if callsType is "Witness"
    // i.e., allowing accountUpdates with arbitrary children
    if (callsType.type === 'Witness') {
      return Circuit.witness(Field, () => CallForest.hashChildrenBase(update));
    }
    let calls = CallForest.hashChildrenBase(update);
    if (callsType.type === 'Equals' && inCheckedComputation()) {
      calls.assertEquals(callsType.value);
    }
    return calls;
  },

  hashChildrenBase({ children }: AccountUpdate) {
    let stackHash = CallForest.emptyHash();
    for (let accountUpdate of [...children.accountUpdates].reverse()) {
      let calls = CallForest.hashChildren(accountUpdate);
      let nodeHash = hashWithPrefix(prefixes.accountUpdateNode, [
        accountUpdate.hash(),
        calls,
      ]);
      let newHash = hashWithPrefix(prefixes.accountUpdateCons, [
        nodeHash,
        stackHash,
      ]);
      // skip accountUpdate if it's a dummy
      stackHash = Circuit.if(accountUpdate.isDummy(), stackHash, newHash);
    }
    return stackHash;
  },

  // Mina_base.Zkapp_command.Call_forest.add_callers
  addCallers(
    updates: AccountUpdate[],
    context: { self: Field; caller: Field } = {
      self: TokenId.default,
      caller: TokenId.default,
    }
  ) {
    for (let update of updates) {
      let { isDelegateCall } = update;
      let caller = Circuit.if(isDelegateCall, context.caller, context.self);
      let self = Circuit.if(
        isDelegateCall,
        context.self,
        Token.getId(update.body.publicKey, update.body.tokenId)
      );
      update.body.caller = caller;
      let childContext = { caller, self };
      CallForest.addCallers(update.children.accountUpdates, childContext);
    }
  },
  /**
   * Used in the prover to witness the context from which to compute its caller
   */
  computeCallerContext(update: AccountUpdate) {
    // compute the line of ancestors
    let current = update;
    let ancestors = [];
    while (true) {
      let parent = current.parent;
      if (parent === undefined) break;
      ancestors.unshift(parent);
      current = parent;
    }
    let context = { self: TokenId.default, caller: TokenId.default };
    for (let update of ancestors) {
      if (!update.isDelegateCall.toBoolean()) {
        context.caller = context.self;
        context.self = Token.getId(update.body.publicKey, update.body.tokenId);
      }
    }
    return context;
  },
  callerContextType: provablePure({ self: Field, caller: Field }),

  computeCallDepth(update: AccountUpdate) {
    for (let callDepth = 0; ; callDepth++) {
      if (update.parent === undefined) return callDepth;
      update = update.parent;
    }
  },

  forEach(updates: AccountUpdate[], callback: (update: AccountUpdate) => void) {
    for (let update of updates) {
      callback(update);
      CallForest.forEach(update.children.accountUpdates, callback);
    }
  },

  forEachPredecessor(
    updates: AccountUpdate[],
    update: AccountUpdate,
    callback: (update: AccountUpdate) => void
  ) {
    let isPredecessor = true;
    CallForest.forEach(updates, (otherUpdate) => {
      if (otherUpdate.id === update.id) isPredecessor = false;
      if (isPredecessor) callback(otherUpdate);
    });
  },
};

function createChildAccountUpdate(
  parent: AccountUpdate,
  childAddress: PublicKey,
  tokenId?: Field
) {
  let child = AccountUpdate.defaultAccountUpdate(childAddress, tokenId);
  makeChildAccountUpdate(parent, child);
  return child;
}
function makeChildAccountUpdate(parent: AccountUpdate, child: AccountUpdate) {
  child.body.callDepth = parent.body.callDepth + 1;
  let wasChildAlready = parent.children.accountUpdates.find(
    (update) => update.id === child.id
  );
  // add to our children if not already here
  if (!wasChildAlready) {
    parent.children.accountUpdates.push(child);
    // remove the child from the top level list / its current parent
    AccountUpdate.unlink(child);
  }
  child.parent = parent;
}

// authorization

type ZkappCommand = {
  feePayer: FeePayerUnsigned;
  accountUpdates: AccountUpdate[];
  memo: string;
};
type ZkappCommandSigned = {
  feePayer: FeePayer;
  accountUpdates: (AccountUpdate & { lazyAuthorization?: LazyProof })[];
  memo: string;
};
type ZkappCommandProved = {
  feePayer: FeePayerUnsigned;
  accountUpdates: (AccountUpdate & { lazyAuthorization?: LazySignature })[];
  memo: string;
};

const ZkappCommand = {
  toPretty(transaction: ZkappCommand) {
    let feePayer = ZkappCommand.toJSON(transaction).feePayer as any;
    feePayer.body.publicKey = '..' + feePayer.body.publicKey.slice(-4);
    feePayer.body.authorization = '..' + feePayer.authorization.slice(-4);
    if (feePayer.body.validUntil === null) delete feePayer.body.validUntil;
    return [
      feePayer.body,
      ...transaction.accountUpdates.map((a) => a.toPretty()),
    ];
  },
  fromJSON(json: Types.Json.ZkappCommand): ZkappCommand {
    let { feePayer } = Types.ZkappCommand.fromJSON({
      feePayer: json.feePayer,
      accountUpdates: [],
      memo: json.memo,
    });
    let memo = Memo.toString(Memo.fromBase58(json.memo));
    let accountUpdates = json.accountUpdates.map(AccountUpdate.fromJSON);
    return { feePayer, accountUpdates, memo };
  },
  toJSON({ feePayer, accountUpdates, memo }: ZkappCommand) {
    memo = Ledger.memoToBase58(memo);
    return Types.ZkappCommand.toJSON({ feePayer, accountUpdates, memo });
  },
};

const Authorization = {
  hasLazyProof(accountUpdate: AccountUpdate) {
    return accountUpdate.lazyAuthorization?.kind === 'lazy-proof';
  },
  hasAny(accountUpdate: AccountUpdate) {
    let { authorization: auth, lazyAuthorization: lazyAuth } = accountUpdate;
    return !!(lazyAuth || 'proof' in auth || 'signature' in auth);
  },
  setSignature(accountUpdate: AccountUpdate, signature: string) {
    accountUpdate.authorization = { signature };
    accountUpdate.lazyAuthorization = undefined;
  },
  setProof(accountUpdate: AccountUpdate, proof: string) {
    accountUpdate.authorization = { proof };
    accountUpdate.lazyAuthorization = undefined;
  },
  setLazySignature(
    accountUpdate: AccountUpdate,
    signature?: Omit<LazySignature, 'kind'>
  ) {
    signature ??= {};
    accountUpdate.body.authorizationKind.isSigned = Bool(true);
    accountUpdate.body.authorizationKind.isProved = Bool(false);
    accountUpdate.authorization = {};
    accountUpdate.lazyAuthorization = { ...signature, kind: 'lazy-signature' };
  },
  setLazyProof(accountUpdate: AccountUpdate, proof: Omit<LazyProof, 'kind'>) {
    accountUpdate.body.authorizationKind.isSigned = Bool(false);
    accountUpdate.body.authorizationKind.isProved = Bool(true);
    accountUpdate.authorization = {};
    accountUpdate.lazyAuthorization = { ...proof, kind: 'lazy-proof' };
  },
  setLazyNone(accountUpdate: AccountUpdate) {
    accountUpdate.body.authorizationKind.isSigned = Bool(false);
    accountUpdate.body.authorizationKind.isProved = Bool(false);
    accountUpdate.authorization = {};
    accountUpdate.lazyAuthorization = { kind: 'lazy-none' };
  },
};

function addMissingSignatures(
  zkappCommand: ZkappCommand,
  additionalKeys = [] as PrivateKey[]
): ZkappCommandSigned {
  let additionalPublicKeys = additionalKeys.map((sk) => sk.toPublicKey());
  let { commitment, fullCommitment } = Ledger.transactionCommitments(
    JSON.stringify(ZkappCommand.toJSON(zkappCommand))
  );
  function addFeePayerSignature(accountUpdate: FeePayerUnsigned): FeePayer {
    let { body, authorization, lazyAuthorization } =
      cloneCircuitValue(accountUpdate);
    if (lazyAuthorization === undefined) return { body, authorization };
    let { privateKey } = lazyAuthorization;
    if (privateKey === undefined) {
      let i = additionalPublicKeys.findIndex((pk) =>
        pk.equals(accountUpdate.body.publicKey).toBoolean()
      );
      if (i === -1) {
        let pk = PublicKey.toBase58(accountUpdate.body.publicKey);
        throw Error(
          `addMissingSignatures: Cannot add signature for fee payer (${pk}), private key is missing.`
        );
      }
      privateKey = additionalKeys[i];
    }
    let signature = Ledger.signFieldElement(fullCommitment, privateKey, false);
    return { body, authorization: signature };
  }

  function addSignature(accountUpdate: AccountUpdate) {
    accountUpdate = AccountUpdate.clone(accountUpdate);
    if (accountUpdate.lazyAuthorization?.kind !== 'lazy-signature') {
      return accountUpdate as AccountUpdate & { lazyAuthorization?: LazyProof };
    }
    let { privateKey } = accountUpdate.lazyAuthorization;
    if (privateKey === undefined) {
      let i = additionalPublicKeys.findIndex((pk) =>
        pk.equals(accountUpdate.body.publicKey).toBoolean()
      );
      if (i === -1)
        throw Error(
          `addMissingSignatures: Cannot add signature for ${accountUpdate.publicKey.toBase58()}, private key is missing.`
        );
      privateKey = additionalKeys[i];
    }
    let transactionCommitment = accountUpdate.body.useFullCommitment.toBoolean()
      ? fullCommitment
      : commitment;
    let signature = Ledger.signFieldElement(
      transactionCommitment,
      privateKey,
      false
    );
    Authorization.setSignature(accountUpdate, signature);
    return accountUpdate as AccountUpdate & { lazyAuthorization: undefined };
  }
  let { feePayer, accountUpdates, memo } = zkappCommand;
  return {
    feePayer: addFeePayerSignature(feePayer),
    accountUpdates: accountUpdates.map(addSignature),
    memo,
  };
}

/**
 * The public input for zkApps consists of certain hashes of the proving AccountUpdate (and its child accountUpdates) which is constructed during method execution.

  For SmartContract proving, a method is run twice: First outside the proof, to obtain the public input, and once in the prover,
  which takes the public input as input. The current transaction is hashed again inside the prover, which asserts that the result equals the input public input,
  as part of the snark circuit. The block producer will also hash the transaction they receive and pass it as a public input to the verifier.
  Thus, the transaction is fully constrained by the proof - the proof couldn't be used to attest to a different transaction.
 */
type ZkappPublicInput = { accountUpdate: Field; calls: Field };
let ZkappPublicInput = provablePure(
  { accountUpdate: Field, calls: Field },
  { customObjectKeys: ['accountUpdate', 'calls'] }
);

async function addMissingProofs(
  zkappCommand: ZkappCommand,
  { proofsEnabled = true }
): Promise<{
  zkappCommand: ZkappCommandProved;
  proofs: (Proof<ZkappPublicInput> | undefined)[];
}> {
  type AccountUpdateProved = AccountUpdate & {
    lazyAuthorization?: LazySignature;
  };

  async function addProof(index: number, accountUpdate: AccountUpdate) {
    accountUpdate = AccountUpdate.clone(accountUpdate);

    if (accountUpdate.lazyAuthorization?.kind !== 'lazy-proof') {
      return {
        accountUpdateProved: accountUpdate as AccountUpdateProved,
        proof: undefined,
      };
    }
    if (!proofsEnabled) {
      Authorization.setProof(accountUpdate, Pickles.dummyBase64Proof());
      return {
        accountUpdateProved: accountUpdate as AccountUpdateProved,
        proof: undefined,
      };
    }
    let {
      methodName,
      args,
      previousProofs,
      ZkappClass,
      memoized,
      blindingValue,
    } = accountUpdate.lazyAuthorization;
    let publicInput = accountUpdate.toPublicInput();
    let publicInputFields = ZkappPublicInput.toFields(publicInput);
    if (ZkappClass._provers === undefined)
      throw Error(
        `Cannot prove execution of ${methodName}(), no prover found. ` +
          `Try calling \`await ${ZkappClass.name}.compile()\` first, this will cache provers in the background.`
      );
    let provers = ZkappClass._provers;
    let methodError =
      `Error when computing proofs: Method ${methodName} not found. ` +
      `Make sure your environment supports decorators, and annotate with \`@method ${methodName}\`.`;
    if (ZkappClass._methods === undefined) throw Error(methodError);
    let i = ZkappClass._methods.findIndex((m) => m.methodName === methodName);
    if (i === -1) throw Error(methodError);
    let [, [, proof]] = await zkAppProver.run(
      [accountUpdate.publicKey, accountUpdate.tokenId, ...args],
      { transaction: zkappCommand, accountUpdate, index },
      () =>
        memoizationContext.runWithAsync(
          { memoized, currentIndex: 0, blindingValue },
          async () => {
            try {
              return await provers[i](publicInputFields, previousProofs);
            } catch (err) {
              console.error(
                `Error when proving ${ZkappClass.name}.${methodName}()`
              );
              throw err;
            }
          }
        )
    );
    Authorization.setProof(
      accountUpdate,
      Pickles.proofToBase64Transaction(proof)
    );
    let maxProofsVerified = ZkappClass._maxProofsVerified!;
    const Proof = ZkappClass.Proof();
    return {
      accountUpdateProved: accountUpdate as AccountUpdateProved,
      proof: new Proof({ publicInput, proof, maxProofsVerified }),
    };
  }

  let { feePayer, accountUpdates, memo } = zkappCommand;
  // compute proofs serially. in parallel would clash with our global variable hacks
  let accountUpdatesProved: AccountUpdateProved[] = [];
  let proofs: (Proof<ZkappPublicInput> | undefined)[] = [];
  for (let i = 0; i < accountUpdates.length; i++) {
    let { accountUpdateProved, proof } = await addProof(i, accountUpdates[i]);
    accountUpdatesProved.push(accountUpdateProved);
    proofs.push(proof);
  }
  return {
    zkappCommand: { feePayer, accountUpdates: accountUpdatesProved, memo },
    proofs,
  };
}

/**
 * Sign all accountUpdates of a transaction which belong to the account determined by [[ `privateKey` ]].
 * @returns the modified transaction JSON
 */
function signJsonTransaction(
  transactionJson: string,
  privateKey: PrivateKey | string
) {
  if (typeof privateKey === 'string')
    privateKey = PrivateKey.fromBase58(privateKey);
  let publicKey = privateKey.toPublicKey().toBase58();
  let zkappCommand: Types.Json.ZkappCommand = JSON.parse(transactionJson);
  let feePayer = zkappCommand.feePayer;
  if (feePayer.body.publicKey === publicKey) {
    zkappCommand = JSON.parse(
      Ledger.signFeePayer(JSON.stringify(zkappCommand), privateKey)
    );
  }
  for (let i = 0; i < zkappCommand.accountUpdates.length; i++) {
    let accountUpdate = zkappCommand.accountUpdates[i];
    if (
      accountUpdate.body.publicKey === publicKey &&
      accountUpdate.authorization.proof === null
    ) {
      zkappCommand = JSON.parse(
        Ledger.signOtherAccountUpdate(
          JSON.stringify(zkappCommand),
          privateKey,
          i
        )
      );
    }
  }
  return JSON.stringify(zkappCommand);
}