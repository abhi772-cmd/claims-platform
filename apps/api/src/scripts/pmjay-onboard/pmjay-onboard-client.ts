// Slice BN — PMJAY participant onboarding HTTP client. The four calls
// against `/pmjay/.../participanthcxservice/v2/`:
//
//   1. POST {base}participant/create       → { participantid, transactionid }
//      OTP delivered via SMS to the HFR-registered mobile.
//   2. POST {base}validate?transactionId&passcode
//      Activates participant: PENDING → ACTIVE.
//   3. POST {base}participant/update       → { transactionid }
//      Pushes the public key + endpoint URL. New OTP issued (24h TTL).
//   4. POST {base}update/validate?transactionId&passcode
//      Final activation: certificate registered, endpoint live.
//
// The client is HTTP-only — no readline, no filesystem. State + UX
// live in `pmjay-onboard.ts`. This split keeps the client unit-testable
// against a fetch mock without touching IO.

import { z } from 'zod';

// ---- Schemas ------------------------------------------------------

// PMJAY registry types (per `PMJAY Hospital Migration to HMIS via NHCX.docx` §3.1).
export const RegistryTypeSchema = z.enum(['10001', '10002', '10003', '10004']);
export type RegistryType = z.infer<typeof RegistryTypeSchema>;

export const ParticipantCreateRequestSchema = z.object({
  registrytype: RegistryTypeSchema,
  registryid: z.string().min(1),
  // PMJAY hospital onboarding always uses role=PROVIDER ("10001"); we
  // type the field as an array to mirror the spec but constrain to
  // the one valid value at the schema level.
  role: z.array(z.literal('10001')).min(1),
  mobilenumber: z.string().regex(/^\d{10}$/, 'Mobile must be 10 digits.'),
  email: z.string().email(),
  endpoint_url: z.string().url().optional(),
});
export type ParticipantCreateRequest = z.infer<typeof ParticipantCreateRequestSchema>;

const ApiErrorSchema = z
  .object({
    code: z.string().optional(),
    message: z.string().optional(),
    trace: z.string().optional(),
  })
  .partial()
  .nullable()
  .optional();

export const ParticipantCreateResponseSchema = z.object({
  participantid: z.string(),
  facilityname: z.string().optional(),
  facilitycontact: z.string().optional(),
  facilityemail: z.string().optional(),
  transactionid: z.string(),
  error: ApiErrorSchema,
});
export type ParticipantCreateResponse = z.infer<typeof ParticipantCreateResponseSchema>;

export const ValidateOtpResponseSchema = z.object({
  participantcode: z.string().optional(),
  status: z.string().optional(),
  error: ApiErrorSchema,
});
export type ValidateOtpResponse = z.infer<typeof ValidateOtpResponseSchema>;

export const ParticipantUpdateRequestSchema = z.object({
  participantcode: z.string().min(1),
  // Base64-encoded X.509 PEM public key. The CLI generates the key
  // material; this field carries it as base64(pem-text).
  encryptioncert: z.string().min(1),
  endpointurl: z.string().url(),
});
export type ParticipantUpdateRequest = z.infer<typeof ParticipantUpdateRequestSchema>;

export const ParticipantUpdateResponseSchema = z.object({
  participant_code: z.string().optional(),
  status: z.string().optional(),
  transactionid: z.string(),
  error: ApiErrorSchema,
});
export type ParticipantUpdateResponse = z.infer<typeof ParticipantUpdateResponseSchema>;

// ---- Errors -------------------------------------------------------

export class PmjayOnboardingError extends Error {
  constructor(
    message: string,
    readonly cause: { httpStatus?: number; body?: unknown } = {},
  ) {
    super(message);
    this.name = 'PmjayOnboardingError';
  }
}

// ---- Client -------------------------------------------------------

export interface PmjayOnboardingClientOpts {
  baseUrl: string;
  // Optional bearer for the participant/update + update/validate
  // calls. The handbook does not require a bearer on the bootstrap
  // create + first OTP validate, but later steps can require it
  // when the gateway has been hardened.
  bearerToken?: string;
  // Override fetch for tests. Defaults to the global fetch (Node 18+).
  fetch?: typeof fetch;
}

