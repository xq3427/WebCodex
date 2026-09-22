import { AppError } from './errors.js';
import { startLocalPanel } from './local-panel.js';
import { PanelConfigService } from './panel-config.js';
import { PanelRuntime, runPanelHttp } from './panel-runtime.js';
import { runTunnel, type TunnelProgressEvent } from './tunnel.js';
import { createTunnelProgressReporter } from './tunnel-progress.js';
import type { AppConfig } from './types.js';

export interface ManagedPanelOptions {
  autoStart?: boolean;
  port?: number;
  fallbackPort?: boolean;
  /** Human terminal output only. The caller must never route this to MCP stdout. */
  write: (line: string) => void;
  onProgress?: (event: TunnelProgressEvent) => void;
}

const remainsAvailable = '[WebCodex] The local dashboard remains available. Review its status and settings, then start the service from the page.\n';
const externalService = '[WebCodex] Another launcher owns this service. Keep it running, or stop it in its original terminal before starting it from this dashboard.\n';

function ownsPort(error: unknown): boolean {
  return error instanceof AppError && error.code === 'PANEL_START_FAILED' &&
    typeof error.details === 'object' && error.details !== null &&
    'reason' in error.details && error.details.reason === 'address_in_use';
}

/** A human CLI entry point; the page and its runtime share ownership of one managed service. */
export async function startManagedPanel(config: AppConfig, options: ManagedPanelOptions): Promise<{ url: string; close: () => Promise<void> }> {
  let listener: Awaited<ReturnType<typeof startLocalPanel>> | undefined;
  let outputFailed = false;
  let manager: PanelRuntime;
  const close = async () => {
    // A busy or unverified job leaves the page available, so users can retry normal shutdown.
    await manager.close();
    await listener?.close();
  };
  const progressWrite = (line: string) => {
    if (outputFailed) return;
    try { options.write(line); }
    catch {
      outputFailed = true;
      // Do not deadlock the active run by awaiting its own shutdown from an observer.
      void close().catch(() => { /* Job protection retains ownership until normal shutdown is possible. */ });
    }
  };
  const failureNotice = (error: unknown) => {
    if (error instanceof AppError && ['PANEL_EXTERNAL_SERVICE', 'TUNNEL_ALREADY_RUNNING'].includes(error.code)) progressWrite(externalService);
    else progressWrite('[WebCodex] The service could not start or continue. No successful connection is being reported.\n');
    progressWrite(remainsAvailable);
  };
  manager = new PanelRuntime(config.configPath, {
    run: async (snapshot, launch) => {
      const http = snapshot.server?.transport === 'http';
      const reporter = createTunnelProgressReporter(progressWrite);
      let httpReadyReported = false;
      const onProgress = (event: TunnelProgressEvent) => {
        // Runtime state updates always run; a terminal or optional observer cannot suppress them.
        try { launch.onProgress?.(event); } catch { /* Observers do not control lifecycle. */ }
        try { options.onProgress?.(event); } catch { /* Observers do not control lifecycle. */ }
        if (http) {
          if (!httpReadyReported && event.type === 'status' && event.status.state === 'local_http_ready' && event.status.connected) {
            httpReadyReported = true;
            progressWrite('[WebCodex] Local MCP HTTP service is ready. ChatGPT connectivity has not been verified.\n');
          }
        } else if (event.type === 'phase') reporter.phase(event.phase);
        else reporter.observe(event.status);
      };
      try {
        if (http && !launch.signal?.aborted) progressWrite('[WebCodex] Starting the configured local MCP HTTP service...\n');
        const result = await (http ? runPanelHttp : runTunnel)(snapshot, { ...launch, onProgress });
        if (!launch.signal?.aborted) progressWrite('[WebCodex] The managed service stopped. The dashboard stays open and can start it again.\n');
        return result;
      } catch (error) {
        if (!launch.signal?.aborted && !(error instanceof AppError && error.code === 'TUNNEL_CANCELLED')) failureNotice(error);
        throw error;
      }
    },
  });
  let port = options.port ?? config.localPanel?.port ?? 8767;
  // Do not let an automatically opened page consume the configured MCP HTTP port.
  const servicePortReserved = options.autoStart && config.server?.transport === 'http' && port === config.http.port;
  if (servicePortReserved) port = 0;
  let fallbackUsed = false;
  const management = { config: new PanelConfigService(config.configPath), runtime: manager };
  try {
    try { listener = await startLocalPanel(config, { port, management, onRuntimeAction: (action, status) => {
      const state = status && typeof status === 'object' && 'state' in status ? String((status as { state?: unknown }).state) : 'unknown';
      progressWrite(`[WebCodex] Dashboard requested service ${action}; current state: ${state}.\n`);
    }}); }
    catch (error) {
      if (!options.fallbackPort || port === 0 || !ownsPort(error)) throw error;
      fallbackUsed = true;
      listener = await startLocalPanel(config, { port: 0, management, onRuntimeAction: (action, status) => {
        const state = status && typeof status === 'object' && 'state' in status ? String((status as { state?: unknown }).state) : 'unknown';
        progressWrite(`[WebCodex] Dashboard requested service ${action}; current state: ${state}.\n`);
      }});
    }
  } catch (error) {
    await close();
    throw error;
  }
  try {
    // The sole private URL is one complete line, allowing terminal Ctrl+click without copying credentials.
    if (fallbackUsed) options.write('[WebCodex] The configured dashboard port is occupied; using another local port for this run. Configuration is unchanged.\n');
    if (servicePortReserved) options.write('[WebCodex] The configured MCP HTTP port is reserved for the service; using another local dashboard port for this run.\n');
    options.write('[WebCodex] Open this private local dashboard to manage configuration and the service:\n');
    options.write(listener.url + '\n');
    options.write('[WebCodex] Keep this terminal open. This temporary dashboard credential is separate from your API key.\n');
  } catch {
    await close();
    throw new AppError('PANEL_START_FAILED', 'The local dashboard launch could not be reported.');
  }
  if (options.autoStart) {
    try { await manager.action({ action: 'start' }); }
    catch (error) { failureNotice(error); }
  }
  return { url: listener.url, close };
}
