import { exec, execFile, spawn } from 'child_process';

const DANGEROUS_PATTERNS = [
  { re: /\brm\b(?=[^|;&\n]*\s-[a-z]*r)(?=[^|;&\n]*\s-[a-z]*f)/i, msg: 'recursive force delete (rm -r -f)' },
  { re: /\brm\s+-[rf]{2,}/i, msg: 'recursive/forced delete (rm -rf)' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, msg: 'fork bomb' },
  { re: /\bmkfs(\.[a-z0-9]+)?\b/i, msg: 'filesystem format (mkfs)' },
  { re: /\bdd\b[^|]*\bof=\/dev\//i, msg: 'raw disk write (dd of=/dev/...)' },
  { re: />\s*\/dev\/(sd|nvme|hd|disk|mmcblk)/i, msg: 'overwrite of a block device' },
  { re: /\bchmod\s+-R\s+0?[0-7]{3}\s+\/(?!\w)/i, msg: 'recursive chmod on the root path' },
  { re: /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/i, msg: 'system power-state change' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/i, msg: 'piping a remote script into a shell' },
  { re: /\bgit\b[^|;&]*\b(reset\s+--hard|clean\s+-[a-z]*f|push\b[^|;&]*(--force|-f)\b)/i, msg: 'destructive git operation' },
  { re: />\s*\/(etc|boot|sys|proc)\//i, msg: 'overwrite of a system file' },
];

export function isDangerousCommand(cmd) {
  const c = (cmd || '').trim();
  if (!c) return null;
  for (const { re, msg } of DANGEROUS_PATTERNS) {
    if (re.test(c)) return msg;
  }
  return null;
}

function sanitizedEnv() {
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  return env;
}

export function runCommand(cmd, opts = {}) {
  const {
    timeout = 30000,
    cwd = process.cwd(),
    maxBuffer = 10 * 1024 * 1024,
  } = opts;

  const trimmed = (cmd || '').trim();
  if (!trimmed) {
    return Promise.reject(new Error('Empty command refused.'));
  }

  return new Promise((resolve, reject) => {
    const child = exec(trimmed, {
      timeout,
      cwd,
      maxBuffer,
      env: sanitizedEnv(),
    }, (error, stdout, stderr) => {
      if (error && typeof error.code === 'string') {
        reject(error);
        return;
      }

      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: error?.code || 0,
        signal: error?.signal || null,
        killedByTimeout: error?.killed || false,
      });
    });
  });
}

export function runCommandArgs(file, args = [], opts = {}) {
  const {
    timeout = 30000,
    cwd = process.cwd(),
    maxBuffer = 10 * 1024 * 1024,
  } = opts;

  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, cwd, maxBuffer, env: sanitizedEnv() }, (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT') {
        reject(error);
        return;
      }
      resolve({
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        exitCode: typeof error?.code === 'number' ? error.code : 0,
        signal: error?.signal || null,
        killedByTimeout: error?.killed || false,
      });
    });
  });
}

export const BACKGROUND_TASKS = new Map();
let nextTaskId = 1;

function registerTask(child, label) {
  const id = `task-${nextTaskId++}`;
  const task = {
    id,
    cmd: label,
    pid: child.pid,
    startTime: new Date(),
    status: 'running',
    exitCode: null,
    stdout: '',
    stderr: '',
    child,
  };

  child.stdout.on('data', (chunk) => {
    task.stdout += chunk.toString();
    if (task.stdout.length > 50000) task.stdout = task.stdout.slice(-50000);
  });
  child.stderr.on('data', (chunk) => {
    task.stderr += chunk.toString();
    if (task.stderr.length > 50000) task.stderr = task.stderr.slice(-50000);
  });

  child.on('close', (code) => {
    task.status = 'finished';
    task.exitCode = code;
  });

  child.on('error', (err) => {
    task.status = 'error';
    task.stderr += `\n[Error spawning task]: ${err.message}`;
  });

  BACKGROUND_TASKS.set(id, task);
  return id;
}

export function spawnBackgroundTask(cmd, opts = {}) {
  const child = spawn(cmd, {
    shell: true,
    cwd: opts.cwd || process.cwd(),
    env: sanitizedEnv(),
  });
  return registerTask(child, cmd);
}

export function spawnBackgroundTaskArgs(file, args = [], opts = {}) {
  const child = spawn(file, args, {
    shell: false,
    cwd: opts.cwd || process.cwd(),
    env: sanitizedEnv(),
  });
  return registerTask(child, [file, ...args].join(' '));
}
