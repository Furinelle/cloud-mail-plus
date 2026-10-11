import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

// All provider calls are counted locally. No network, credentials or real mail.
vi.mock('../../src/service/cf-email-service.js', () => ({
	default: {
		async send(env, form) {
			env.syntheticSendAttempts.push(form);
			if (env.syntheticFailure) throw new Error('synthetic provider failure');
		},
	},
}));
vi.mock('../../src/service/s3-service.js', () => ({ default: {} }));
vi.mock('../../src/i18n/i18n.js', () => ({ t: key => key }));

import app from '../../src/hono/hono.js';
import '../../src/security/security.js';
import '../../src/api/email-api.js';
import '../../src/api/agent-api.js';
import jwtUtils from '../../src/utils/jwt-utils.js';
import { buildTools } from '../../src/agent/tools.js';
import user from '../../src/entity/user.js';
import role from '../../src/entity/role.js';
import perm from '../../src/entity/perm.js';
import rolePerm from '../../src/entity/role-perm.js';
import email from '../../src/entity/email.js';
import account from '../../src/entity/account.js';
import { att } from '../../src/entity/att.js';
import { star } from '../../src/entity/star.js';
import { settingConst } from '../../src/const/entity-const.js';

function d1(database) {
	function prepare(sql, params = []) {
		return {
			bind: (...values) => prepare(sql, values),
			async raw() { const statement = database.prepare(sql); statement.setReturnArrays(true); return statement.all(...params); },
			async all() { return { success: true, results: database.prepare(sql).all(...params) }; },
			async run() { const result = database.prepare(sql).run(...params); return { success: true, results: [], meta: { changes: Number(result.changes) } }; },
		};
	}
	return { prepare, async batch(statements) {
		database.exec('BEGIN');
		try { const results = []; for (const statement of statements) results.push(await statement.all()); database.exec('COMMIT'); return results; }
		catch (error) { database.exec('ROLLBACK'); throw error; }
	} };
}

