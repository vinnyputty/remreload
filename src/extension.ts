import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

let checkConnectivity = false;
let checkRunning = false;
let active = false;
let cancelTunnelProbe: (() => void) | undefined;
let interval: NodeJS.Timeout | null = null;
let outputChannel: vscode.OutputChannel;

type RemoteType = 'remoteSsh' | 'remoteTunnel';

function getConnectivityCommand(remoteType: RemoteType): string {
	const folder = vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0] : undefined;
	return vscode.workspace.getConfiguration('remreload', folder?.uri)
		.get<string>(`${remoteType}.checkConnectivityCommand`)!;
}

async function migrateConnectivityCommand() {
	const oldKey = 'checkConnectivityCommand';
	const newKey = 'remoteSsh.checkConnectivityCommand';
	const configurations = [
		{ config: vscode.workspace.getConfiguration('remreload'), targets: [
			vscode.ConfigurationTarget.Global, vscode.ConfigurationTarget.Workspace
		] },
		...(vscode.workspace.workspaceFolders ?? []).map(folder => ({
			config: vscode.workspace.getConfiguration('remreload', folder.uri),
			targets: [vscode.ConfigurationTarget.WorkspaceFolder]
		}))
	];
	let migrated = false;
	for (const { config, targets } of configurations) {
		for (const target of targets) {
			const oldSetting = config.inspect<string>(oldKey);
			const newSetting = config.inspect<string>(newKey);
			const value = target === vscode.ConfigurationTarget.Global ? oldSetting?.globalValue
				: target === vscode.ConfigurationTarget.Workspace ? oldSetting?.workspaceValue
					: oldSetting?.workspaceFolderValue;
			const existing = target === vscode.ConfigurationTarget.Global ? newSetting?.globalValue
				: target === vscode.ConfigurationTarget.Workspace ? newSetting?.workspaceValue
					: newSetting?.workspaceFolderValue;
			if (value === undefined) {
				continue;
			}
			if (existing === undefined) {
				await config.update(newKey, value, target);
			}
			await config.update(oldKey, undefined, target);
			migrated = true;
		}
	}
	if (migrated) {
		log(`Migrated remreload.${oldKey} to remreload.${newKey}`);
		void vscode.window.showInformationMessage(`Remreload migrated the legacy SSH connectivity setting to remreload.${newKey}. Existing values of the new setting were kept.`);
	}
}

function log(msg: string, level: 'INFO' | 'DEBUG' | 'WARN' | 'ERROR' = 'INFO') {
	const timestamp = new Date().toISOString();
	for (const line of msg.split(/\r?\n/)) {
		if (line.trim()) {
			outputChannel.appendLine(`[${timestamp}] [${level}] ${line.trimEnd()}`);
		}
	}
}

function debugLog(msg: string) {
	if (getConfig<string>('logDebugLevel') === 'debug') {
		log(msg, 'DEBUG');
	}
}

function getConfig<T>(key: string): T {
	return vscode.workspace.getConfiguration('remreload').get<T>(key)!;
}

async function getSshPid(): Promise<number> {
	const currentPid = process.pid;
	debugLog(`Current PID: ${currentPid}`);

	// We use some hacky methods to find the SSH process that this VSCode instance is using for the remote connection. Unfortunately VSCode doesn't give us a better way to detect the remote connection.
	try {
		// Find all established TCP connections.
		const { stdout: lsofOutput } = await execAsync(`lsof -Pan -p ${currentPid} -i tcp`);
		const establishedLines = lsofOutput
			.split('\n')
			.filter(line => line.includes('ESTABLISHED'));
		debugLog(`Established connections:\n${establishedLines.join('\n')}`);

		// Extract destination ports from lines like: TCP 127.0.0.1:53009->127.0.0.1:56287 (ESTABLISHED)
		const destinationPorts: string[] = [];
		for (const line of establishedLines) {
			const match = line.match(/127\.0\.0\.1:\d+->127\.0\.0\.1:(\d+)/);
			if (match) {
				destinationPorts.push(match[1]);
			}
		}
		if (destinationPorts.length === 0) {
			throw new Error('No destination ports found in established connections');
		}
		debugLog(`Destination ports: ${destinationPorts.join(', ')}`);

		// Find SSH process with -D flag matching any of these ports
		const portPattern = destinationPorts.join('|');
		const { stdout: pgrepOutput } = await execAsync(`pgrep -f "ssh .*-D (${portPattern})"`);
		debugLog(`Matching SSH PIDs:\n${pgrepOutput}`);
		const firstLine = pgrepOutput.trim().split('\n')[0];
		if (!firstLine) {
			throw new Error(`No SSH process found with the expected ports`);
		}

		const sshPid = parseInt(firstLine);
		debugLog(`Found SSH PID: ${sshPid}`);
		return sshPid;
	} catch (error) {
		throw new Error('Error finding SSH process: ' + error);
	}
}

