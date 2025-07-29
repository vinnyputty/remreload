import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

let checkConnectivity = false;
let connectivityCheckRunning = false;
let interval: NodeJS.Timeout | null = null;
let outputChannel: vscode.OutputChannel;

function log(msg: string) {
	outputChannel.appendLine(msg);
}

function debugLog(msg: string) {
	if (getConfig<string>('logDebugLevel') === 'debug') {
		outputChannel.appendLine(`[DEBUG] ${msg}`);
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

export async function activate(_context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel('Remreload');
	// Check if running on supported platform (Mac or Linux)
	if (process.platform !== 'darwin' && process.platform !== 'linux') {
		const errorMsg = "Remreload only supports running on Mac and Linux";
		log(errorMsg);
		vscode.window.showErrorMessage(errorMsg);
		return;
	}

	if (vscode.env.remoteName === 'ssh-remote') {
		let sshPid: number | null = null;
		try {
			sshPid = await getSshPid();
		} catch (error) {
			log('Error finding SSH process: ' + error);
			throw error;
		}

		log(`SSH process PID: ${sshPid}`);
		log(`Starting at ${new Date()}`);

		interval = setInterval(async () => {
			if (!checkConnectivity) {
				if (sshPid !== null) {
					try {
						// Check if SSH process is still running.
						await execAsync(`kill -0 ${sshPid}`);
					} catch (error) {
						log(`SSH process ${sshPid} is no longer running, starting connectivity checks`);
						checkConnectivity = true;
					}
				}
			} else {
				if (connectivityCheckRunning) {
					log('Connectivity check already running, skipping');
					return;
				}

				connectivityCheckRunning = true;
				try {
					await execAsync(getConfig<string>('checkConnectivityCommand'));
					log('Connectivity check succeeded, reloading');
					vscode.commands.executeCommand('workbench.action.reloadWindow');
				} catch (error) {
					log(`Connectivity check failed: ${error}`);
				} finally {
					connectivityCheckRunning = false;
				}
			}
		}, 5000);
	} else {
		log('Not activating because this is not a remote workspace: vscode.env.remoteName = ' + vscode.env.remoteName);
	}
}

// this method is called when your extension is deactivated
export function deactivate() {
	if (interval) {
		clearInterval(interval);
	}
}
