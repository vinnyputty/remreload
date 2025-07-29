# Change Log

## [0.1.0]

 - Switch to different approach for detecting disconnected remote, using the SSH process.
   - This assumes more about the internal implementation of remote development but I've found it to be more reliable.
   - It also means Windows is no longer supported (on the local machine running the VSCode UI). I'm not sure it ever worked properly but you can install the older version if you need it on Windows.

## [0.0.3]

 - Log timestamp when starting.

## [0.0.2]

 - Output logs to a new output channel.
 - Change default Assume Disconnected Minutes from 60 to 20.

## [0.0.1]

- Initial release