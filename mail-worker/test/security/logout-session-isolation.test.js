import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/service/user-service', () => ({ default: {} }));
vi.mock('../../src/service/account-service', () => ({ default: {} }));
vi.mock('../../src/service/role-service', () => ({ default: {} }));
vi.mock('../../src/service/setting-service', () => ({ default: {} }));
vi.mock('../../src/service/perm-service', () => ({ default: {} }));
vi.mock('../../src/i18n/i18n', () => ({ t: key => key }));

import loginService from '../../src/service/login-service';
import jwtUtils from '../../src/utils/jwt-utils';
import userContext from '../../src/security/user-context';
import constant from '../../src/const/constant';
import app from '../../src/hono/hono';
import '../../src/security/security';
import '../../src/api/login-api';

function fixture(tokens = ['session-a', 'session-b']) {
	let authInfo = tokens === null ? null : {
		tokens,
		user: { userId: 1, email: 'offline@example.test' },
		refreshTime: new Date().toISOString(),
	};
	let expiresAt = Date.now() + constant.TOKEN_EXPIRE * 1000;
	const kv = {
		get: vi.fn(async () => Date.now() >= expiresAt ? null : structuredClone(authInfo)),
		put: vi.fn(async (key, value, options) => {
			expect(key).toBe('auth-uid:1');
			expect(options.expirationTtl).toBeGreaterThanOrEqual(60);
			authInfo = JSON.parse(value);
			expiresAt = Date.now() + options.expirationTtl * 1000;
		}),
	};
	const env = { jwt_secret: 'offline-fixture-only-not-a-real-secret', kv };
	const context = jwt => ({ env, req: { header: () => jwt } });
	const sign = token => jwtUtils.generateToken({ env }, { userId: 1, token });
	return { env, kv, context, sign };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('logout session isolation', () => {
	it.each(['session-a', 'session-b'])('revokes only %s, including through authentication', async token => {
		const { env, kv, sign } = fixture();
		const jwt = await sign(token);
		const otherToken = token === 'session-a' ? 'session-b' : 'session-a';
		const response = await app.request('/logout', { method: 'DELETE', headers: { Authorization: jwt } }, env);
		expect((await response.json()).code).toBe(200);
		expect((await kv.get()).tokens).toEqual([otherToken]);

		const revoked = await app.request('/logout', { method: 'DELETE', headers: { Authorization: jwt } }, env);
		expect((await revoked.json()).code).toBe(401);
		expect(kv.put).toHaveBeenCalledTimes(1);
		const remaining = await app.request('/logout', {
			method: 'DELETE', headers: { Authorization: await sign(otherToken) },
		}, env);
		expect((await remaining.json()).code).toBe(200);
		expect((await kv.get()).tokens).toEqual([]);
	});

	it('awaits real JWT verification before returning its session token', async () => {
		const { context, sign } = fixture();
		expect(await userContext.getToken(context(await sign('session-a')))).toBe('session-a');
	});

	it.each([
		{ name: 'missing KV record', tokens: null },
		{ name: 'empty session list', tokens: [] },
		{ name: 'other active sessions', tokens: ['session-a', 'session-b'] },
	])('does not write for an unknown session with $name', async ({ tokens }) => {
		const { context, sign, kv } = fixture(tokens);
		await loginService.logout(context(await sign('missing-session')), 1);
		expect(kv.put).not.toHaveBeenCalled();
		expect((await kv.get())?.tokens ?? null).toEqual(tokens);
	});

	it.each([undefined, 'invalid.jwt.signature'])('does not mutate sessions for an invalid JWT %s', async jwt => {
		const { context, kv } = fixture();
		await loginService.logout(context(jwt), 1);
		expect(kv.put).not.toHaveBeenCalled();
		expect((await kv.get()).tokens).toEqual(['session-a', 'session-b']);
	});

	it('keeps the existing finite auth TTL policy when writing remaining sessions', async () => {
		const { context, sign, kv } = fixture();
		await loginService.logout(context(await sign('session-a')), 1);
		expect(kv.put.mock.calls[0][2]).toEqual({ expirationTtl: constant.TOKEN_EXPIRE });
		vi.advanceTimersByTime((constant.TOKEN_EXPIRE - 1) * 1000);
		expect((await kv.get()).tokens).toEqual(['session-b']);
		vi.advanceTimersByTime(1000);
		expect(await kv.get()).toBeNull();
	});

	it('does not recreate an expired auth record', async () => {
		const { context, sign, kv } = fixture();
		const jwt = await sign('session-a');
		vi.advanceTimersByTime(constant.TOKEN_EXPIRE * 1000);
		await loginService.logout(context(jwt), 1);
		expect(kv.put).not.toHaveBeenCalled();
		expect(await kv.get()).toBeNull();
	});

	it('propagates a failed session write instead of reporting successful revocation', async () => {
		const { context, sign, kv } = fixture();
		kv.put.mockRejectedValueOnce(new Error('offline KV unavailable'));
		await expect(loginService.logout(context(await sign('session-a')), 1)).rejects.toThrow('offline KV unavailable');
		expect((await kv.get()).tokens).toEqual(['session-a', 'session-b']);
	});
});
