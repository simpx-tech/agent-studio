import { describe, expect, it } from 'vitest';
import { signInKey, signInUpdate, signInViewSchema, type SignInView } from './sign-in';

const waiting: SignInView = {
  id: 'one',
  provider: 'claude',
  connectionId: 'connection',
  phase: 'waiting',
  url: 'https://claude.com/cai/oauth/authorize?state=s',
  code: true,
  message: '',
};

describe('sign-ins without a terminal', () => {
  it('are kept by the connection they sign in to, or the provider login', () => {
    expect(signInKey(waiting)).toBe('connection');
    expect(signInKey({ provider: 'codex' })).toBe('codex');
  });

  it('show waiting and ended sign-ins, check connected ones and ignore replaced ones', () => {
    expect(signInUpdate(undefined, waiting)).toBe('show');
    expect(signInUpdate(waiting, { ...waiting, message: 'Checking the code…' })).toBe('show');
    expect(signInUpdate(waiting, { ...waiting, phase: 'connected', url: undefined })).toBe(
      'connected',
    );
    expect(signInUpdate(waiting, { ...waiting, phase: 'failed', message: 'No' })).toBe('ended');
    expect(signInUpdate(waiting, { ...waiting, phase: 'expired', message: 'Late' })).toBe('ended');
    expect(signInUpdate(waiting, { ...waiting, phase: 'cancelled' })).toBe('clear');
    expect(signInUpdate(waiting, { ...waiting, phase: 'cancelled', message: 'Replaced' })).toBe(
      'ended',
    );
    // An older sign-in of an account that started another since.
    expect(signInUpdate({ ...waiting, id: 'two' }, { ...waiting, phase: 'cancelled' })).toBe(
      'ignore',
    );
    // A sign-in that ended gives way to the next one.
    const failed = { ...waiting, phase: 'failed' as const, message: 'No' };
    expect(signInUpdate(failed, { ...waiting, id: 'two' })).toBe('show');
  });

  it('accept only bounded sign-ins from the host', () => {
    expect(signInViewSchema.parse(waiting)).toEqual(waiting);
    expect(signInViewSchema.safeParse({ ...waiting, phase: 'opened' }).success).toBe(false);
    expect(signInViewSchema.safeParse({ ...waiting, message: 'x'.repeat(601) }).success).toBe(
      false,
    );
  });
});
