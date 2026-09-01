/**
 * SP9 — are ER transaction fees really zero, and does the ER really skip fee-payer
 * validation? The whole session-wallet design (a browser key that never holds SOL)
 * rests on both halves. SP10 — can a stranger undelegate a live match's accounts?
 *
 * Both run against real devnet and the real `devnet-as` ER. Everything is built with
 * `@heartrot/client`, so a bug in the hand-written encoders surfaces here.
 *
 * Usage:  node <bundled js> [arenaId]
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageEncoder,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';

import {
  DEVNET_AS_IDENTITY,
  MAGIC_CONTEXT_ID,
  MAGIC_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  confirmSignature,
  createRpc,
  delegate,
  getDelegationStatus,
  getRoutes,
  initArena,
  matchPdas,
  movePlayer,
  sendInstructions,
  settle,
} from '../../packages/client/src/index';

// ---------------------------------------------------------------------------
// Fixed inputs
// ---------------------------------------------------------------------------

const PROGRAM_ID = 'JCfWB9zDXYqAv2or2GVriN39enEudWstz3M8sKvVkzc5' as Address;
const BASE_URL = 'https://api.devnet.solana.com';
const COMPUTE_BUDGET_ID = 'ComputeBudget111111111111111111111111111111' as Address;
const DELEGATION_PROGRAM_ID = 'DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh' as Address;

/** `ephemeral-rollups-pinocchio` `consts::EXTERNAL_UNDELEGATE_DISCRIMINATOR`. */
const EXTERNAL_UNDELEGATE_DISCRIMINATOR = new Uint8Array([196, 28, 41, 206, 48, 37, 51, 167]);

const ARENA_ID = BigInt(process.argv[2] ?? '990001');

const base64 = getBase64Decoder();

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

const transcript: unknown[] = [];

function log(step: string, detail: unknown): void {
  transcript.push({ step, detail });
  console.log(`\n### ${step}\n${JSON.stringify(detail, jsonSafe, 2)}`);
}

function jsonSafe(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, context: (value as { context?: unknown }).context };
  }
  return value;
}

// ---------------------------------------------------------------------------
// Raw JSON-RPC — the verbatim server response, which is the point of this spike
// ---------------------------------------------------------------------------

async function raw(url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return response.json();
}

// ---------------------------------------------------------------------------
// Local transaction plumbing
//
// `sendInstructions` hardcodes `skipPreflight: true`, which is correct for gameplay and
// useless for observing a rejection: the node answers with a signature and the failure
// never comes back. Every path that must SEE the refusal builds and signs here, then
// submits with preflight on.
// ---------------------------------------------------------------------------

type Blockhash = { blockhash: string; lastValidBlockHeight: bigint };

async function latestBlockhash(url: string): Promise<Blockhash> {
  const body = (await raw(url, 'getLatestBlockhash', [{ commitment: 'confirmed' }])) as {
    result: { value: { blockhash: string; lastValidBlockHeight: number } };
  };
  return {
    blockhash: body.result.value.blockhash,
    lastValidBlockHeight: BigInt(body.result.value.lastValidBlockHeight),
  };
}

function buildMessage(
  feePayer: TransactionSigner,
  lifetime: Blockhash,
  instructions: readonly Instruction[],
  version: 0 | 'legacy' = 0,
) {
  return pipe(
    createTransactionMessage({ version } as never),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime as never, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
}

/** Base64 of the *compiled message* — what `getFeeForMessage` wants. */
function messageBase64(
  feePayer: TransactionSigner,
  lifetime: Blockhash,
  instructions: readonly Instruction[],
  version: 0 | 'legacy' = 0,
): string {
  const compiled = compileTransactionMessage(
    buildMessage(feePayer, lifetime, instructions, version),
  );
  return base64.decode(getCompiledTransactionMessageEncoder().encode(compiled));
}

async function signWire(
  feePayer: TransactionSigner,
  lifetime: Blockhash,
  instructions: readonly Instruction[],
): Promise<{ wire: string; signature: string; keys: number }> {
  const message = buildMessage(feePayer, lifetime, instructions);
  const signed = await signTransactionMessageWithSigners(message);
  const compiled = compileTransactionMessage(message);
  return {
    wire: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed),
    keys: compiled.staticAccounts.length,
  };
}

