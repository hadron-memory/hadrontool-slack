/**
 * Web API client tests over a stubbed global fetch — the parts the fake
 * provider can't exercise: the HTTP-envelope handling, and specifically that
 * a rate limit is classified from the STATUS before the body is read (a 429
 * can arrive with an empty / non-JSON body).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapSlackError } from '../../errors.js';
import { ProviderRateLimitedError } from '../../errors.js';
import { slackProvider } from './client.js';
import { SlackApiError } from './types.js';

afterEach(() => vi.unstubAllGlobals());

describe('web API client — rate-limit classification', () => {
  it('classifies a 429 with an EMPTY body as a rate limit, not a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '12' } })),
    );

    const err = await slackProvider.authTest('xoxb-x').catch((e) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err).toMatchObject({ httpStatus: 429, slackError: 'ratelimited', retryAfter: 12 });
    // And it maps to the public rate-limited code (carrying retryAfter) — not provider_unavailable.
    const mapped = mapSlackError(err);
    expect(mapped).toBeInstanceOf(ProviderRateLimitedError);
    expect((mapped as ProviderRateLimitedError).retryAfterSeconds).toBe(12);
  });

  it('defaults retryAfter to 30 when the header is absent on a 429', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    const err = await slackProvider.authTest('xoxb-x').catch((e) => e);
    expect(err).toMatchObject({ httpStatus: 429, slackError: 'ratelimited', retryAfter: 30 });
  });

  it('still unwraps a normal ok envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, team_id: 'T1', team: 'Acme', user_id: 'U1', bot_id: 'B1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    await expect(slackProvider.authTest('xoxb-x')).resolves.toMatchObject({ teamId: 'T1', botId: 'B1' });
  });
});
