import { chmod, lstat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from './errors.js';

const run = promisify(execFile);

/** Local user configuration now contains credentials. Never forward ACL tool diagnostics. */
export async function protectConfigFile(file: string, directory = false): Promise<void> {
  try {
    const info = await lstat(file, { bigint: true });
    if (!(directory ? info.isDirectory() : info.isFile() && info.nlink === 1n) || info.isSymbolicLink()) throw new Error();
    if (process.platform !== 'win32') { await chmod(file, directory ? 0o700 : 0o600); return; }
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error();
    const system32 = path.join(systemRoot, 'System32');
    // A fresh DACL also removes pre-existing explicit grants. icacls /grant:r alone
    // replaces only the named principals and can leave an Everyone grant intact.
    const script = `$ErrorActionPreference='Stop'\n` +
      `$target='${file.replace(/'/g, "''")}'\n` +
      `$owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User\n` +
      `$acl=New-Object System.Security.AccessControl.${directory ? 'DirectorySecurity' : 'FileSecurity'}\n` +
      `$acl.SetAccessRuleProtection($true,$false)\n` +
      `foreach($sid in @($owner.Value,'S-1-5-18','S-1-5-32-544')) {\n` +
      `  $principal=New-Object System.Security.Principal.SecurityIdentifier($sid)\n` +
      `  $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($principal,'FullControl',${directory ? "'ContainerInherit,ObjectInherit','None'," : ''}'Allow')\n` +
      `  $acl.AddAccessRule($rule)\n}\n` +
      // Avoid PowerShell module autoload: a parent pwsh process may supply a
      // PSModulePath incompatible with Windows PowerShell's Security module.
      `[System.IO.${directory ? 'Directory' : 'File'}]::SetAccessControl($target,$acl)\n`;
    await run(path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, maxBuffer: 16384 });
    const after = await lstat(file, { bigint: true });
    if (!(directory ? after.isDirectory() : after.isFile() && after.nlink === 1n) || after.isSymbolicLink() || info.ino !== after.ino || info.birthtimeNs !== after.birthtimeNs) throw new Error();
  } catch {
    throw new AppError('CONFIG_PERMISSIONS_ERROR', 'Private configuration permissions could not be applied. Check ownership of the configuration directory. No credential values are printed.');
  }
}