// A filesystem request crosses the tunnel, unlike the local connectivity command.
// Probe the root so deleting or renaming a workspace folder isn't a disconnect.
async function isTunnelConnected(): Promise<boolean> {
	const uri = vscode.workspace.workspaceFolders?.map(folder => folder.uri)
		.find(uri => uri.scheme === 'vscode-remote')
		?? (vscode.workspace.workspaceFile?.scheme === 'vscode-remote' ? vscode.workspace.workspaceFile : undefined)
		?? vscode.workspace.textDocuments.find(document => document.uri.scheme === 'vscode-remote')?.uri;
	if (!uri) {
		debugLog('Waiting for an open remote folder or file to monitor the tunnel');
		return true;
	}

	return new Promise<boolean>(resolve => {
		let settled = false;
		const finish = (connected: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			cancelTunnelProbe = undefined;
			resolve(connected);
		};
		const timeout = setTimeout(() => {
			log('Tunnel filesystem probe timed out after 2 minutes', 'WARN');
			finish(false);
		}, 120000);
		cancelTunnelProbe = () => finish(true);
		vscode.workspace.fs.stat(uri.with({ path: '/', query: '', fragment: '' })).then(
			() => finish(true),
			(error: vscode.FileSystemError) => {
				if (settled) {
					return;
				}
				// VS Code wraps remote RPC cancellation with code "Unknown" and
				// name "Canceled (FileSystemError)". It isn't a remote response.
				if (error.code === 'Unavailable' || error.code === 'Canceled'
					|| error.name === 'Canceled' || error.name === 'Canceled (FileSystemError)') {
					debugLog(`Tunnel filesystem probe failed: ${error}`);
					finish(false);
				} else {
					// File errors aren't evidence of a lost connection.
					debugLog(`Tunnel filesystem probe returned: ${error}`);
					finish(true);
				}
			}
		);
	});
}

export async function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('Remreload');
	context.subscriptions.push(outputChannel, { dispose: deactivate });
	try {
		await migrateConnectivityCommand();
	} catch (error) {
		const message = `Remreload could not migrate the legacy SSH connectivity setting: ${error}`;
		log(message, 'ERROR');
		vscode.window.showErrorMessage(message);
		return;
	}
	const remoteType: RemoteType | undefined = vscode.env.remoteName === 'ssh-remote' ? 'remoteSsh'
		: vscode.env.remoteName === 'tunnel' ? 'remoteTunnel' : undefined;
	if (!remoteType) {
		log('Not activating for remote type: ' + vscode.env.remoteName);
		return;
	}
	// Check if running on supported platform (Mac or Linux).
	if (process.platform !== 'darwin' && process.platform !== 'linux') {
		const errorMsg = 'Remreload only supports running on Mac and Linux';
		log(errorMsg, 'ERROR');
		vscode.window.showErrorMessage(errorMsg);
		return;
	}

	active = true;
	checkConnectivity = false;
	checkRunning = false;
	let sshPid: number | null = null;
	const enabled = () => active && getConfig<boolean>(`${remoteType}.enabled`);
	log(`Starting ${remoteType} monitoring`);

	interval = setInterval(async () => {
		if (!enabled()) {
			checkConnectivity = false;
			return;
		}
		if (checkRunning) {
			debugLog('Connection check already running, skipping');
			return;
		}
		checkRunning = true;
		try {
			if (!checkConnectivity) {
				switch (remoteType) {
					case 'remoteSsh':
						if (sshPid === null) {
							sshPid = await getSshPid();
							log(`SSH process PID: ${sshPid}`);
						}
						if (!enabled()) {
							return;
						}
						try {
							await execAsync(`kill -0 ${sshPid}`);
						} catch (error) {
							log(`SSH process ${sshPid} is no longer running, starting connectivity checks`, 'WARN');
							checkConnectivity = true;
						}
						break;
					case 'remoteTunnel':
						checkConnectivity = !await isTunnelConnected();
						if (checkConnectivity) {
							log('Tunnel is unresponsive, starting connectivity checks', 'WARN');
						}
						break;
				}
			} else {
				await execAsync(getConnectivityCommand(remoteType));
				if (enabled()) {
					log('Connectivity check succeeded, reloading');
					await vscode.commands.executeCommand('workbench.action.reloadWindow');
					deactivate();
				}
			}
		} catch (error) {
			log(`Connection check failed: ${error}`, 'WARN');
		} finally {
			if (!enabled()) {
				checkConnectivity = false;
			}
			checkRunning = false;
		}
	}, 5000);
}

export function deactivate() {
	active = false;
	if (interval) {
		clearInterval(interval);
		interval = null;
	}
	cancelTunnelProbe?.();
}
