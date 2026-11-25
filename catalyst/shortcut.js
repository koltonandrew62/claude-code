#!/usr/bin/env node
'use strict';
// Puts a "Catalyst" shortcut on your desktop. Run once: `node shortcut.js`
// Double-clicking the shortcut starts the app and opens it in your browser.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const here = __dirname, node = process.execPath; // absolute paths, so the shortcut works no matter how it is launched
const desktop = path.join(os.homedir(), 'Desktop');
let made;

if (process.platform === 'win32') {
  const q = s => `'${s.replace(/'/g, "''")}'`; // PowerShell single-quoted string
  const ps = `$d=[Environment]::GetFolderPath('Desktop');$s=(New-Object -ComObject WScript.Shell).CreateShortcut("$d\\Catalyst.lnk");`
    + `$s.TargetPath=${q(node)};$s.Arguments='server.js --open';$s.WorkingDirectory=${q(here)};$s.Description='Catalyst event radar';$s.Save();Write-Output "$d\\Catalyst.lnk"`;
  made = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
} else {
  if (!fs.existsSync(desktop)) { console.error(`No Desktop folder found at ${desktop}`); process.exit(1); }
  const mac = process.platform === 'darwin';
  made = path.join(desktop, mac ? 'Catalyst.command' : 'Catalyst.desktop');
  fs.writeFileSync(made, mac
    ? `#!/bin/bash\ncd "${here}" && exec "${node}" server.js --open\n`
    : `[Desktop Entry]\nType=Application\nName=Catalyst\nComment=Catalyst event radar\nPath=${here}\nExec="${node}" "${path.join(here, 'server.js')}" --open\nTerminal=true\n`);
  fs.chmodSync(made, 0o755);
}
console.log(`Shortcut created: ${made}\nDouble-click it to start Catalyst. Keep the window that opens running; closing it stops the app.`);
