import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Keep provider/network and unrelated account flows out of this offline regression.
vi.mock('../../src/service/perm-service', () => ({ default: { userPermKeys: async () => ['email:delete'] } }));
vi.mock('../../src/service/cf-email-service', () => ({ default: {} }));
vi.mock('../../src/service/user-service', () => ({ default: {} }));
vi.mock('../../src/service/account-service', () => ({ default: {} }));
vi.mock('../../src/service/role-service', () => ({ default: {} }));
vi.mock('../../src/service/telegram-service', () => ({ default: {} }));
vi.mock('../../src/service/s3-service', () => ({ default: {} }));
vi.mock('../../src/service/setting-service', () => ({ default: { query: async () => ({}) } }));
vi.mock('../../src/i18n/i18n', () => ({ t: key => key }));

import { executeConfirmedTool } from '../../src/agent/tools';

// Execute the real Drizzle D1 queries and attachment cleanup SQL against local SQLite.
function d1Fixture(database) {
	function prepare(sql, parameters = []) {
		return {
			bind: (...values) => prepare(sql, values),
			async raw() {
				const statement = database.prepare(sql);
				statement.setReturnArrays(true);
				return statement.all(...parameters);
			},
			async all() {
				return { success: true, results: database.prepare(sql).all(...parameters) };
			},
			async run() {
				const info = database.prepare(sql).run(...parameters);
				return { success: true, results: [], meta: { changes: Number(info.changes) } };
			},
		};
	}
	return {
		prepare,
		async batch(statements) {
			database.exec('BEGIN');
			try {
				const results = [];
				for (const statement of statements) results.push(await statement.all());
				database.exec('COMMIT');
				return results;
			} catch (error) {
				database.exec('ROLLBACK');
				throw error;
			}
		},
	};
}

describe('confirmed permanent deletion ownership', () => {
	let database;
	let env;
	let objects;
	let deletedKeys;

	beforeEach(() => {
		database = new DatabaseSync(':memory:');
		database.exec(`
			CREATE TABLE email (email_id INTEGER PRIMARY KEY, user_id INTEGER, is_del INTEGER);
			CREATE TABLE attachments (att_id INTEGER PRIMARY KEY, email_id INTEGER, key TEXT);
			INSERT INTO email VALUES (11, 1, 0), (22, 2, 0), (33, 1, 1);
			INSERT INTO attachments VALUES (1, 11, 'attachments/own-fixture'),
				(2, 22, 'attachments/victim-fixture'), (3, 33, 'attachments/trash-fixture');
		`);
		objects = new Set(['attachments/own-fixture', 'attachments/victim-fixture', 'attachments/trash-fixture']);
		deletedKeys = [];
		env = {
			db: d1Fixture(database),
			r2: {
				async delete(keys) {
					for (const key of Array.isArray(keys) ? keys : [keys]) {
						deletedKeys.push(key);
						objects.delete(key);
					}
				},
			},
		};
	});

	afterEach(() => database.close());

	const remove = (env, emailId) => executeConfirmedTool({
		env, userId: 1, userEmail: 'fixture@example.invalid',
		name: 'deleteEmail', args: { emailId, permanent: true },
	});

	it('rejects another user before touching its attachment rows or objects', async () => {
		const outcome = await remove(env, 22).then(result => ({ result }), error => ({ error }));
		expect({
			emailRows: database.prepare('SELECT COUNT(*) AS count FROM email WHERE email_id=22').get().count,
			attachmentRows: database.prepare('SELECT COUNT(*) AS count FROM attachments WHERE email_id=22').get().count,
			objectExists: objects.has('attachments/victim-fixture'),
			deletedKeys,
		}).toEqual({ emailRows: 1, attachmentRows: 1, objectExists: true, deletedKeys: [] });
		expect(outcome.error).toMatchObject({ message: 'Email not found', code: 404 });
	});

	it('treats a missing email the same as a foreign email without deleting anything', async () => {
		await expect(remove(env, 999)).rejects.toMatchObject({ message: 'Email not found', code: 404 });
		expect(database.prepare('SELECT COUNT(*) AS count FROM attachments').get().count).toBe(3);
		expect(deletedKeys).toEqual([]);
	});

	it.each([11, 33])('still deletes an owned email including trash: %s', async emailId => {
		await expect(remove(env, emailId)).resolves.toMatchObject({ deleted: true, permanent: true });
		expect(database.prepare('SELECT COUNT(*) AS count FROM email WHERE email_id=?').get(emailId).count).toBe(0);
		expect(database.prepare('SELECT COUNT(*) AS count FROM attachments WHERE email_id=?').get(emailId).count).toBe(0);
		expect(objects.has('attachments/victim-fixture')).toBe(true);
	});

	it('keeps an object still referenced by another user when deleting an owned mail', async () => {
		database.exec("UPDATE attachments SET key='attachments/victim-fixture' WHERE email_id=11;");
		await remove(env, 11);
		expect(objects.has('attachments/victim-fixture')).toBe(true);
		expect(database.prepare('SELECT COUNT(*) AS count FROM attachments WHERE email_id=22').get().count).toBe(1);
		expect(deletedKeys).toEqual([]);
	});
});
