import type { TunnelStatus } from './tunnel.js';

export type TunnelProgressPhase = 'checking' | 'doctor' | 'starting' | 'validated' | 'stopped';

export interface TunnelProgressReporter {
  phase(value: TunnelProgressPhase): void;
  observe(status: TunnelStatus): void;
  failed(code?: unknown): void;
}

const phases: Record<TunnelProgressPhase, string> = {
  checking: 'Checking local configuration and the verified tunnel client...',
  doctor: 'Checking tunnel client compatibility (up to 30 seconds)...',
  starting: 'Starting the tunnel client; waiting for local MCP readiness and OpenAI connectivity...',
  validated: 'Local tunnel configuration passed. This check does not establish a connection.',
  stopped: 'Tunnel stopped. ChatGPT cannot reach this device until the tunnel is started again.',
};

/** Only fixed messages leave this reporter; neither client logs nor status payloads are relayed. */
export function createTunnelProgressReporter(write: (line: string) => void): TunnelProgressReporter {
  let previous = '';
  const emit = (key: string, message: string) => {
    if (key === previous) return;
    previous = key;
    write(`[WebCodex] ${message}\n`);
  };
  return {
    phase(value) { emit(`phase:${value}`, phases[value]); },
    observe(status) {
      // A ready local process alone does not prove successful control-plane polling.
      if (status.connected === true) {
        const calls = status.state === 'connected_tools_called' &&
          typeof status.successful_tool_calls === 'number' && Number.isFinite(status.successful_tool_calls) && status.successful_tool_calls > 0;
        emit(calls ? 'connected:called' : 'connected:waiting', calls
          ? 'Connected; a ChatGPT tool call has completed successfully. Keep this terminal open; Ctrl+C stops the tunnel.'
          : 'Connected; local MCP is ready and OpenAI polling is current. No successful ChatGPT tool call has been observed yet. Keep this terminal open; Ctrl+C stops the tunnel.');
        return;
      }
      switch (status.state) {
        case 'authentication_or_permission':
          emit('status:authentication', 'Authentication or permission was rejected. Check the configured API key and tunnel access; do not paste credentials into chat.');
          return;
        case 'network_timeout':
          emit('status:network', 'OpenAI connectivity timed out. Check the network and the proxy setting in the configuration; the client may retry.');
          return;
        case 'poll_not_fresh':
          emit('status:poll', 'Waiting for successful OpenAI polling. Check the network and proxy if this persists.');
          return;
        case 'mcp_not_ready':
          emit('status:mcp', 'OpenAI polling is current, but the local MCP service is not ready. Run the local doctor command if this persists.');
          return;
        case 'local_unhealthy':
          emit('status:unhealthy', 'The local tunnel client is not healthy. Check tunnel status and local configuration.');
          return;
        case 'endpoint_mismatch':
        case 'unsafe_health_url':
        case 'invalid_control_file':
        case 'client_unverified':
        case 'launcher_unverified':
          emit('status:unverified', 'Tunnel health could not be verified. Run tunnel status and check the local installation and control files.');
          return;
        case 'disabled':
          emit('status:disabled', 'The tunnel is disabled in the local configuration.');
          return;
        default:
          emit('status:waiting', 'Waiting for local tunnel health. If this persists, run tunnel status in another terminal.');
      }
    },
    failed(code) {
      const message = code === 'TUNNEL_ALREADY_RUNNING'
        ? 'A launcher lock already exists; it may belong to an existing connection or remain after an interrupted launch. Run tunnel status with the same --config selection before inspecting the lock locally.'
        : code === 'TUNNEL_CONTROL_UNAVAILABLE'
          ? 'The tunnel launcher lock could not be created. Check the local control directory, filesystem availability and write permissions.'
          : code === 'TUNNEL_DOCTOR_TIMEOUT'
          ? 'The local tunnel configuration check timed out. Check the client installation and configuration.'
          : code === 'TUNNEL_DOCTOR_FAILED'
            ? 'The local tunnel configuration check failed. Check the client installation and configuration.'
            : 'The tunnel could not continue. Review the safe error below and run tunnel status for local diagnostics.';
      emit('failed', message);
    },
  };
}
