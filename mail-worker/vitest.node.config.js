import { defineConfig } from 'vitest/config';

export default defineConfig({
	cacheDir: './node_modules/.test-cache',
	test: {
		environment: 'node',
		include: ['test/security/**/*.test.js'],
	},
});