let database, env, token, kv, settings, objects, objectReads, aiCalls;
function grant(...keys) {
	database.exec('DELETE FROM role_perm');
	for (const key of keys) database.prepare('INSERT INTO role_perm(role_id,perm_id) SELECT 99,perm_id FROM perm WHERE perm_key=?').run(key);
}
function setting(changes) {
	settings = { ...settings, ...changes };
	kv.set('setting:', JSON.stringify(settings));
}
async function http(path, method = 'POST', body) {
	const response = await app.request(path, {
		method, headers: { Authorization: token, 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	}, env);
	return response.json();
}
const sendCount = () => Number(database.prepare('SELECT send_count FROM user WHERE user_id=1').get().send_count);
const confirm = (name, args) => http('/agent/confirm', 'POST', { name, args });
const normalSend = (overrides = {}) => http('/email/send', 'POST', {
	accountId: 101, name: 'Synthetic', sendType: 'new', receiveEmail: ['target@outside.invalid'],
	subject: 'OWN_NEEDLE', text: 'synthetic fixture', content: '<p>synthetic fixture</p>', attachments: [], ...overrides,
});

beforeEach(async () => {
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in offline fixture'); }));
	database = new DatabaseSync(':memory:');
	for (const table of [user, role, perm, rolePerm, email, account, att, star]) {
		const meta = getTableConfig(table);
		const columns = meta.columns.map(column => `${JSON.stringify(column.name)} ${column.dataType === 'number' ? 'INTEGER' : 'TEXT'}${column.primary ? ' PRIMARY KEY' : ''}`);
		database.exec(`CREATE TABLE ${JSON.stringify(meta.name)} (${columns.join(',')})`);
	}
	database.exec(`
		INSERT INTO user(user_id,email,type,status,is_del,send_count,agent_enabled) VALUES(1,'limited@example.invalid',99,0,0,0,1),(2,'other@example.invalid',99,0,0,0,1);
		INSERT INTO role(role_id,name,key,send_type,send_count,avail_domain,ban_email) VALUES(99,'fixture-limited','fixture-limited','count',0,'','');
		INSERT INTO perm(perm_id,perm_key,type) VALUES(1,'email:send',2),(2,'email:delete',2);
		INSERT INTO account(account_id,user_id,email,is_del) VALUES(101,1,'limited@example.invalid',0),(202,2,'other@example.invalid',0);
		INSERT INTO email(email_id,user_id,account_id,subject,text,content,type,status,is_del,to_email,send_email,unread,create_time)
		VALUES(11,1,101,'OWN_NEEDLE','own synthetic text','<p>own synthetic text</p>',1,6,0,'target@outside.invalid','limited@example.invalid',0,'2026-10-12'),
		(22,2,202,'FOREIGN_NEEDLE','foreign synthetic text','<p>foreign synthetic text</p>',1,6,0,'other@outside.invalid','other@example.invalid',0,'2026-10-12');
		INSERT INTO attachments(att_id,user_id,email_id,account_id,key,mime_type,type,filename,size)
		VALUES(1,1,11,101,'attachments/own','text/plain',0,'own.txt',3),(2,2,22,202,'attachments/foreign','text/plain',0,'foreign.txt',7);
	`);
	kv = new Map();
	objects = new Set(['attachments/own', 'attachments/foreign']);
	objectReads = [];
	aiCalls = [];
	env = {
		jwt_secret: 'offline-synthetic-not-real-secret', admin: 'admin@example.invalid', domain: ['example.invalid'], project_link: false,
		db: d1(database), syntheticSendAttempts: [],
		kv: { async get(key, options) { const value = kv.get(key); return options?.type === 'json' && value ? JSON.parse(value) : value; }, async put(key, value) { kv.set(key, value); } },
		r2: { async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); }, async get(key) { objectReads.push(key); return { arrayBuffer: async () => new Uint8Array([1,2,3]).buffer }; } },
		AI: { async run(model, input) { aiCalls.push(input); return { response: 'synthetic summary' }; } },
	};
	settings = { resendTokens: {}, emailProvider: settingConst.emailProvider.CF_ONLY, send: settingConst.send.OPEN, emailPrefixFilter: '', r2Domain: '' };
	setting({});
	kv.set('auth-uid:1', JSON.stringify({ tokens: ['synthetic-session'], user: { userId: 1, email: 'limited@example.invalid', type: 99 }, refreshTime: new Date().toISOString() }));
	token = await jwtUtils.generateToken({ env }, { userId: 1, token: 'synthetic-session' });
});
afterEach(() => { database.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([{ keys: [] }, { keys: ['email:delete'] }])('send permission is required on both paths for $keys', async ({ keys }) => {
	grant(...keys);
	expect((await normalSend()).code).toBe(403);
	expect((await confirm('sendDraft', { draftId: 11 })).code).toBe(403);
	expect(env.syntheticSendAttempts).toHaveLength(0);
	expect(database.prepare('SELECT status FROM email WHERE email_id=11').get().status).toBe(6);
});

it.each([false, true])('send permission does not authorize Agent deletion permanent=%s', async permanent => {
	grant('email:send');
	expect((await http('/email/delete?emailIds=11', 'DELETE')).code).toBe(403);
	expect((await http('/email/permanentDelete?emailIds=11', 'DELETE')).code).toBe(403);
	expect((await confirm('deleteEmail', { emailId: 11, permanent })).code).toBe(403);
	expect(database.prepare('SELECT is_del FROM email WHERE email_id=11').get().is_del).toBe(0);
	expect(objects.size).toBe(2);
});

it.each([false, true])('delete permission permits only owned Agent deletion permanent=%s', async permanent => {
	grant('email:delete');
	expect((await confirm('deleteEmail', { emailId: 11, permanent })).code).toBe(200);
	const row = database.prepare('SELECT is_del FROM email WHERE email_id=11').get();
	expect(permanent ? row === undefined : row.is_del === 1).toBe(true);
	expect(database.prepare('SELECT COUNT(*) AS n FROM email WHERE email_id=22').get().n).toBe(1);
	expect(objects.has('attachments/foreign')).toBe(true);
});

it('ordinary permanent-delete permits authorized cleanup', async () => {
	grant('email:delete');
	expect((await http('/email/permanentDelete?emailIds=11','DELETE')).code).toBe(200);
	expect(database.prepare('SELECT COUNT(*) AS n FROM email WHERE email_id=11').get().n).toBe(0);
	expect(objects.has('attachments/own')).toBe(false);
	expect(objects.has('attachments/foreign')).toBe(true);
});

it.each([
	['global-send-closed', () => setting({ send: settingConst.send.CLOSE }), 403],
	['role-send-banned', () => database.exec("UPDATE role SET send_type='ban'"), 403],
	['daily-quota-exhausted', () => database.exec("UPDATE role SET send_type='day',send_count=1; UPDATE user SET send_count=1 WHERE user_id=1"), 403],
	['total-quota-exhausted', () => database.exec("UPDATE role SET send_count=1; UPDATE user SET send_count=1 WHERE user_id=1"), 403],
	['internal-only-to-external', () => database.exec("UPDATE role SET send_type='internal'"), 403],
	['sender-domain-not-allowed', () => database.exec("UPDATE role SET avail_domain='another.invalid'"), 403],
	['sender-account-deleted', () => database.exec('UPDATE account SET is_del=1 WHERE account_id=101'), 501],
	['sender-account-foreign', () => database.exec('UPDATE account SET user_id=2 WHERE account_id=101'), 501],
	['resend-only-without-token', () => setting({ emailProvider: settingConst.emailProvider.RESEND_ONLY }), 501],
])('ordinary and Agent sends enforce the same policy: %s', async (name, restrict, code) => {
	grant('email:send'); restrict();
	const before = sendCount();
	expect((await normalSend()).code).toBe(code);
	expect((await confirm('sendDraft', { draftId: 11 })).code).toBe(code);
	expect(env.syntheticSendAttempts).toHaveLength(0);
	expect(sendCount()).toBe(before);
	expect(database.prepare('SELECT status FROM email WHERE email_id=11').get().status).toBe(6);
});

it.each(['day', 'count'])('ordinary and Agent sends share recipient accounting for %s quotas', async type => {
	grant('email:send');
	database.prepare('UPDATE role SET send_type=?,send_count=2').run(type);
	expect((await normalSend()).code).toBe(200);
	expect((await confirm('sendDraft', { draftId: 11 })).code).toBe(200);
	expect(env.syntheticSendAttempts).toHaveLength(2);
	expect(sendCount()).toBe(2);
	expect(database.prepare('SELECT status FROM email WHERE email_id=11').get().status).toBe(1);
	expect((await normalSend()).code).toBe(403);
	expect((await confirm('sendDraft', { draftId: 11 })).code).toBe(403);
	expect(env.syntheticSendAttempts).toHaveLength(2);
});

it.each(['day', 'count'])('recipient-count shortages reject both paths for %s quotas', async type => {
	grant('email:send');
	database.prepare('UPDATE role SET send_type=?,send_count=1').run(type);
	const recipients = ['one@outside.invalid', 'two@outside.invalid'];
	// sendRaw also accepts multiple recipients; reject before either provider call.
	const { default: emailService } = await import('../../src/service/email-service.js');
	expect((await normalSend({ receiveEmail: recipients })).code).toBe(403);
	await expect(emailService.sendRaw({ env }, { accountId: 101, to: recipients }, 1)).rejects.toMatchObject({ code: 403 });
	expect(env.syntheticSendAttempts).toHaveLength(0);
});

it('text-backed used counts are added numerically on both paths', async () => {
	grant('email:send');
	database.exec('UPDATE role SET send_count=10; UPDATE user SET send_count=1 WHERE user_id=1');
	expect((await normalSend()).code).toBe(200);
	expect((await confirm('sendDraft', { draftId: 11 })).code).toBe(200);
	expect(sendCount()).toBe(3);
	expect(env.syntheticSendAttempts).toHaveLength(2);
});

it('internal-only Agent sends allow internal recipients without consuming external quota', async () => {
	grant('email:send');
	database.exec("UPDATE role SET send_type='internal',send_count=10; UPDATE email SET to_email='other@example.invalid' WHERE email_id=11");
	expect((await normalSend({ receiveEmail: ['other@example.invalid'] })).code).toBe(200);
	expect((await confirm('sendDraft', { draftId: 11 })).code).toBe(200);
	expect(sendCount()).toBe(0);
});

it('new Agent drafts resolve the owned primary account when accountId is zero', async () => {
	grant('email:send');
	database.exec('UPDATE email SET account_id=0 WHERE email_id=11; UPDATE role SET send_count=1');
	expect((await confirm('sendDraft', { draftId: 11 })).code).toBe(200);
	expect(env.syntheticSendAttempts[0].from).toBe('limited <limited@example.invalid>');
	expect(sendCount()).toBe(1);
});

it('provider failure does not consume quota or mark the Agent draft sent', async () => {
	grant('email:send');
	database.exec('UPDATE role SET send_count=2');
	env.syntheticFailure = true;
	expect((await normalSend()).code).toBe(501);
	expect((await confirm('sendDraft', { draftId: 11 })).code).toBe(501);
	expect(env.syntheticSendAttempts).toHaveLength(2);
	expect(sendCount()).toBe(0);
	expect(database.prepare('SELECT status FROM email WHERE email_id=11').get().status).toBe(6);
});

it('Admin retains permission and role-policy exceptions on both sending paths', async () => {
	grant(); env.admin = 'limited@example.invalid';
	database.exec("UPDATE role SET send_type='ban',avail_domain='another.invalid',send_count=1; UPDATE user SET send_count=1 WHERE user_id=1");
	expect((await normalSend()).code).toBe(200);
	expect((await confirm('sendDraft', { draftId: 11 })).code).toBe(200);
	expect(env.syntheticSendAttempts).toHaveLength(2);
});

it("Admin still cannot use another user's sending account", async () => {
	grant(); env.admin = 'limited@example.invalid';
	database.exec('UPDATE email SET account_id=202 WHERE email_id=11');
	expect((await normalSend({ accountId: 202 })).code).toBe(501);
	expect((await confirm('sendDraft', { draftId: 11 })).code).toBe(501);
	expect(env.syntheticSendAttempts).toHaveLength(0);
});

it('Admin still obeys the global sending switch', async () => {
	grant(); env.admin = 'limited@example.invalid'; setting({ send: settingConst.send.CLOSE });
	expect((await normalSend()).code).toBe(403);
	expect((await confirm('sendDraft', { draftId: 11 })).code).toBe(403);
	expect(env.syntheticSendAttempts).toHaveLength(0);
});

it.each([false, true])('Admin retains the Agent deletion permission exception permanent=%s', async permanent => {
	grant(); env.admin = 'limited@example.invalid';
	expect((await confirm('deleteEmail', { emailId: 11, permanent })).code).toBe(200);
});

it('read-only list and search queries return only the bound user across matching fixtures', async () => {
	const tools = buildTools({ env, userId: 1, userEmail: 'limited@example.invalid' });
	const list = await tools.listEmails.execute({ box: 'drafts', page: 1, size: 20, unreadOnly: false });
	const search = await tools.searchEmails.execute({ query: 'NEEDLE', limit: 20 });
	expect(list.map(row => row.emailId)).toEqual([11]);
	expect(search.map(row => row.emailId)).toEqual([11]);
});

it('getEmail refuses a foreign ID while allowing owned mail', async () => {
	const tools = buildTools({ env, userId: 1, userEmail: 'limited@example.invalid' });
	expect(await tools.getEmail.execute({ emailId: 22 })).toEqual({ error: 'Not found or not accessible' });
	expect((await tools.getEmail.execute({ emailId: 11 })).emailId).toBe(11);
});

it('foreign attachment lookup fails before object storage access', async () => {
	const tools = buildTools({ env, userId: 1, userEmail: 'limited@example.invalid' });
	expect(await tools.getAttachmentText.execute({ emailId: 22, attIndex: 0 })).toEqual({ error: 'Attachment not found' });
	expect(objectReads).toEqual([]);
});

it('summarizing a foreign mail does not call even the fake model; owned summary contains no foreign marker', async () => {
	const tools = buildTools({ env, userId: 1, userEmail: 'limited@example.invalid' });
	expect(await tools.summarizeEmail.execute({ emailId: 22 })).toEqual({ error: 'Not found' });
	expect(aiCalls).toEqual([]);
	await tools.summarizeEmail.execute({ emailId: 11 });
	expect(aiCalls).toHaveLength(1);
	expect(JSON.stringify(aiCalls)).not.toContain('FOREIGN_NEEDLE');
});
