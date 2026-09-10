import test from 'node:test';
import assert from 'node:assert/strict';
import { createTunnelProgressReporter } from '../src/tunnel-progress.js';
import type { TunnelStatus } from '../src/tunnel.js';

function fixture() {
  const lines: string[] = [];
  return { lines, reporter: createTunnelProgressReporter(line => lines.push(line)) };
}

const status = (state: string, extra: Partial<TunnelStatus> = {}): TunnelStatus =>
  ({ state, connected: false, exit_code: 3, ...extra });

test('tunnel progress describes foreground startup and only reports connection after a health observation', () => {
  const { lines, reporter } = fixture();
  reporter.phase('checking');
  reporter.phase('doctor');
  reporter.phase('starting');
  reporter.observe(status('mcp_not_ready', { live: true, poll_fresh: true }));
  assert.equal(lines.length, 4);
  assert.ok(lines.every(line => !line.includes('Connected;')));
  reporter.observe(status('connected_no_tool_calls', { connected: true, exit_code: 0 }));
  assert.match(lines.at(-1)!, /Connected;.*No successful ChatGPT tool call.*Keep this terminal open; Ctrl\+C stops/);
  reporter.observe(status('connected_tools_called', { connected: true, successful_tool_calls: 1, exit_code: 0 }));
  assert.match(lines.at(-1)!, /a ChatGPT tool call has completed successfully/);
  reporter.phase('stopped');
  assert.match(lines.at(-1)!, /Tunnel stopped/);
});

test('tunnel progress suppresses repeated health polls but reports connection loss and recovery', () => {
  const { lines, reporter } = fixture();
  reporter.observe(status('not_running'));
  reporter.observe(status('diagnostics_unavailable'));
  reporter.observe(status('stale_health_file'));
  assert.equal(lines.length, 1);
  reporter.observe(status('connected_tools_called', { connected: true, successful_tool_calls: 2 }));
  reporter.observe(status('connected_tools_called', { connected: true, successful_tool_calls: 999 }));
  assert.equal(lines.length, 2);
  reporter.observe(status('network_timeout'));
  reporter.observe(status('network_timeout'));
  reporter.observe(status('connected_tools_called', { connected: true, successful_tool_calls: 999 }));
  assert.equal(lines.length, 4);
  assert.match(lines[2], /connectivity timed out/);
  assert.match(lines[3], /Connected;/);
});

test('tunnel progress never forwards unknown status values, paths, credentials or diagnostic fields', () => {
  const { lines, reporter } = fixture();
  const secret = 'synthetic-key-must-not-be-displayed';
  const poisoned = {
    health_url_file: secret, last_error_category: secret, route_mode: secret,
    message: secret, error: secret, apiKey: secret, control_plane_tunnel_id: secret,
  };
  reporter.observe(status(secret, poisoned));
  reporter.observe(status('authentication_or_permission', poisoned));
  reporter.observe(status('endpoint_mismatch', poisoned));
  reporter.failed(secret);
  reporter.failed({ code: secret, message: secret });
  assert.equal(lines.length, 4);
  assert.ok(!lines.join('').includes(secret));
  assert.match(lines[1], /Authentication or permission/);
  assert.match(lines[2], /health could not be verified/);
  assert.ok(lines.every(line => line.startsWith('[WebCodex] ') && line.endsWith('\n')));
});

test('doctor-only success and launch failures have distinct fixed progress messages', () => {
  for (const [code, pattern] of [
    ['TUNNEL_ALREADY_RUNNING', /lock already exists;.*may belong.*remain after.*tunnel status with the same --config/],
    ['TUNNEL_CONTROL_UNAVAILABLE', /lock could not be created.*control directory.*write permissions/],
    ['TUNNEL_DOCTOR_TIMEOUT', /check timed out/],
    ['TUNNEL_DOCTOR_FAILED', /check failed/],
    ['UNKNOWN', /could not continue/],
  ] as const) {
    const { lines, reporter } = fixture();
    reporter.phase('validated');
    reporter.failed(code);
    assert.match(lines[0], /does not establish a connection/);
    assert.match(lines[1], pattern);
  }
});
