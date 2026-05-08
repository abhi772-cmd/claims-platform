#!/usr/bin/env node
// Slice BN — PMJAY participant onboarding CLI. One-shot per hospital.
//
// Drives the four-step flow:
//   1. participant/create   → SMS OTP issued
//   2. validate?...passcode → status PENDING → ACTIVE
//   3. participant/update   (with public key + endpoint URL) → new SMS OTP
//   4. update/validate?...  → status fully ACTIVE; certificate registered
//
// State (transactionid + participantid) persists to a JSON file so
// the operator can pause between steps while the SMS arrives — the
// step-3 OTP has a 24h TTL and the operator may legitimately resume
// the next day. Private key material lives in a separate PEM the
// operator controls.
//
// Usage (sandbox):
//   pnpm --filter @claims/api pmjay:onboard \
//     --base-url https://apisbx.abdm.gov.in/pmjay/sbxhcx/participanthcxservice/v2/ \
//     --state-file ./pmjay-onboarding.json \
//     --keypair ./keys/pmjay-hospital
//
// Resume after first OTP arrives:
//   pnpm --filter @claims/api pmjay:onboard --resume --state-file ./pmjay-onboarding.json
//
// All inputs are prompted interactively when not supplied via flag.

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import {
  PmjayOnboardingClient,
  PmjayOnboardingError,
  type ParticipantCreateRequest,
} from './pmjay-onboard-client';
import { ensureKeypair, readPublicKeyAsBase64Pem } from './pmjay-onboard-keys';
import {
  emptyState,
  loadState,
  saveState,
  type OnboardingState,
} from './pmjay-onboard-state';

interface CliArgs {
  baseUrl: string;
  stateFile: string;
  keypair: string;
  bearerToken?: string;
  resume: boolean;
  registryid?: string;
  mobilenumber?: string;
  email?: string;
  endpointurl?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> & { resume?: boolean } = { resume: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--base-url':
        args.baseUrl = next();
        break;
      case '--state-file':
        args.stateFile = next();
        break;
      case '--keypair':
        args.keypair = next();
        break;
      case '--bearer-token':
        args.bearerToken = next();
        break;
      case '--registryid':
        args.registryid = next();
        break;
      case '--mobile':
        args.mobilenumber = next();
        break;
      case '--email':
        args.email = next();
        break;
      case '--endpoint':
        args.endpointurl = next();
        break;
      case '--resume':
        args.resume = true;
        break;
      case '--help':
      case '-h':
        printHelpAndExit(0);
        break;
      default:
        if (a !== undefined) {
          process.stderr.write(`Unknown argument: ${a}\n`);
          printHelpAndExit(2);
        }
    }
  }
  if (!args.baseUrl) {
    process.stderr.write('Missing required --base-url\n');
    printHelpAndExit(2);
  }
  if (!args.stateFile) args.stateFile = './pmjay-onboarding.json';
  if (!args.keypair) args.keypair = './pmjay-keys/hospital';
  return args as CliArgs;
}

function printHelpAndExit(code: number): never {
  process.stdout.write(
    [
      'Usage: pmjay-onboard --base-url <url> [options]',
      '',
      'Required:',
      '  --base-url <url>        PMJAY participanthcxservice base URL.',
      '',
      'Optional:',
      '  --state-file <path>     Resume state file (default ./pmjay-onboarding.json).',
      '  --keypair <prefix>      RSA keypair path prefix (default ./pmjay-keys/hospital).',
      '  --bearer-token <token>  Bearer for steps 3+ (some deployments require it).',
      '  --resume                Resume from the saved state file.',
      '  --registryid <id>       HFR Registry ID (provider).',
      '  --mobile <10-digit>     Mobile number (must match HFR registration).',
      '  --email <email>         Operator email.',
      '  --endpoint <url>        HTTPS endpoint URL the gateway will POST callbacks to.',
      '  --help, -h              Print this help and exit.',
      '',
    ].join('\n'),
  );
  process.exit(code);
}

class Prompter {
  constructor(private readonly rl: ReadlineInterface) {}

  ask(label: string, opts: { default?: string; secret?: boolean } = {}): Promise<string> {
    return new Promise((resolve) => {
      const suffix = opts.default ? ` [${opts.default}]` : '';
      this.rl.question(`${label}${suffix}: `, (raw) => {
        const trimmed = raw.trim();
        resolve(trimmed.length === 0 && opts.default !== undefined ? opts.default : trimmed);
      });
    });
  }

  close(): void {
    this.rl.close();
  }
}

async function ensureCreateInputs(
  state: OnboardingState,
  args: CliArgs,
  p: Prompter,
): Promise<ParticipantCreateRequest> {
  const registryid =
    state.registryid ?? args.registryid ?? (await p.ask('HFR Registry ID'));
  let mobilenumber = state.mobilenumber ?? args.mobilenumber;
  while (!mobilenumber || !/^\d{10}$/.test(mobilenumber)) {
    mobilenumber = await p.ask('Mobile number (10 digits, must match HFR record)');
  }
  let email = state.email ?? args.email;
  while (!email || !/.+@.+\..+/.test(email)) {
    email = await p.ask('Email');
  }
  return {
    registrytype: '10001',
    registryid,
    role: ['10001'],
    mobilenumber,
    email,
  };
}

