/**
 * Start the adapter-node server and fail fast if its HTTP listener disappears.
 *
 * systemd can only restart a service after its process exits.  Keep a small
 * watchdog in the same process so a detached listener becomes a recoverable
 * failure instead of a silent outage.
 *
 * Pure helpers (probeHostFor / listenerUrl / parseEnvPositiveInt) are exported
 * for tests; the process-global wiring runs only when this file is the entry
 * point (guarded by `import.meta.main`).
 */

const MAX_CONSECUTIVE_FAILURES = 2;

/**
 * Parse a positive integer from an env var, accepting underscores as
 * thousands separators (e.g. "10_000"). Falls back to `fallbackMs` when the
 * var is unset. Rejects missing/invalid/non-positive values so a misconfigured
 * deploy fails loudly instead of promising to poll faster than it does.
 */
export function parseEnvPositiveInt(raw: string | undefined, fallbackMs: number): number {
  const resolved = raw === undefined ? String(fallbackMs) : raw;
  const value = Number(resolved.replaceAll('_', ''));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `invalid env integer ${JSON.stringify(raw)}; expected a positive integer, e.g. "10_000"`,
    );
  }
  return value;
}

/**
 * Derive the address the watchdog should actually connect to.
 *
 * `HOST` is for binding only; a wildcard bind (0.0.0.0, ::) is NOT a
 * connectable destination. Probe a loopback literal instead so the listener is
 * reachable over the loopback interface regardless of bind host.
 */
export function probeHostFor(bindHost: string): string {
  const b = bindHost.trim();
  switch (b) {
    case '':
    case '0.0.0.0':
      return '127.0.0.1';
    case '::':
    case '[::]':
      return '[::1]';
    default:
      // Already-loopback, a specific interface, or a resolvable hostname: use it
      // as-is. A bare IPv6 literal is bracketed by listenerUrl() below.
      return b;
  }
}

/** Build the watchdog probe URL; bracket bare IPv6 literals as WHATWG URLs require. */
export function listenerUrl(probeHost: string, port: number): string {
  const urlHost = probeHost.includes(':') && !probeHost.startsWith('[') ? `[${probeHost}]` : probeHost;
  return `http://${urlHost}:${port}/`;
}

if (import.meta.main) {
  const port = parseEnvPositiveInt(process.env['PORT'], 8787);
  const bindHost = process.env['HOST'] ?? '127.0.0.1';
  const probeHost = probeHostFor(bindHost);
  const url = listenerUrl(probeHost, port);
  const intervalMs = parseEnvPositiveInt(process.env['HEALTHWATCH_INTERVAL_MS'], 10_000);
  const requestTimeoutMs = parseEnvPositiveInt(process.env['HEALTHWATCH_TIMEOUT_MS'], 3_000);
  const startupGraceMs = parseEnvPositiveInt(process.env['HEALTHWATCH_STARTUP_GRACE_MS'], 15_000);

  async function listenerIsHealthy(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(url, {
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

  console.info(`[healthwatch] monitoring ${url} every ${intervalMs}ms`);
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
    console.error(`[healthwatch] listener check failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      fatal(`listener unavailable at ${url}; requesting systemd restart`);
    }
  };

  setInterval(() => void check(), intervalMs);
  void check();
}
