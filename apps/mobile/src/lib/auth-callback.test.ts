import { describe, expect, it } from 'vitest';
import { parseAuthCallback } from './auth-callback.ts';

describe('parseAuthCallback', () => {
  it('takes the PKCE code from a sign-in link or OAuth', () => {
    expect(parseAuthCallback('com.noahroy.alstrial://auth/callback?code=abc-123')).toEqual({ code: 'abc-123' });
  });
  it('reads errors from the query or the fragment', () => {
    expect(parseAuthCallback('com.noahroy.alstrial://auth/callback?error=access_denied&error_description=Email+link+is+invalid+or+has+expired')).toEqual({
      error: 'Email link is invalid or has expired',
    });
    expect(parseAuthCallback('com.noahroy.alstrial://auth/callback#error=server_error')).toEqual({ error: 'server_error' });
  });
  it('ignores other links', () => {
    expect(parseAuthCallback('com.noahroy.alstrial://share/x')).toBeUndefined();
    expect(parseAuthCallback('not a url')).toBeUndefined();
  });
});
