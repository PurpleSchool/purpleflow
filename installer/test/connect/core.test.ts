import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { upsertShellEnvVars, removeShellEnvVars, readShellEnvVar, parseWindowsUserEnvVar } from '../../src/main/connect/core/shellRc.js';
import {
  claudeJsonPath,
  claudeSettingsPath,
  detectClaudeConflicts,
  claudeEnvConflicts,
} from '../../src/main/connect/core/claudeSettingsDoctor.js';
import { setDryRun } from '../../src/main/connect/core/runtime.js';

/** Заглушки программ — сценарии /bin/sh: на Windows их не запустить. */
const unix = { skip: process.platform === 'win32' };

function isolated(action: (dir: string) => void) {
  const previous = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-core-test-'));
  try {
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    process.env.SHELL = '/bin/bash';
    process.env.XDG_CONFIG_HOME = path.join(dir, '.config');
    delete process.env.CLAUDE_CONFIG_DIR;
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'])
      delete process.env[key];
    setDryRun(false);
    action(dir);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    setDryRun(false);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('shell exports preserve literal credentials through repeat setup and removal of another key', unix, () =>
  isolated((dir) => {
    const credential = "test-$HOME-$(printf changed)-`printf changed`-\\-\"-'-$&-$`-$'";
    // macOS Terminal запускает login-шелл, поэтому bash там читает .bash_profile.
    const file = path.join(dir, process.platform === 'darwin' ? '.bash_profile' : '.bashrc');
    fs.writeFileSync(file, '# unrelated user setting\nexport USER_SETTING=keep\n');
    upsertShellEnvVars({ OPENAI_API_KEY: credential, ANTHROPIC_API_KEY: 'other-key' });
    upsertShellEnvVars({ ANTHROPIC_API_KEY: 'updated-other-key' });
    removeShellEnvVars(['ANTHROPIC_API_KEY']);
    const result = spawnSync('/bin/bash', ['-c', '. "$1"; printf "%s" "$OPENAI_API_KEY"', 'test', file], {
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, credential);
    assert.match(fs.readFileSync(file, 'utf8'), /export USER_SETTING=keep/);
  }),
);

test('Claude uses the explicitly selected configuration directory', () =>
  isolated((dir) => {
    process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude-work');
    assert.equal(claudeSettingsPath(), path.join(dir, 'claude-work/settings.json'));
    assert.equal(claudeJsonPath(), path.join(dir, 'claude-work/.claude.json'));
  }));

test('custom fish and zsh config locations receive the key and support removal', () =>
  isolated((dir) => {
    for (const shell of ['fish', 'zsh']) {
      process.env.SHELL = `/bin/${shell}`;
      process.env.XDG_CONFIG_HOME = path.join(dir, 'xdg-custom');
      process.env.ZDOTDIR = path.join(dir, 'zsh-custom');
      const expected = shell === 'fish' ? path.join(dir, 'xdg-custom/fish/config.fish') : path.join(dir, 'zsh-custom/.zshrc');
      assert.equal(upsertShellEnvVars({ OPENAI_API_KEY: 'test-only-key' }).file, expected);
      assert.match(fs.readFileSync(expected, 'utf8'), /test-only-key/);
      assert.equal(removeShellEnvVars(['OPENAI_API_KEY']).file, expected);
      assert.doesNotMatch(fs.readFileSync(expected, 'utf8'), /test-only-key/);
    }
  }));

test('disabled Claude provider switches do not block setup', () =>
  isolated((dir) => {
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(
      claudeSettingsPath(),
      JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: 'false', CLAUDE_CODE_USE_FOUNDRY: '' } }),
    );
    process.env.CLAUDE_CODE_USE_BEDROCK = '0';
    assert.deepEqual(detectClaudeConflicts(), []);
  }));

for (const key of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
  test(`Claude detects provider routing conflict in settings: ${key}`, () =>
    isolated((dir) => {
      fs.mkdirSync(path.join(dir, '.claude'));
      fs.writeFileSync(claudeSettingsPath(), JSON.stringify({ env: { [key]: '1' } }));
      assert.ok(detectClaudeConflicts().some((conflict) => conflict.fix.kind === 'json' && conflict.fix.path.includes(key)));
    }));
}