/** `SetComputeUnitLimit` — tag 2, u32 LE. `delegate` does ~12 CPIs and blows 200k CU. */
function computeUnitLimit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_ID, accounts: [], data };
}

async function loadSigner(path: string): Promise<TransactionSigner> {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]);
  return createKeyPairSignerFromBytes(bytes);
}

type AccountSummary = { owner: string; lamports: number; space: number } | null;

async function accountInfo(url: string, address: Address): Promise<AccountSummary> {
  const body = (await raw(url, 'getAccountInfo', [
    address,
    { encoding: 'base64', commitment: 'confirmed' },
  ])) as { result?: { value: { owner: string; lamports: number; space: number } | null } };
  return body.result?.value ?? null;
}

async function accountOwner(url: string, address: Address): Promise<string | null> {
  return (await accountInfo(url, address))?.owner ?? null;
}

/**
 * Solana's *default* rent-exemption formula: `(128 + space) × 3480 × 2`.
 *
 * Devnet does not use it. `getMinimumBalanceForRentExemption(1160)` answers 8,156,904 on
 * devnet where this returns 8,964,480 — devnet's `lamports_per_byte_year` is ~9% lower.
 * The ER validator computes rent with the default, so an account funded to the base
 * layer's own minimum is *not* rent-exempt in the ER's opinion and the cloner refuses it.
 */
function defaultRentExempt(space: number): number {
  return (128 + space) * 6960;
}

