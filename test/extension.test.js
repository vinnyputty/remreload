const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const util = require('util');
const packageJson = require('../package.json');

const DEFAULT_COMMAND = 'ping -t 1 -c 1 google.com';

function loadExtension({ remoteName, settings = {}, execResults = {}, tunnelStat } = {}) {
	const calls = [];
	const reloads = [];
	const intervals = [];
	const timers = [];
	const statCalls = [];
	const output = [];
	const notifications = [];
	let clearedInterval;

	function configuration(resource) {
		return {
		get(key) {
			if (Object.prototype.hasOwnProperty.call(settings, key)) {
				const configured = settings[key];
				if (configured && typeof configured === 'object' && 'value' in configured) {
					return (resource && configured.workspaceFolderValue !== undefined)
						? configured.workspaceFolderValue
						: configured.workspaceValue ?? configured.globalValue ?? configured.value;
				}
				return configured;
			}
			if (key.endsWith('.enabled')) {
				return true;
			}
			if (key.endsWith('.checkConnectivityCommand') || key === 'checkConnectivityCommand') {
				return DEFAULT_COMMAND;
			}
			return undefined;
		},
		inspect(key) {
			const setting = settings[key];
			if (!setting || typeof setting !== 'object' || !('value' in setting)) {
				return undefined;
			}
			return {
				key: `remreload.${key}`,
				defaultValue: DEFAULT_COMMAND,
				globalValue: setting.globalValue,
				workspaceValue: setting.workspaceValue,
				workspaceFolderValue: setting.workspaceFolderValue,
			};
		},
		async update(key, value, target) {
			const field = target === 1 ? 'globalValue' : target === 2 ? 'workspaceValue' : 'workspaceFolderValue';
			const setting = settings[key] && typeof settings[key] === 'object' ? settings[key] : { value: DEFAULT_COMMAND };
			setting[field] = value;
			setting.value = setting.workspaceFolderValue ?? setting.workspaceValue ?? setting.globalValue ?? DEFAULT_COMMAND;
			settings[key] = setting;
		},
		};
	}

	function exec(command, callback) {
		calls.push(command);
		let result = execResults[command];
		if (result === undefined && command.startsWith('lsof -Pan -p ')) {
			result = { stdout: 'node 42 x TCP 127.0.0.1:53009->127.0.0.1:56287 (ESTABLISHED)\n', stderr: '' };
		}
		if (result === undefined && command.startsWith('pgrep -f ')) {
			result = { stdout: '123\n', stderr: '' };
		}
		if (result instanceof Error) {
			callback(result);
		} else if (typeof result === 'function') {
			result(command, callback);
		} else {
			callback(null, result || { stdout: '', stderr: '' });
		}
	}

	const workspaceFolder = { uri: { scheme: 'vscode-remote', path: '/remote/workspace', with(changes) { return { ...this, ...changes }; } } };
	const vscode = {
		env: { remoteName },
		Uri: { parse(uri) { return { scheme: 'vscode-remote', path: uri, with(changes) { return { ...this, ...changes }; } }; } },
		window: {
			createOutputChannel() {
				return { appendLine(message) { output.push(message); } };
			},
			showErrorMessage(message) { output.push(message); },
			showInformationMessage(message) { notifications.push(message); },
		},
		workspace: {
			getConfiguration(_section, resource) { return configuration(resource); },
			workspaceFolders: [workspaceFolder],
			workspaceFile: null,
			textDocuments: [],
			fs: {
				stat(uri) {
					statCalls.push(uri);
					if (typeof tunnelStat === 'function') return tunnelStat(uri);
					if (tunnelStat instanceof Error) return Promise.reject(tunnelStat);
					return Promise.resolve({});
				},
			},
		},
		commands: { executeCommand(command) { reloads.push(command); } },
		ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	};
	const childProcess = { exec };
	const extensionPath = path.resolve(__dirname, '../out/extension.js');
	const source = fs.readFileSync(extensionPath, 'utf8');
	const module = { exports: {} };
	const processShim = Object.create(process);
	processShim.platform = 'linux';
	const context = vm.createContext({
		require(request) {
			if (request === 'vscode') return vscode;
			if (request === 'child_process') return childProcess;
			if (request === 'util') return util;
			return require(request);
		},
		module,
		exports: module.exports,
		process: processShim,
		console,
		Buffer,
		setInterval(callback) {
			intervals.push(callback);
			return callback;
		},
		clearInterval(interval) { clearedInterval = interval; },
		setTimeout(callback, delay) {
			const timer = { callback, delay, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimeout(timer) { if (timer) timer.cleared = true; },
	});
	vm.runInContext(source, context, { filename: extensionPath });

	return {
		extension: module.exports,
		calls,
		reloads,
		intervals,
		statCalls,
		timers,
		async runTimers() {
			for (const timer of timers.splice(0)) {
				if (!timer.cleared) await timer.callback();
			}
		},
		output,
		notifications,
		settings,
		get clearedInterval() { return clearedInterval; },
	};
}

function sshProcessResults() {
	return {
		'lsof -Pan -p 42 -i tcp': { stdout: 'node 42 x TCP 127.0.0.1:53009->127.0.0.1:56287 (ESTABLISHED)\n', stderr: '' },
		'pgrep -f "ssh .* -D (56287)"': { stdout: '123\n', stderr: '' },
	};
}

function sshProcessWithDisconnect() {
	let alive = true;
	return {
		...sshProcessResults(),
		'kill -0 123': (_command, callback) => {
			if (alive) {
				alive = false;
				callback(null, { stdout: '', stderr: '' });
			} else {
				callback(new Error('process exited'));
			}
		},
	};
}

async function activateAndCheck({ remoteName, settings, execResults, tunnelStat } = {}) {
	const harness = loadExtension({ remoteName, settings, execResults, tunnelStat });
	await harness.extension.activate({ subscriptions: [] });
	return harness;
}

describe('extension settings', function () {
	it('enables SSH support by default', async function () {
		assert.strictEqual(packageJson.contributes.configuration[0].properties['remreload.remoteSsh.enabled'].default, true);
		assert.strictEqual(packageJson.contributes.configuration[0].properties['remreload.remoteTunnel.enabled'].default, true);
		const harness = await activateAndCheck({
			remoteName: 'ssh-remote',
			execResults: sshProcessResults(),
		});
		assert.strictEqual(harness.intervals.length, 1);
		await harness.intervals[0]();
		await harness.intervals[0]();
		await harness.intervals[0]();
		assert.ok(harness.calls.length > 0);
	});

	it('skips SSH checks and reloads when SSH support is disabled', async function () {
		const harness = await activateAndCheck({
			remoteName: 'ssh-remote',
			settings: { 'remoteSsh.enabled': false },
		});
		assert.strictEqual(harness.intervals.length, 1);
		await harness.intervals[0]();
		assert.deepStrictEqual(harness.calls, []);
		assert.deepStrictEqual(harness.statCalls, []);
		assert.deepStrictEqual(harness.reloads, []);
	});

	it('skips tunnel checks and reloads when tunnel support is disabled', async function () {
		const harness = await activateAndCheck({
			remoteName: 'tunnel',
			settings: { 'remoteTunnel.enabled': false },
		});
		assert.strictEqual(harness.intervals.length, 1);
		await harness.intervals[0]();
		assert.deepStrictEqual(harness.calls, []);
		assert.deepStrictEqual(harness.statCalls, []);
		assert.deepStrictEqual(harness.reloads, []);
	});

	it('uses an explicitly configured SSH command even when it equals the default', async function () {
		const harness = await activateAndCheck({
			remoteName: 'ssh-remote',
			settings: {
				'remoteSsh.checkConnectivityCommand': { value: DEFAULT_COMMAND, globalValue: DEFAULT_COMMAND },
				checkConnectivityCommand: { value: 'legacy-check', globalValue: 'legacy-check' },
			},
			execResults: sshProcessWithDisconnect(),
		});
		assert.strictEqual(harness.intervals.length, 1);
		await harness.intervals[0]();
		await harness.intervals[0]();
		await harness.intervals[0]();
		assert.ok(harness.calls.includes(DEFAULT_COMMAND));
		assert.ok(!harness.calls.includes('legacy-check'));
		assert.strictEqual(harness.settings.checkConnectivityCommand.globalValue, undefined);
		assert.strictEqual(harness.settings['remoteSsh.checkConnectivityCommand'].globalValue, DEFAULT_COMMAND);
		assert.strictEqual(harness.notifications.length, 1);
	});

	it('migrates the legacy SSH command and clears its old value', async function () {
		const harness = await activateAndCheck({
			remoteName: 'ssh-remote',
			settings: {
				checkConnectivityCommand: { value: 'legacy-check', globalValue: 'legacy-check' },
			},
			execResults: sshProcessWithDisconnect(),
		});
		await harness.intervals[0]();
		await harness.intervals[0]();
		await harness.intervals[0]();
		assert.ok(harness.calls.includes('legacy-check'));
		assert.strictEqual(harness.settings['remoteSsh.checkConnectivityCommand'].globalValue, 'legacy-check');
		assert.strictEqual(harness.settings.checkConnectivityCommand.globalValue, undefined);
		assert.strictEqual(harness.notifications.length, 1);
		await harness.extension.activate({ subscriptions: [] });
		assert.strictEqual(harness.notifications.length, 1);
	});

	it('migrates workspace and folder values at their original scopes', async function () {
		const harness = await activateAndCheck({
			remoteName: 'ssh-remote',
			settings: {
				checkConnectivityCommand: {
					value: 'folder-check', workspaceValue: 'workspace-check', workspaceFolderValue: 'folder-check',
				},
			},
			execResults: sshProcessWithDisconnect(),
		});
		assert.strictEqual(harness.settings['remoteSsh.checkConnectivityCommand'].workspaceValue, 'workspace-check');
		assert.strictEqual(harness.settings['remoteSsh.checkConnectivityCommand'].workspaceFolderValue, 'folder-check');
		assert.strictEqual(harness.settings.checkConnectivityCommand.workspaceValue, undefined);
		assert.strictEqual(harness.settings.checkConnectivityCommand.workspaceFolderValue, undefined);
		await harness.intervals[0]();
		await harness.intervals[0]();
		await harness.intervals[0]();
		assert.ok(harness.calls.includes('folder-check'));
	});

	it('migrates in a local window and leaves tunnel settings independent', async function () {
		const harness = await activateAndCheck({
			settings: { checkConnectivityCommand: { value: 'legacy-check', globalValue: 'legacy-check' } },
		});
		assert.strictEqual(harness.intervals.length, 0);
		assert.strictEqual(harness.settings['remoteSsh.checkConnectivityCommand'].globalValue, 'legacy-check');
		assert.strictEqual(harness.settings['remoteTunnel.checkConnectivityCommand'], undefined);
		assert.strictEqual(harness.notifications.length, 1);
	});

	it('keeps tunnel command configuration independent from the legacy SSH setting', async function () {
		const harness = await activateAndCheck({
			remoteName: 'tunnel',
			settings: {
				'remoteTunnel.checkConnectivityCommand': { value: 'tunnel-check', globalValue: 'tunnel-check' },
				checkConnectivityCommand: { value: 'legacy-check', globalValue: 'legacy-check' },
			},
			tunnelStat: Object.assign(new Error('tunnel unavailable'), { code: 'Unavailable' }),
		});
		assert.strictEqual(harness.intervals.length, 1);
		await harness.intervals[0]();
		await harness.intervals[0]();
		assert.ok(harness.calls.includes('tunnel-check'), JSON.stringify(harness.calls));
		assert.ok(!harness.calls.includes('legacy-check'));
	});

	it('treats a healthy tunnel probe as connected', async function () {
		const harness = await activateAndCheck({ remoteName: 'tunnel' });
		await harness.intervals[0]();
		assert.deepStrictEqual(harness.calls, []);
		assert.deepStrictEqual(harness.reloads, []);
		assert.strictEqual(harness.statCalls.length, 1);
		assert.strictEqual(harness.statCalls[0].path, '/');
	});

	it('retries the tunnel connectivity command after an unavailable probe', async function () {
		let attempts = 0;
		const harness = await activateAndCheck({
			remoteName: 'tunnel',
			tunnelStat: Object.assign(new Error('tunnel unavailable'), { code: 'Unavailable' }),
			execResults: {
				[DEFAULT_COMMAND]: (_command, callback) => {
					attempts += 1;
					callback(attempts === 1 ? new Error('offline') : null, { stdout: '', stderr: '' });
				},
			},
		});
		await harness.intervals[0]();
		await harness.intervals[0]();
		await harness.intervals[0]();
		assert.strictEqual(attempts, 2, JSON.stringify(harness.calls));
		assert.deepStrictEqual(harness.reloads, ['workbench.action.reloadWindow']);
	});

	for (const [name, code] of [
		['Canceled (FileSystemError)', 'Unknown'],
		['Canceled', undefined],
		['FileSystemError', 'Canceled'],
	]) {
		it(`reloads after a canceled tunnel probe (${name}, ${code})`, async function () {
			const harness = await activateAndCheck({
				remoteName: 'tunnel',
				settings: { 'remoteTunnel.checkConnectivityCommand': 'true' },
				tunnelStat: Object.assign(new Error('Canceled'), { name, code }),
			});
			await harness.intervals[0]();
			assert.deepStrictEqual(harness.reloads, []);
			await harness.intervals[0]();
			assert.deepStrictEqual(harness.calls, ['true']);
			assert.deepStrictEqual(harness.reloads, ['workbench.action.reloadWindow']);
			assert.strictEqual(harness.statCalls.length, 1);
		});
	}

	it('does not reload for tunnel probe errors unrelated to connectivity', async function () {
		const harness = await activateAndCheck({
			remoteName: 'tunnel',
			tunnelStat: Object.assign(new Error('permission denied'), { code: 'PermissionDenied' }),
		});
		await harness.intervals[0]();
		assert.deepStrictEqual(harness.reloads, []);
		assert.deepStrictEqual(harness.calls, []);
	});

	it('uses an explicit SSH setting from any configuration scope', async function () {
		const harness = await activateAndCheck({
			remoteName: 'ssh-remote',
			settings: {
				'remoteSsh.checkConnectivityCommand': {
					value: 'folder-check',
					workspaceFolderValue: 'folder-check',
				},
				checkConnectivityCommand: { value: 'legacy-check', globalValue: 'legacy-check' },
			},
			execResults: sshProcessWithDisconnect(),
		});
		await harness.intervals[0]();
		await harness.intervals[0]();
		await harness.intervals[0]();
		assert.ok(harness.calls.includes('folder-check'));
	});

	it('does not reload when a pending connectivity command is disabled', async function () {
		let finish;
		const settings = { 'remoteTunnel.enabled': true };
		const harness = await activateAndCheck({
			remoteName: 'tunnel',
			settings,
			tunnelStat: Object.assign(new Error('tunnel unavailable'), { code: 'Unavailable' }),
			execResults: {
				[DEFAULT_COMMAND]: (_command, callback) => { finish = callback; },
			},
		});
		await harness.intervals[0]();
		const pending = harness.intervals[0]();
		settings['remoteTunnel.enabled'] = false;
		finish(null, { stdout: '', stderr: '' });
		await pending;
		assert.deepStrictEqual(harness.reloads, []);
	});

	it('does not reload after deactivation while a connectivity command is pending', async function () {
		let finish;
		const harness = await activateAndCheck({
			remoteName: 'tunnel',
			tunnelStat: Object.assign(new Error('tunnel unavailable'), { code: 'Unavailable' }),
			execResults: {
				[DEFAULT_COMMAND]: (_command, callback) => { finish = callback; },
			},
		});
		await harness.intervals[0]();
		const pending = harness.intervals[0]();
		harness.extension.deactivate();
		finish(null, { stdout: '', stderr: '' });
		await pending;
		assert.deepStrictEqual(harness.reloads, []);
	});

	it('times out a stalled tunnel probe once and prevents overlapping probes', async function () {
		let statResolve;
		const harness = await activateAndCheck({
			remoteName: 'tunnel',
			tunnelStat: () => new Promise(resolve => { statResolve = resolve; }),
		});
		const pending = harness.intervals[0]();
		await harness.intervals[0]();
		assert.strictEqual(harness.statCalls.length, 1);
		assert.strictEqual(harness.timers[0].delay, 120000);
		await harness.runTimers();
		statResolve({});
		await pending;
		await harness.intervals[0]();
		assert.deepStrictEqual(harness.reloads, ['workbench.action.reloadWindow']);
	});
});