test('Claude detects inherited authentication conflicts without printing the token', () =>
  isolated(() => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'test-token-never-print';
    const conflicts = detectClaudeConflicts();
    assert.ok(conflicts.some((conflict) => conflict.fix.kind === 'manual' && conflict.description.includes('ANTHROPIC_AUTH_TOKEN')));
    assert.ok(!JSON.stringify(conflicts).includes(process.env.ANTHROPIC_AUTH_TOKEN));
  }));

test('managed shell values can distinguish CLI connection from a shared key', () =>
  isolated(() => {
    assert.equal(readShellEnvVar('ANTHROPIC_API_KEY'), undefined);
    upsertShellEnvVars({ ANTHROPIC_API_KEY: 'literal-$key', ANTHROPIC_BASE_URL: 'https://proxy.invalid' });
    assert.equal(readShellEnvVar('ANTHROPIC_API_KEY'), 'literal-$key');
    assert.equal(readShellEnvVar('ANTHROPIC_BASE_URL'), 'https://proxy.invalid');
  }));

for (const value of ['', '0', 'false', 'FALSE', 'no', 'off']) {
  test(`disabled Claude switches are accepted in rc files and registry: ${JSON.stringify(value)}`, () =>
    isolated((dir) => {
      fs.writeFileSync(
        path.join(dir, '.bashrc'),
        `export CLAUDE_CODE_USE_BEDROCK="${value}" # keep disabled\nexport CLAUDE_CODE_USE_VERTEX='${value}'\nexport CLAUDE_CODE_USE_FOUNDRY=${value}\n`,
      );
      const fish = path.join(dir, '.config/fish/config.fish');
      fs.mkdirSync(path.dirname(fish), { recursive: true });
      fs.writeFileSync(fish, `set -gx CLAUDE_CODE_USE_BEDROCK "${value}"\n`);
      assert.deepEqual(detectClaudeConflicts(), []);
      const registry = `HKEY_CURRENT_USER\\Environment\r\n    CLAUDE_CODE_USE_VERTEX    REG_SZ    ${value}\r\n`;
      const parsed = parseWindowsUserEnvVar(registry, 'CLAUDE_CODE_USE_VERTEX');
      assert.equal(parsed, value);
      assert.equal(claudeEnvConflicts('CLAUDE_CODE_USE_VERTEX', parsed), false);
    }));
}

for (const value of [
  '1',
  'true',
  'yes',
  'on',
  '$PROVIDER_ENABLED',
  '$(touch should-never-execute)',
  '"0"; export CLAUDE_CODE_USE_VERTEX=1',
]) {
  test(`active or ambiguous shell switch stays a conflict: ${value}`, unix, () =>
    isolated((dir) => {
      fs.writeFileSync(path.join(dir, '.bashrc'), `export CLAUDE_CODE_USE_VERTEX=${value}\n`);
      assert.ok(detectClaudeConflicts().some((conflict) => conflict.description.includes('CLAUDE_CODE_USE_VERTEX')));
      assert.equal(fs.existsSync(path.join(dir, 'should-never-execute')), false);
    }),
  );
}

test('registry parser distinguishes absent and empty values and retains token semantics', () => {
  assert.equal(parseWindowsUserEnvVar('HKEY_CURRENT_USER\\Environment\r\n', 'ANTHROPIC_AUTH_TOKEN'), undefined);
  assert.equal(parseWindowsUserEnvVar('    ANTHROPIC_AUTH_TOKEN    REG_SZ\r\n', 'ANTHROPIC_AUTH_TOKEN'), '');
  assert.equal(parseWindowsUserEnvVar('    anthropic_auth_token    REG_EXPAND_SZ    0\r\n', 'ANTHROPIC_AUTH_TOKEN'), '0');
  assert.equal(claudeEnvConflicts('ANTHROPIC_AUTH_TOKEN', '0'), true);
  assert.equal(claudeEnvConflicts('CLAUDE_CODE_USE_VERTEX', '1'), true);
});