/** Bare `SystemProgram::Transfer` — tag 2 u32 LE, then lamports u64 LE. */
function transfer(from: Address, to: Address, lamports: number): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, BigInt(lamports), true);
  return {
    programAddress: SYSTEM_PROGRAM_ID,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

/**
 * Send through the REAL client and wait for the outcome. Returns the signature on
 * success, or the error text — `confirmSignature` throws with the on-chain `err` JSON,
 * which is the only diagnostic a `skipPreflight` send ever produces.
 */
async function clientSendAndConfirm(
  rpc: ReturnType<typeof createRpc>,
  feePayer: TransactionSigner,
  instructions: readonly Instruction[],
): Promise<{ ok: boolean; signature?: string; error?: string }> {
  try {
    const signature = await sendInstructions(rpc, feePayer, instructions);
    try {
      await confirmSignature(rpc, signature, { timeoutMs: 25_000, pollMs: 400 });
      return { ok: true, signature };
    } catch (error) {
      return { ok: false, signature, error: (error as Error).message };
    }
  } catch (error) {
    return { ok: false, error: JSON.stringify(error, jsonSafe) };
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const treasury = await loadSigner(`${homedir()}/.config/heartrot/treasury.json`);
  const payer = await loadSigner(`${homedir()}/.config/solana/id.json`);
  const stranger = await generateKeyPairSigner();
  const session = await generateKeyPairSigner();

  const { arena, boss, players } = await matchPdas(PROGRAM_ID, ARENA_ID);

  const routes = await getRoutes();
  const route = routes.find((r) => r.identity === DEVNET_AS_IDENTITY);
  if (route === undefined) throw new Error('devnet-as is not in getRoutes');
  const ER_URL = route.fqdn;

  log('setup', {
    programId: PROGRAM_ID,
    arenaId: ARENA_ID,
    arena,
    boss,
    players,
    treasury: treasury.address,
    payer: payer.address,
    stranger: stranger.address,
    session: session.address,
    routes,
    erUrl: ER_URL,
  });

  const baseRpc = createRpc(BASE_URL);
  const erRpc = createRpc(ER_URL);

  // -------------------------------------------------------------------------
  // Setup: an arena that really exists and is really delegated.
  // -------------------------------------------------------------------------

  if ((await accountOwner(BASE_URL, arena)) === null) {
    const ix = initArena({
      programId: PROGRAM_ID,
      payer: treasury.address,
      arena,
      boss,
      players,
      arenaId: ARENA_ID,
      incarnation: 1,
      validatorIdentity: DEVNET_AS_IDENTITY,
      crankAuthority: treasury.address,
    });
    const result = await clientSendAndConfirm(baseRpc, treasury, [ix]);
    log('setup/init_arena', result);
    if (!result.ok) throw new Error('init_arena failed');
  } else {
    log('setup/init_arena', 'arena already exists — reusing');
  }

  if ((await accountOwner(BASE_URL, arena)) !== DELEGATION_PROGRAM_ID) {
    const ix = await delegate({
      programId: PROGRAM_ID,
      payer: treasury.address,
      arena,
      boss,
      players,
    });
    const result = await clientSendAndConfirm(baseRpc, treasury, [
      computeUnitLimit(1_000_000),
      ix,
    ]);
    log('setup/delegate', { accountsInIx: ix.accounts.length, ...result });
    if (!result.ok) throw new Error('delegate failed');
  } else {
    log('setup/delegate', 'already delegated — reusing');
  }

  log('setup/delegation-status', {
    arena: await getDelegationStatus(arena),
    boss: await getDelegationStatus(boss),
    players: await getDelegationStatus(players),
    baseOwner: await accountOwner(BASE_URL, arena),
    erOwner: await accountOwner(ER_URL, arena),
  });

  // -------------------------------------------------------------------------
  // The ER refuses to clone an account it considers not rent-exempt, and it uses the
  // DEFAULT rent schedule while devnet uses a ~9% cheaper one. Every account created
  // with devnet's own `getMinimumBalanceForRentExemption` is therefore short. Top up
  // the difference on the base layer and see whether the cloner then accepts them.
  // -------------------------------------------------------------------------

  const shortfalls: Record<string, unknown>[] = [];
  const topUps: Instruction[] = [];
  for (const [name, address] of [
    ['arena', arena],
    ['boss', boss],
    ['players', players],
  ] as const) {
    const info = await accountInfo(BASE_URL, address);
    if (info === null) throw new Error(`${name} vanished from the base layer`);
    const required = defaultRentExempt(info.space);
    const devnetMinimum = (
      (await raw(BASE_URL, 'getMinimumBalanceForRentExemption', [info.space])) as {
        result: number;
      }
    ).result;
    shortfalls.push({
      name,
      address,
      space: info.space,
      lamports: info.lamports,
      devnetRentExempt: devnetMinimum,
      defaultRentExempt: required,
      shortfall: Math.max(0, required - info.lamports),
    });
    if (info.lamports < required) {
      topUps.push(transfer(payer.address, address, required - info.lamports));
    }
  }
  log('setup/er-rent-shortfall', shortfalls);

  if (topUps.length > 0) {
    log('setup/top-up', await clientSendAndConfirm(baseRpc, payer, topUps));
  }
  log('setup/er-clone-after-top-up', {
    erOwnerOfArena: await accountOwner(ER_URL, arena),
    erOwnerOfPlayers: await accountOwner(ER_URL, players),
  });

  // =========================================================================
  // SP9 — fees
  // =========================================================================

  // A real gameplay message: tag 6, the hot path, built by the real client, fee-paid by
  // a session key that holds zero lamports and does not exist on either chain.
  const move = movePlayer({
    programId: PROGRAM_ID,
    arena,
    players,
    session: session.address,
    seat: 0,
    dir: 2,
    seq: 1,
  });

  const erHash = await latestBlockhash(ER_URL);
  const baseHash = await latestBlockhash(BASE_URL);
  const erMessage = messageBase64(session, erHash, [move]);
  const baseMessage = messageBase64(session, baseHash, [move]);

  // The ER rejects a *v0* message here outright — see the transcript — so the same
  // message is also asked for in legacy form, which is the only way to get a number.
  const erMessageLegacy = messageBase64(session, erHash, [move], 'legacy');
  const baseMessageLegacy = messageBase64(session, baseHash, [move], 'legacy');

  log('sp9/getFeeForMessage', {
    erUrl: ER_URL,
    erBlockhash: erHash.blockhash,
    erV0: await raw(ER_URL, 'getFeeForMessage', [erMessage, { commitment: 'confirmed' }]),
    erLegacy: await raw(ER_URL, 'getFeeForMessage', [erMessageLegacy, { commitment: 'confirmed' }]),
    baseUrl: BASE_URL,
    baseBlockhash: baseHash.blockhash,
    baseV0: await raw(BASE_URL, 'getFeeForMessage', [baseMessage, { commitment: 'confirmed' }]),
    baseLegacy: await raw(BASE_URL, 'getFeeForMessage', [
      baseMessageLegacy,
      { commitment: 'confirmed' },
    ]),
    sessionLamports: await raw(BASE_URL, 'getBalance', [session.address]),
  });

  // The same instruction, signed by the same unfunded key, submitted to the base layer
  // WITH preflight so the refusal is visible.
  const baseSigned = await signWire(session, baseHash, [move]);
  log('sp9/base-send-unfunded', {
    signature: baseSigned.signature,
    totalAccountKeys: baseSigned.keys,
    preflightOn: await raw(BASE_URL, 'sendTransaction', [
      baseSigned.wire,
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' },
    ]),
  });

  // And what the real client's own send path does with it — `skipPreflight: true`.
  const baseHash2 = await latestBlockhash(BASE_URL);
  const baseSigned2 = await signWire(session, baseHash2, [move]);
  log('sp9/base-send-unfunded-skippreflight', {
    signature: baseSigned2.signature,
    response: await raw(BASE_URL, 'sendTransaction', [
      baseSigned2.wire,
      { encoding: 'base64', skipPreflight: true },
    ]),
  });

  // The ER half: does a zero-lamport fee payer get through at all?
  const erSigned = await signWire(session, erHash, [move]);
  log('sp9/er-send-unfunded', {
    signature: erSigned.signature,
    totalAccountKeys: erSigned.keys,
    preflightOn: await raw(ER_URL, 'sendTransaction', [
      erSigned.wire,
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' },
    ]),
  });

  log('sp9/er-send-unfunded-via-client', {
    result: await clientSendAndConfirm(erRpc, session, [move]),
    sessionBalanceOnEr: await raw(ER_URL, 'getBalance', [session.address]),
    sessionBalanceOnBase: await raw(BASE_URL, 'getBalance', [session.address]),
  });

  // =========================================================================
  // SP10 — can a stranger end the raid?
  // =========================================================================

  const strangerSettle = settle({
    programId: PROGRAM_ID,
    payer: stranger.address,
    arena,
    boss,
    players,
  });
  const strangerSettleHash = await latestBlockhash(ER_URL);
  const strangerSettleSigned = await signWire(stranger, strangerSettleHash, [strangerSettle]);
  log('sp10/A settle-from-stranger', {
    stranger: stranger.address,
    preflightOn: await raw(ER_URL, 'sendTransaction', [
      strangerSettleSigned.wire,
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' },
    ]),
    viaClient: await clientSendAndConfirm(erRpc, stranger, [strangerSettle]),
  });

  // Control: the legitimate crank_authority, same instruction, same arena. It must fail
  // DIFFERENTLY (WrongPhase — the arena is still Lobby) or A proves nothing.
  const authoritySettle = settle({
    programId: PROGRAM_ID,
    payer: treasury.address,
    arena,
    boss,
    players,
  });
  const authoritySettleSigned = {
    ...authoritySettle,
    accounts: authoritySettle.accounts.map((a) =>
      a.address === treasury.address ? { ...a, signer: treasury } : a,
    ),
  } as typeof authoritySettle;
  const controlHash = await latestBlockhash(ER_URL);
  const controlSigned = await signWire(session, controlHash, [authoritySettleSigned]);
  log('sp10/B settle-from-authority (control)', {
    feePayer: session.address,
    settlePayer: treasury.address,
    preflightOn: await raw(ER_URL, 'sendTransaction', [
      controlSigned.wire,
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' },
    ]),
  });

  // Tag 12 `commit_and_undelegate` — the literal "take these accounts off the ER"
  // instruction. No client builder by design (operator-only), so the attacker hand-rolls
  // it, which is exactly what an attacker would do.
  const commitAndUndelegate = (authority: Address): Instruction => ({
    programAddress: PROGRAM_ID,
    accounts: [
      { address: authority, role: AccountRole.READONLY_SIGNER },
      { address: MAGIC_CONTEXT_ID, role: AccountRole.WRITABLE },
      { address: MAGIC_PROGRAM_ID, role: AccountRole.READONLY },
      { address: arena, role: AccountRole.WRITABLE },
      { address: boss, role: AccountRole.WRITABLE },
      { address: players, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array([12]),
  });

  const strangerUndelegateHash = await latestBlockhash(ER_URL);
  const strangerUndelegateSigned = await signWire(stranger, strangerUndelegateHash, [
    commitAndUndelegate(stranger.address),
  ]);
  log('sp10/C commit_and_undelegate-from-stranger', {
    preflightOn: await raw(ER_URL, 'sendTransaction', [
      strangerUndelegateSigned.wire,
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' },
    ]),
  });

  // -------------------------------------------------------------------------
  // Base layer: the undelegation callback, the one entry point with no authority
  // check at all. Its defence is structural — the buffer must be a signer owned by
  // the delegation program. A stranger signs with a keypair they control instead.
  // -------------------------------------------------------------------------

  const fakeBuffer = await generateKeyPairSigner();
  const seeds = [new TextEncoder().encode('arena'), new Uint8Array(new BigUint64Array([ARENA_ID]).buffer)];
  const seedBlob: number[] = [];
  const pushU32 = (n: number): void => {
    seedBlob.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
  };
  pushU32(seeds.length);
  for (const seed of seeds) {
    pushU32(seed.length);
    seedBlob.push(...seed);
  }
  const callbackData = new Uint8Array([...EXTERNAL_UNDELEGATE_DISCRIMINATOR, ...seedBlob]);

  const callbackIx: Instruction = {
    programAddress: PROGRAM_ID,
    accounts: [
      { address: arena, role: AccountRole.WRITABLE },
      { address: fakeBuffer.address, role: AccountRole.WRITABLE_SIGNER, signer: fakeBuffer },
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER },
      { address: SYSTEM_PROGRAM_ID, role: AccountRole.READONLY },
    ] as never,
    data: callbackData,
  };
  const callbackHash = await latestBlockhash(BASE_URL);
  const callbackSigned = await signWire(payer, callbackHash, [callbackIx]);
  log('sp10/E undelegate-callback-from-stranger (base layer)', {
    fakeBuffer: fakeBuffer.address,
    dataLen: callbackData.length,
    preflightOn: await raw(BASE_URL, 'sendTransaction', [
      callbackSigned.wire,
      { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' },
    ]),
  });

  // -------------------------------------------------------------------------
  // Positive control and cleanup: the real authority undelegates. If this fails too,
  // every rejection above is worthless as evidence.
  // -------------------------------------------------------------------------

  const authorityUndelegate = commitAndUndelegate(treasury.address);
  const authorityUndelegateSigned = {
    ...authorityUndelegate,
    accounts: authorityUndelegate.accounts.map((a) =>
      a.address === treasury.address ? { ...a, signer: treasury } : a,
    ),
  } as Instruction;
  const cleanupHash = await latestBlockhash(ER_URL);
  const cleanupSigned = await signWire(session, cleanupHash, [authorityUndelegateSigned]);
  const cleanupResponse = await raw(ER_URL, 'sendTransaction', [
    cleanupSigned.wire,
    { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' },
  ]);
  log('sp10/D commit_and_undelegate-from-authority (positive control)', {
    feePayer: session.address,
    authority: treasury.address,
    signature: cleanupSigned.signature,
    response: cleanupResponse,
  });

  await new Promise((r) => setTimeout(r, 12_000));
  log('sp10/D aftermath', {
    baseOwnerOfArena: await accountOwner(BASE_URL, arena),
    delegationStatus: await getDelegationStatus(arena),
  });

  console.log('\n=== TRANSCRIPT JSON ===');
  console.log(JSON.stringify(transcript, jsonSafe, 2));
}

main().catch((error: unknown) => {
  console.error('SPIKE ABORTED', error);
  console.log('\n=== TRANSCRIPT JSON ===');
  console.log(JSON.stringify(transcript, jsonSafe, 2));
  process.exitCode = 1;
});