async function runCreate(
  client: PmjayOnboardingClient,
  state: OnboardingState,
  args: CliArgs,
  p: Prompter,
): Promise<OnboardingState> {
  const req = await ensureCreateInputs(state, args, p);
  process.stdout.write(`\nCalling participant/create…\n`);
  const res = await client.participantCreate(req);
  process.stdout.write(
    `  participantid:   ${res.participantid}\n  transactionid:   ${res.transactionid}\n  status:          PENDING (OTP sent to ${req.mobilenumber})\n`,
  );
  const next: OnboardingState = {
    ...state,
    step: 'awaiting_create_otp',
    registryid: req.registryid,
    mobilenumber: req.mobilenumber,
    email: req.email,
    participantid: res.participantid,
    createTransactionId: res.transactionid,
  };
  saveState(args.stateFile, next);
  return next;
}

async function runCreateValidate(
  client: PmjayOnboardingClient,
  state: OnboardingState,
  args: CliArgs,
  p: Prompter,
): Promise<OnboardingState> {
  if (!state.createTransactionId) {
    throw new Error('No createTransactionId in state — run step 1 first.');
  }
  const otp = await p.ask('Enter the SMS OTP for participant/create');
  process.stdout.write(`\nCalling validate…\n`);
  const res = await client.validateOtp(state.createTransactionId, otp);
  process.stdout.write(
    `  status:          ${res.status ?? 'ACTIVE'}\n  participantcode: ${res.participantcode ?? state.participantid ?? '(see prior step)'}\n`,
  );
  const next: OnboardingState = { ...state, step: 'awaiting_update' };
  saveState(args.stateFile, next);
  return next;
}

async function runUpdate(
  client: PmjayOnboardingClient,
  state: OnboardingState,
  args: CliArgs,
  p: Prompter,
): Promise<OnboardingState> {
  if (!state.participantid) {
    throw new Error('No participantid in state — run step 1 first.');
  }
  const keys = ensureKeypair({ pathPrefix: args.keypair });
  process.stdout.write(
    `\nUsing keypair:\n  private: ${keys.privateKeyPath} (keep secret; do NOT commit)\n  public:  ${keys.publicKeyPath}\n`,
  );
  const encryptioncert = readPublicKeyAsBase64Pem(keys.publicKeyPath);

  let endpointurl = state.endpointurl ?? args.endpointurl;
  while (!endpointurl || !/^https:\/\//.test(endpointurl)) {
    endpointurl = await p.ask(
      'HTTPS endpoint URL the gateway will POST callbacks to (must start with https://)',
    );
  }

  process.stdout.write(`\nCalling participant/update…\n`);
  const res = await client.participantUpdate({
    participantcode: state.participantid,
    encryptioncert,
    endpointurl,
  });
  process.stdout.write(
    `  status:          ${res.status ?? 'CONFIG_PENDING'}\n  transactionid:   ${res.transactionid} (24h TTL)\n  OTP sent to:     ${state.mobilenumber}\n`,
  );
  const next: OnboardingState = {
    ...state,
    step: 'awaiting_update_otp',
    privateKeyPath: keys.privateKeyPath,
    publicKeyPath: keys.publicKeyPath,
    endpointurl,
    updateTransactionId: res.transactionid,
  };
  saveState(args.stateFile, next);
  return next;
}

async function runUpdateValidate(
  client: PmjayOnboardingClient,
  state: OnboardingState,
  args: CliArgs,
  p: Prompter,
): Promise<OnboardingState> {
  if (!state.updateTransactionId) {
    throw new Error('No updateTransactionId in state — run step 3 first.');
  }
  const otp = await p.ask('Enter the SMS OTP for participant/update');
  process.stdout.write(`\nCalling update/validate…\n`);
  const res = await client.updateValidateOtp(state.updateTransactionId, otp);
  process.stdout.write(
    `  status:          ${res.status ?? 'ACTIVE'}\n  participantcode: ${res.participantcode ?? state.participantid ?? ''}\n\nOnboarding complete. Next manual step: raise an NHA ticket to map the PMJAY Hospital ID (HEM ID) to the NHCX Participant ID.\n`,
  );
  const next: OnboardingState = { ...state, step: 'completed' };
  saveState(args.stateFile, next);
  return next;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const p = new Prompter(rl);

  const opts = args.bearerToken !== undefined
    ? { baseUrl: args.baseUrl, bearerToken: args.bearerToken }
    : { baseUrl: args.baseUrl };
  const client = new PmjayOnboardingClient(opts);

  let state = loadState(args.stateFile);
  if (state === null) {
    state = emptyState(args.baseUrl);
    saveState(args.stateFile, state);
  }
  if (args.resume) {
    process.stdout.write(`Resuming from step=${state.step}\n`);
  }

  try {
    while (state.step !== 'completed') {
      switch (state.step) {
        case 'pending_create':
          state = await runCreate(client, state, args, p);
          break;
        case 'awaiting_create_otp':
          state = await runCreateValidate(client, state, args, p);
          break;
        case 'awaiting_update':
          state = await runUpdate(client, state, args, p);
          break;
        case 'awaiting_update_otp':
          state = await runUpdateValidate(client, state, args, p);
          break;
      }
    }
    process.stdout.write('\nState file is preserved at ' + args.stateFile + ' for audit.\n');
  } catch (err) {
    if (err instanceof PmjayOnboardingError) {
      process.stderr.write(`\n${err.message}\n`);
      if (err.cause.body !== undefined) {
        process.stderr.write(
          `Server payload: ${JSON.stringify(err.cause.body, null, 2)}\n`,
        );
      }
      process.stderr.write(
        `\nState preserved at ${args.stateFile}. Re-run with --resume to retry the current step.\n`,
      );
    } else {
      process.stderr.write(`\nUnexpected error: ${(err as Error).message}\n`);
    }
    process.exitCode = 1;
  } finally {
    p.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`\nFatal: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
