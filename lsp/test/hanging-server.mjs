// Deliberately never responds to any request: keeps the process alive so the
// client's initialize request hangs until it is cancelled, timed out, or the
// process is killed. Mirrors a language server that stalls during startup.
setInterval(() => {}, 1 << 30);
