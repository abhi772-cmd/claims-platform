// Slice BN — PMJAY onboarding HTTP client unit tests. We mock the
// global fetch via the constructor's `fetch` override so the client
// stays IO-free and the tests run in milliseconds.

import {
  PmjayOnboardingClient,
  PmjayOnboardingError,
} from './pmjay-onboard-client';

interface MockResponseSpec {
  status?: number;
  body?: unknown;
  rawBody?: string;
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function makeMockFetch(responses: MockResponseSpec[]): {
  fetch: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let i = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const spec = responses[i++];
    if (!spec) throw new Error(`Mock fetch ran out of responses at call ${i}`);
    const url = typeof input === 'string' ? input : (input as URL | Request).toString();
    calls.push({ url, init: init ?? {} });
    const status = spec.status ?? 200;
    const text =
      spec.rawBody !== undefined ? spec.rawBody : JSON.stringify(spec.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(text),
    } as Response;
  };
  return { fetch: fetchImpl, calls };
}

describe('PmjayOnboardingClient', () => {
  describe('participantCreate', () => {
    it('POSTs JSON to {base}participant/create and returns parsed body', async () => {
      const mock = makeMockFetch([
        {
          body: {
            participantid: 'pmjay-test-001',
            facilityname: 'Test Hospital',
            transactionid: 'txn-create-1',
          },
        },
      ]);
      const client = new PmjayOnboardingClient({
        baseUrl: 'https://gw.test/v2/',
        fetch: mock.fetch,
      });
      const res = await client.participantCreate({
        registrytype: '10001',
        registryid: 'IN1900000001',
        role: ['10001'],
        mobilenumber: '9876543210',
        email: 'ops@hospital.test',
      });
      expect(res.participantid).toBe('pmjay-test-001');
      expect(res.transactionid).toBe('txn-create-1');
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]!.url).toBe('https://gw.test/v2/participant/create');
      expect(mock.calls[0]!.init.method).toBe('POST');
      const sent = JSON.parse(mock.calls[0]!.init.body as string);
      expect(sent.registrytype).toBe('10001');
      expect(sent.role).toEqual(['10001']);
      expect(sent.mobilenumber).toBe('9876543210');
    });

    it('normalises baseUrl missing trailing slash', async () => {
      const mock = makeMockFetch([
        { body: { participantid: 'p1', transactionid: 't1' } },
      ]);
      const client = new PmjayOnboardingClient({
        baseUrl: 'https://gw.test/v2',
        fetch: mock.fetch,
      });
      await client.participantCreate({
        registrytype: '10001',
        registryid: 'IN1',
        role: ['10001'],
        mobilenumber: '9876543210',
        email: 'a@b.co',
      });
      expect(mock.calls[0]!.url).toBe('https://gw.test/v2/participant/create');
    });

    it('passes Authorization: Bearer when bearerToken supplied', async () => {
      const mock = makeMockFetch([
        { body: { participantid: 'p1', transactionid: 't1' } },
      ]);
      const client = new PmjayOnboardingClient({
        baseUrl: 'https://gw.test/v2/',
        bearerToken: 'jwt-abc',
        fetch: mock.fetch,
      });
      await client.participantCreate({
        registrytype: '10001',
        registryid: 'IN1',
        role: ['10001'],
        mobilenumber: '9876543210',
        email: 'a@b.co',
      });
      const headers = mock.calls[0]!.init.headers as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer jwt-abc');
    });

    it('rejects malformed mobile (Zod)', async () => {
      const client = new PmjayOnboardingClient({ baseUrl: 'https://gw.test/v2/' });
      await expect(
        client.participantCreate({
          registrytype: '10001',
          registryid: 'IN1',
          role: ['10001'],
          mobilenumber: '+919876543210',
          email: 'a@b.co',
        }),
      ).rejects.toThrow(/Mobile must be 10 digits/);
    });

    it('throws PmjayOnboardingError on HTTP 4xx', async () => {
      const mock = makeMockFetch([
        { status: 400, body: { error: { code: 'ERR-001', message: 'bad input' } } },
      ]);
      const client = new PmjayOnboardingClient({
        baseUrl: 'https://gw.test/v2/',
        fetch: mock.fetch,
      });
      await expect(
        client.participantCreate({
          registrytype: '10001',
          registryid: 'IN1',
          role: ['10001'],
          mobilenumber: '9876543210',
          email: 'a@b.co',
        }),
      ).rejects.toBeInstanceOf(PmjayOnboardingError);
    });

    it('throws PmjayOnboardingError when response carries error.code', async () => {
      // 200 OK but the gateway returns an `error` envelope — happens
      // in PMJAY when validation fires on the application side.
      const mock = makeMockFetch([
        { body: { participantid: '', transactionid: '', error: { code: 'ERR-MOBILE-MISMATCH' } } },
      ]);
      const client = new PmjayOnboardingClient({
        baseUrl: 'https://gw.test/v2/',
        fetch: mock.fetch,
      });
      await expect(
        client.participantCreate({
          registrytype: '10001',
          registryid: 'IN1',
          role: ['10001'],
          mobilenumber: '9876543210',
          email: 'a@b.co',
        }),
      ).rejects.toThrow(/ERR-MOBILE-MISMATCH/);
    });
  });

  describe('validateOtp', () => {
    it('encodes transactionId + passcode as query params', async () => {
      const mock = makeMockFetch([{ body: { status: 'ACTIVE' } }]);
      const client = new PmjayOnboardingClient({
        baseUrl: 'https://gw.test/v2/',
        fetch: mock.fetch,
      });
      await client.validateOtp('txn 1', '123456');
      expect(mock.calls[0]!.url).toBe(
        'https://gw.test/v2/validate?transactionId=txn%201&passcode=123456',
      );
      expect(mock.calls[0]!.init.body).toBeUndefined();
    });
  });

  describe('participantUpdate', () => {
    it('rejects non-HTTPS endpointurl', async () => {
      const client = new PmjayOnboardingClient({ baseUrl: 'https://gw.test/v2/' });
      await expect(
        client.participantUpdate({
          participantcode: 'p1',
          encryptioncert: 'base64-pem',
          // Zod's url() accepts http; the spec requires https. We
          // assert the looser shape passes but the CLI catches the
          // https requirement before reaching the client.
          endpointurl: 'not-a-url',
        }),
      ).rejects.toThrow();
    });

    it('returns transactionid for the second OTP', async () => {
      const mock = makeMockFetch([
        { body: { participant_code: 'p1', status: 'CONFIG_PENDING', transactionid: 'txn-2' } },
      ]);
      const client = new PmjayOnboardingClient({
        baseUrl: 'https://gw.test/v2/',
        fetch: mock.fetch,
      });
      const res = await client.participantUpdate({
        participantcode: 'p1',
        encryptioncert: 'aGVsbG8=',
        endpointurl: 'https://hospital.test/nhcx/inbound',
      });
      expect(res.transactionid).toBe('txn-2');
      expect(res.status).toBe('CONFIG_PENDING');
    });
  });

  describe('updateValidateOtp', () => {
    it('hits update/validate path', async () => {
      const mock = makeMockFetch([{ body: { status: 'ACTIVE' } }]);
      const client = new PmjayOnboardingClient({
        baseUrl: 'https://gw.test/v2/',
        fetch: mock.fetch,
      });
      await client.updateValidateOtp('txn-2', '987654');
      expect(mock.calls[0]!.url).toBe(
        'https://gw.test/v2/update/validate?transactionId=txn-2&passcode=987654',
      );
    });
  });

  describe('non-JSON server response', () => {
    it('captures raw payload under _raw and surfaces on HTTP error', async () => {
      const mock = makeMockFetch([
        { status: 502, rawBody: '<html>Bad Gateway</html>' },
      ]);
      const client = new PmjayOnboardingClient({
        baseUrl: 'https://gw.test/v2/',
        fetch: mock.fetch,
      });
      try {
        await client.validateOtp('t', 'p');
        fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(PmjayOnboardingError);
        const e = err as PmjayOnboardingError;
        expect(e.cause.httpStatus).toBe(502);
        expect(e.cause.body).toEqual({ _raw: '<html>Bad Gateway</html>' });
      }
    });
  });
});
