# Remreload

<img src="icon.png" alt="Remreload icon" width="64">

<br>

I got tired of having to manually reload multiple different Remote SSH
workspaces in Visual Studio Code after waking my computer from sleep (and VSCode
isn't the fastest thing to reload either). This extension helps **Rem**ote
workspaces get **reload**ed automatically.

This extension detects when the SSH connection is lost by deducing the SSH
process that VSCode uses for the remote connection. When the SSH process is no
longer running, it reloads the window. You can also configure the connectivity
check command to ensure that a network/VPN connection is established - Remreload
waits until this command returns success before triggering window reload. As an
example, set `remreload.checkConnectivityCommand` to
`ssh -o ConnectTimeout=5 <remote_dest> 'exit'` (replace `<remote_dest>` as
appropriate).

**Note:** This extension only supports VSCode running on Mac and Linux, as it
detects the appropriate SSH process using techniques that are not available on
Windows.

## Attribution

Icons are combined from the ones made by [Roundicons
Premium](https://www.flaticon.com/authors/roundicons-premium) and
[Freepik](https://www.freepik.com) on
[www.flaticon.com](https://www.flaticon.com/).