export class PmjayOnboardingClient {
  private readonly baseUrl: string;
  private readonly bearerToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PmjayOnboardingClientOpts) {
    // Normalise to always end in a single trailing slash so callers
    // can pass either form without breaking URL composition.
    this.baseUrl = opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`;
    if (opts.bearerToken !== undefined) this.bearerToken = opts.bearerToken;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async participantCreate(req: ParticipantCreateRequest): Promise<ParticipantCreateResponse> {
    const validated = ParticipantCreateRequestSchema.parse(req);
    const res = await this.post('participant/create', validated);
    const parsed = ParticipantCreateResponseSchema.safeParse(res.body);
    if (!parsed.success) {
      throw new PmjayOnboardingError(
        `participant/create response did not parse: ${parsed.error.message}`,
        { httpStatus: res.status, body: res.body },
      );
    }
    if (parsed.data.error?.code) {
      throw new PmjayOnboardingError(
        `participant/create returned error: ${parsed.data.error.code} ${parsed.data.error.message ?? ''}`.trim(),
        { httpStatus: res.status, body: res.body },
      );
    }
    return parsed.data;
  }

  async validateOtp(transactionId: string, passcode: string): Promise<ValidateOtpResponse> {
    const path = `validate?transactionId=${encodeURIComponent(transactionId)}&passcode=${encodeURIComponent(passcode)}`;
    const res = await this.post(path, undefined);
    const parsed = ValidateOtpResponseSchema.safeParse(res.body);
    if (!parsed.success) {
      throw new PmjayOnboardingError(
        `validate response did not parse: ${parsed.error.message}`,
        { httpStatus: res.status, body: res.body },
      );
    }
    if (parsed.data.error?.code) {
      throw new PmjayOnboardingError(
        `validate returned error: ${parsed.data.error.code} ${parsed.data.error.message ?? ''}`.trim(),
        { httpStatus: res.status, body: res.body },
      );
    }
    return parsed.data;
  }

  async participantUpdate(req: ParticipantUpdateRequest): Promise<ParticipantUpdateResponse> {
    const validated = ParticipantUpdateRequestSchema.parse(req);
    const res = await this.post('participant/update', validated);
    const parsed = ParticipantUpdateResponseSchema.safeParse(res.body);
    if (!parsed.success) {
      throw new PmjayOnboardingError(
        `participant/update response did not parse: ${parsed.error.message}`,
        { httpStatus: res.status, body: res.body },
      );
    }
    if (parsed.data.error?.code) {
      throw new PmjayOnboardingError(
        `participant/update returned error: ${parsed.data.error.code} ${parsed.data.error.message ?? ''}`.trim(),
        { httpStatus: res.status, body: res.body },
      );
    }
    return parsed.data;
  }

  async updateValidateOtp(
    transactionId: string,
    passcode: string,
  ): Promise<ValidateOtpResponse> {
    const path = `update/validate?transactionId=${encodeURIComponent(transactionId)}&passcode=${encodeURIComponent(passcode)}`;
    const res = await this.post(path, undefined);
    const parsed = ValidateOtpResponseSchema.safeParse(res.body);
    if (!parsed.success) {
      throw new PmjayOnboardingError(
        `update/validate response did not parse: ${parsed.error.message}`,
        { httpStatus: res.status, body: res.body },
      );
    }
    if (parsed.data.error?.code) {
      throw new PmjayOnboardingError(
        `update/validate returned error: ${parsed.data.error.code} ${parsed.data.error.message ?? ''}`.trim(),
        { httpStatus: res.status, body: res.body },
      );
    }
    return parsed.data;
  }

  // ---- internals ------------------------------------------------------

  private async post(
    path: string,
    body: object | undefined,
  ): Promise<{ status: number; body: unknown }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (this.bearerToken) headers['authorization'] = `Bearer ${this.bearerToken}`;

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsedBody: unknown = null;
    const text = await res.text();
    if (text.length > 0) {
      try {
        parsedBody = JSON.parse(text);
      } catch {
        // Keep the text payload as-is when the server returns
        // non-JSON (e.g. HTML error page from a misconfigured proxy).
        parsedBody = { _raw: text };
      }
    }
    if (!res.ok) {
      throw new PmjayOnboardingError(
        `${path} returned HTTP ${res.status}`,
        { httpStatus: res.status, body: parsedBody },
      );
    }
    return { status: res.status, body: parsedBody };
  }
}
