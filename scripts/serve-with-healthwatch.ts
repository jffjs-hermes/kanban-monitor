/**
 * Start the adapter-node server and fail fast if its HTTP listener disappears.
 *
 * systemd can only restart a service after its process exits.  Keep a small
 * watchdog in the same process so a detached listener becomes a recoverable
 * failure instead of a silent outage.
 */

const port = Number.parseInt(process.env['PORT'] ?? '8787', 10);
const host = process.env['HOST'] ?? '127.0.0.1';
const intervalMs = Number.parseInt(process.env['HEALTHWATCH_INTERVAL_MS'] ?? '10_000', 10);
const requestTimeoutMs = Number.parseInt(process.env['HEALTHWATCH_TIMEOUT_MS'] ?? '3_000', 10);
const startupGraceMs = Number.parseInt(process.env['HEALTHWATCH_STARTUP_GRACE_MS'] ?? '15_000', 10);
const maxConsecutiveFailures = 2;

function listenerUrl(): string {
  // A bracketed IPv6 host is required in a URL; normal service hosts are not.
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${urlHost}:${port}/`;
}

async function listenerIsHealthy(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(listenerUrl(), {
      signal: controller.signal,
      headers: { connection: 'close' },
    });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function fatal(message: string, error?: unknown): never {
  console.error(`[healthwatch] ${message}`, error ?? '');
  process.exit(1);
}

process.on('uncaughtException', (error) => fatal('uncaught exception; requesting systemd restart', error));
process.on('unhandledRejection', (error) => fatal('unhandled rejection; requesting systemd restart', error));

try {
  await import('../build/index.js');
} catch (error) {
  fatal('server failed to start', error);
}

console.info(`[healthwatch] monitoring ${listenerUrl()} every ${intervalMs}ms`);
let consecutiveFailures = 0;
const startedAt = Date.now();

const check = async () => {
  if (Date.now() - startedAt < startupGraceMs) return;
  if (await listenerIsHealthy()) {
    if (consecutiveFailures > 0) console.info('[healthwatch] listener recovered');
    consecutiveFailures = 0;
    return;
  }

  consecutiveFailures += 1;
  console.error(`[healthwatch] listener check failed (${consecutiveFailures}/${maxConsecutiveFailures})`);
  if (consecutiveFailures >= maxConsecutiveFailures) {
    fatal(`listener unavailable at ${listenerUrl()}; requesting systemd restart`);
  }
};

setInterval(() => void check(), intervalMs);
void check();
