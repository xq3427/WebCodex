import { AppError } from './errors.js';
import path from 'node:path';

/** Local configuration only. These variables affect common build/test behavior without loading code. */
export const EXECUTION_ENV_NAMES = Object.freeze([
  'CI', 'NODE_ENV', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'PYTHONUTF8',
  'NO_COLOR', 'FORCE_COLOR', 'TZ', 'LANG', 'LC_ALL', 'OMP_NUM_THREADS',
  'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS', 'CUDA_VISIBLE_DEVICES',
] as const);
const allowed = new Set<string>(EXECUTION_ENV_NAMES);

function validValue(name: string, value: string): boolean {
  if (Buffer.byteLength(value) > 256 || /[\x00-\x1f\x7f]/.test(value)) return false;
  if (name === 'NODE_ENV') return /^(development|test|production)$/.test(value);
  if (name === 'CI') return /^(true|false|0|1)$/.test(value);
  if (name.startsWith('PYTHON')) return /^(0|1)$/.test(value);
  if (name === 'NO_COLOR') return /^(|0|1|true|false)$/.test(value);
  if (name === 'FORCE_COLOR') return /^(0|1|2|3|true|false)$/.test(value);
  if (name.endsWith('_NUM_THREADS')) return /^(?:[1-9][0-9]{0,3})$/.test(value) && Number(value) <= 4096;
  if (name === 'CUDA_VISIBLE_DEVICES') return /^(?:|-1|[0-9]+(?:,[0-9]+)*)$/.test(value);
  if (name === 'TZ') return /^[a-zA-Z0-9_+./:-]{1,100}$/.test(value) && !value.includes('..');
  return /^[a-zA-Z0-9_.@+-]{1,100}$/.test(value); // LANG and LC_ALL.
}

export function validExecutionEnvironment(input: unknown): input is Record<string, string> {
  if (input === undefined) return true;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return false;
  return Object.entries(input).every(([name, value]) => allowed.has(name) && typeof value === 'string' && validValue(name, value));
}

export function normalizeExecutionEnvironment(input?: unknown): Record<string, string> {
  if (!validExecutionEnvironment(input)) throw new AppError('INVALID_EXECUTION_ENV', 'Execution environment must use supported non-sensitive variable names and values from the local configuration.');
  return { ...(input ?? {}) };
}

/** Credentials and runtime injection variables are never inherited. PATH is inherited only from the host. */
export function executionEnvironment(configured?: unknown, executable?: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const inherited = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']);
  // Windows OpenSSH reads ProgramData before initializing its logger. Omitting
  // it can make even `ssh -V` exit 255 without producing stderr. Preserve the
  // host's system directory instead of guessing a drive or allowing an override.
  if (process.platform === 'win32') inherited.add('PROGRAMDATA');
  for (const [key, value] of Object.entries(process.env)) {
    if (inherited.has(key.toUpperCase()) && value !== undefined) result[key] = value;
  }
  for (const [name, value] of Object.entries(normalizeExecutionEnvironment(configured))) {
    // Windows environment variable names are case insensitive.
    for (const key of Object.keys(result)) if (key.toUpperCase() === name) delete result[key];
    result[name] = value;
  }
  if (process.platform === 'win32') {
    // npm 10 requires ComSpec for lifecycle scripts. Derive the OS interpreter
    // from SystemRoot instead of inheriting an arbitrary parent shell override.
    const systemRoot = Object.entries(result).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1];
    if (systemRoot && path.win32.isAbsolute(systemRoot)) result.ComSpec = path.win32.join(systemRoot, 'System32', 'cmd.exe');
  }
  if (executable) {
    const inheritedPath = Object.entries(result).find(([key]) => key.toUpperCase() === 'PATH')?.[1];
    for (const key of Object.keys(result)) if (key.toUpperCase() === 'PATH') delete result[key];
    result.PATH = path.dirname(executable) + (inheritedPath ? path.delimiter + inheritedPath : '');
  }
  return result;
}
