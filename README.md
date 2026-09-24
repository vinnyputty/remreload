# Remreload

<img src="icon.png" alt="Remreload icon" width="64">

<br>

I got tired of having to manually reload multiple different Remote SSH
workspaces in Visual Studio Code after waking my computer from sleep (and VSCode
isn't the fastest thing to reload either). This extension helps **Rem**ote
workspaces get **reload**ed automatically. **Remreload** automatically reloads
Remote SSH and Remote Tunnel windows in Visual Studio Code after a connection is
lost and local connectivity recovers.

For SSH, the extension identifies VS Code's SSH process and checks every five
seconds whether it is still running. For tunnels, it probes the remote
filesystem root every five seconds. An unavailable or canceled request, or a
probe that takes longer than two minutes triggers connectivity checks. Tunnel
monitoring requires an open remote folder or file. Empty tunnel windows are not
supported. A slow remote filesystem can also trigger a reload.

After detecting a disconnect, **Remreload** runs the connectivity command for
that connection type on the **local machine**, retrying every five seconds until
it succeeds, then reloads the window. Commands run one at a time, with no
additional timeout; include a timeout in your command if needed.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `remreload.remoteSsh.enabled` | `true` | Enable SSH monitoring, connectivity checks, and automatic reloads. |
| `remreload.remoteTunnel.enabled` | `true` | Enable tunnel monitoring, connectivity checks, and automatic reloads. |
| `remreload.remoteSsh.checkConnectivityCommand` | `ping -t 1 -c 1 google.com` | Local connectivity command for SSH sessions. |
| `remreload.remoteTunnel.checkConnectivityCommand` | `ping -t 1 -c 1 google.com` | Local connectivity command for tunnel sessions. |
| `remreload.logDebugLevel` | `normal` | Set to `debug` for verbose logs in the Remreload output channel. |

Settings take effect without reloading. Disabling a connection type stops
further checks and automatic reloads for that type; a command already running
may finish.

Each line in the Remreload output channel includes an ISO 8601 UTC timestamp and
a level (`INFO`, `WARN`, `ERROR`, or `DEBUG`). Multiline command errors are
logged with a prefix on every nonempty line.

To wait for an SSH host or VPN to become reachable, for example, set
`remreload.remoteSsh.checkConnectivityCommand` to
`ssh -o ConnectTimeout=5 <remote_dest> 'exit'` (replace `<remote_dest>` as
appropriate).

On activation, Remreload moves explicitly configured values of the deprecated
`remreload.checkConnectivityCommand` to
`remreload.remoteSsh.checkConnectivityCommand` at the same User, Workspace, or
folder scope, then removes the old value and shows a notification. An existing
new value at the same scope is kept. Tunnel sessions use their own command
setting independently.

**Note:** This extension supports the VS Code desktop application running on Mac
and Linux. SSH process detection uses tools unavailable on Windows.

## Attribution

Icons are combined from the ones made by [Roundicons
Premium](https://www.flaticon.com/authors/roundicons-premium) and
[Freepik](https://www.freepik.com) on
[www.flaticon.com](https://www.flaticon.com/).
