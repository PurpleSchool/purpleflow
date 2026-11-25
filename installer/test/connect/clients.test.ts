import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as TOML from 'smol-toml';
import { versionAtLeast } from '../../src/main/connect/core/applications.js';
import { extensionInstalled } from '../../src/main/connect/core/editors.js';
import { parseModelsResponse, proxyClaudeModels, suggestedModel } from '../../src/main/connect/core/models.js';
import { ANTHROPIC_BASE_URL } from '../../src/main/connect/constants.js';

/** Заглушки программ — сценарии /bin/sh: на Windows их не запустить. */
const unix = { skip: process.platform === 'win32' };

const root = process.cwd();
/** Куда мастер пишет переменные для bash: macOS Terminal запускает login-шелл и читает .bash_profile. */
/** Настройки VS Code в домашнем каталоге песочницы. */
function codeSettings() {
  return process.platform === 'darwin' ? 'Library/Application Support/Code/User/settings.json' : '.config/Code/User/settings.json';
}
function rcFile() {
  return process.platform === 'darwin' ? '.bash_profile' : '.bashrc';
}
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-for-code-test-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  if (process.platform !== 'win32') fs.symlinkSync('/bin/sh', path.join(bin, 'sh'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    XDG_CONFIG_HOME: path.join(dir, '.config'),
    CODEX_HOME: path.join(dir, '.codex'),
    APPDATA: path.join(dir, 'AppData'),
    PATH: bin,
    SHELL: '/bin/bash',
    SUDO_USER: '',
    TSX_TSCONFIG_PATH: path.join(process.cwd(), 'tsconfig.node.json'),
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.CLAUDE_CODE_USE_FOUNDRY;
  delete env.VSCODE_PORTABLE;
  return { dir, bin, env };
}
function write(dir: string, file: string, value: unknown) {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value));
}
function read(dir: string, file: string) {
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
}
function invoke(s: ReturnType<typeof sandbox>, family: string, id: string, action = 'apply') {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'test/connect/fixtures/client.mts', family, id, action], {
    cwd: root,
    env: s.env,
    encoding: 'utf8',
    timeout: 20000,
  });
  if (result.error) throw result.error;
  return result;
}
function stub(s: ReturnType<typeof sandbox>, name: string, body: string) {
  fs.writeFileSync(path.join(s.bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  if (['code', 'cursor', 'windsurf'].includes(name)) {
    write(s.dir, 'resources/app/product.json', { applicationName: name, nameShort: name });
  }
}

const cases = [
  ['anthropic', 'claude-code-cli'],
  ['anthropic', 'vscode'],
  ['anthropic', 'cursor'],
  ['anthropic', 'windsurf'],
  ['anthropic', 'opencode'],
  ['anthropic', 'pi-cli'],
  ['anthropic', 'anthropic-qwen-code'],
  ['anthropic', 'neovim-avante'],
  ['openai', 'openai-codex-cli'],
  ['openai', 'codex-vscode'],
  ['openai', 'codex-cursor'],
  ['openai', 'codex-windsurf'],
  ['openai', 'openai-opencode'],
  ['openai', 'openai-pi-cli'],
  ['openai', 'openai-qwen-code'],
  ['openai', 'openai-neovim-avante'],
];
for (const [family, id] of cases) {
  test(
    `${family}/${id}: selects model, preserves unrelated settings, repeatable and removable`,
    { skip: process.platform === 'win32' && id!.includes('neovim') },
    () => {
      const s = sandbox();
      try {
        write(s.dir, '.codex/config.toml', 'unrelated = "keep"\n[model_providers.other]\nname = "Other"\n');
        write(s.dir, '.claude/settings.json', { unrelated: 'keep' });
        write(s.dir, '.claude.json', { unrelated: 'keep' });
        for (const editor of ['Code', 'Cursor', 'windsurf']) write(s.dir, `.config/${editor}/User/settings.json`, { unrelated: 'keep' });
        write(s.dir, '.config/opencode/opencode.json', { unrelated: 'keep', provider: { other: { name: 'Other' } } });
        write(s.dir, '.pi/agent/models.json', { unrelated: 'keep', providers: { other: { apiKey: '$OTHER' } } });
        write(s.dir, '.pi/agent/settings.json', { unrelated: 'keep' });
        write(s.dir, '.qwen/settings.json', {
          unrelated: 'keep',
          modelProviders: {
            openai: [{ id: 'other-gpt', baseUrl: 'https://other.invalid/v1' }],
            anthropic: [{ id: 'other-claude', baseUrl: 'https://other.invalid' }],
          },
        });
        for (let i = 0; i < 2; i++) {
          const result = invoke(s, family!, id!);
          assert.equal(result.status, 0, result.stderr);
        }
        const model = family === 'anthropic' ? 'claude-test-selected' : 'gpt-test-selected';
        if (id!.includes('codex')) {
          const config = TOML.parse(fs.readFileSync(path.join(s.dir, '.codex/config.toml'), 'utf8'));
          assert.equal(config.model, model);
          assert.equal(config.unrelated, 'keep');
          assert.equal((config.model_providers as Record<string, Record<string, unknown>>).purpleschool.supports_websockets, false);
        } else if (['claude-code-cli', 'vscode', 'cursor', 'windsurf'].includes(id!)) {
          assert.equal(read(s.dir, '.claude/settings.json').model, model);
          assert.equal(read(s.dir, '.claude/settings.json').unrelated, 'keep');
          assert.equal(read(s.dir, '.claude.json').model, model);
        } else if (id!.includes('opencode')) {
          const config = read(s.dir, '.config/opencode/opencode.json');
          assert.equal(config.model, `purpleschool-${family}/${model}`);
          assert.equal(config.provider.other.name, 'Other');
        } else if (id!.includes('pi-cli')) {
          assert.equal(read(s.dir, '.pi/agent/settings.json').defaultModel, model);
          assert.equal(read(s.dir, '.pi/agent/models.json').providers.other.apiKey, '$OTHER');
        } else if (id!.includes('qwen')) {
          const config = read(s.dir, '.qwen/settings.json');
          assert.equal(config.model.name, model);
          assert.equal(config.modelProviders[family!].length, 2);
          assert.equal(config.modelProviders[family!][1].baseUrl.startsWith('https://other.invalid'), true);
        } else {
          const lua = fs.readFileSync(path.join(s.dir, '.config/nvim/lua/plugins/purpleschool-avante.lua'), 'utf8');
          assert.ok(lua.includes(model));
          assert.ok(!lua.includes('<ВСТАВЬ_МОДЕЛЬ>'));
        }
        const removed = invoke(s, family!, id!, 'remove');
        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(read(s.dir, '.claude/settings.json').unrelated, 'keep');
        assert.equal(read(s.dir, '.qwen/settings.json').unrelated, 'keep');
        assert.equal(read(s.dir, '.pi/agent/models.json').unrelated, 'keep');
      } finally {
        fs.rmSync(s.dir, { recursive: true, force: true });
      }
    },
  );
}

test('a missing terminal agent is installed from npm; editors are never installed', unix, () => {
  const s = sandbox();
  try {
    // npm кладёт «установленный» opencode в каталог PATH песочницы ($HOME/bin).
    stub(
      s,
      'npm',
      'printf "%s\\n" "$*" >> "$HOME/npm-calls"; printf \'#!/bin/sh\\nprintf "1.19.6\\\\n"\\n\' > "$HOME/bin/opencode"; /bin/chmod +x "$HOME/bin/opencode"',
    );
    const opencode = invoke(s, 'anthropic', 'opencode', 'check');
    assert.equal(opencode.status, 0, opencode.stderr);
    assert.match(fs.readFileSync(path.join(s.dir, 'npm-calls'), 'utf8'), /install --global .*opencode-ai/);
    fs.rmSync(path.join(s.dir, 'npm-calls'));
    // Neovim — редактор: его не ставим, а просим поставить самому.
    const nvim = invoke(s, 'anthropic', 'neovim-avante', 'check');
    assert.equal(nvim.status, 1);
    assert.equal(fs.existsSync(path.join(s.dir, 'npm-calls')), false);
    assert.equal(fs.existsSync(path.join(s.dir, rcFile())), false);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('Pi and Qwen Code check the system Node.js before installing', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'npm', 'printf called > "$HOME/npm-called"');
    stub(s, 'node', 'printf "v20.11.0\\n"');
    for (const [id, need] of [
      ['pi-cli', '22.19.0'],
      ['anthropic-qwen-code', '22.0.0'],
    ] as const) {
      const r = invoke(s, id.startsWith('pi') ? 'anthropic' : 'anthropic', id, 'check');
      assert.equal(r.status, 1, id);
      assert.match(r.stderr, new RegExp(`Node.js ${need.replace(/\./g, '\\.')}.*20\\.11\\.0`));
    }
    assert.equal(fs.existsSync(path.join(s.dir, 'npm-called')), false);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('missing assistant CLI is automatically installed and then verified; dry-run never installs', unix, () => {
  const s = sandbox();
  try {
    stub(
      s,
      'npm',
      'printf "%s\\n" "$*" >> "$HOME/npm-called"\ncase "$*" in *claude-code*) app=claude;; *) app=codex;; esac\nprintf "#!/bin/sh\\nprintf \'2.1.300\\\\n\'\\n" > "$HOME/bin/$app"\n/bin/chmod +x "$HOME/bin/$app"',
    );
    assert.equal(invoke(s, 'openai', 'openai-codex-cli', 'check-dry-run').status, 0);
    assert.equal(fs.existsSync(path.join(s.dir, 'npm-called')), false);
    for (const [family, id] of [
      ['openai', 'openai-codex-cli'],
      ['anthropic', 'claude-code-cli'],
    ]) {
      const result = invoke(s, family!, id!, 'check');
      assert.equal(result.status, 0, result.stderr);
    }
    const calls = fs.readFileSync(path.join(s.dir, 'npm-called'), 'utf8');
    assert.ok(calls.includes('@openai/codex'));
    assert.ok(calls.includes('@anthropic-ai/claude-code'));
    assert.equal(calls.trim().split('\n').length, 2);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('matching extension is required; Codex editor also requires standalone CLI', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'code', 'case "$1" in --version) printf "1.100.0\\n";; *) printf "anthropic.claude-code@2.1.300\\n";; esac');
    assert.equal(invoke(s, 'anthropic', 'vscode', 'check').status, 0);
    assert.equal(invoke(s, 'openai', 'codex-vscode', 'check').status, 1);
    stub(s, 'code', 'case "$1" in --version) printf "1.100.0\\n";; *) printf "openai.chatgpt@1.0.0\\n";; esac');
    const result = invoke(s, 'openai', 'codex-vscode', 'check-dry-run');
    assert.equal(result.status, 0, result.stderr);
    // Dry-run ничего не ставит: codex в песочнице нет, а проверка всё равно проходит.
    assert.equal(result.stdout.trim(), 'OK');
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('invalid JSON is rejected before overwriting the file', () => {
  const s = sandbox();
  try {
    write(s.dir, '.qwen/settings.json', '{"broken":');
    const result = invoke(s, 'openai', 'openai-qwen-code');
    assert.equal(result.status, 1);
    assert.equal(fs.readFileSync(path.join(s.dir, '.qwen/settings.json'), 'utf8'), '{"broken":');
    assert.equal(fs.existsSync(path.join(s.dir, rcFile())), false);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('extension ids and minimum versions are matched exactly', () => {
  assert.equal(extensionInstalled('not-openai.chatgpt@1\nopenai.chatgpt-other@1', 'openai.chatgpt'), false);
  assert.equal(extensionInstalled('OpenAI.ChatGPT@1.0.0\r\n', 'openai.chatgpt'), true);
  assert.equal(versionAtLeast('NVIM v0.11.4', '0.11.0'), true);
  assert.equal(versionAtLeast('0.24.5', '0.24.6'), false);
  assert.equal(versionAtLeast('0.24.6', '0.24.6'), true);
  assert.equal(versionAtLeast('something', '0.24.6'), false);
  assert.deepEqual(parseModelsResponse({ data: [{ id: 'gpt-test' }, { id: 'claude-test', display_name: 'Claude' }] }), {
    'gpt-test': 'gpt-test',
    'claude-test': 'Claude',
  });
});

// Без --uninstall мастер первым вопросом спрашивает «Что делаем?» — по умолчанию отвечаем «Установить».
test('removing Claude CLI preserves the common configuration used by an editor', unix, () => {
  const s = sandbox();
  try {
    s.env.TEST_BASE_URL = ANTHROPIC_BASE_URL;
    assert.equal(invoke(s, 'anthropic', 'claude-code-cli').status, 0);
    assert.equal(invoke(s, 'anthropic', 'vscode').status, 0);
    assert.equal(invoke(s, 'anthropic', 'claude-code-cli', 'remove').status, 0);
    assert.equal(read(s.dir, '.claude/settings.json').env.ANTHROPIC_API_KEY, 'test-only-key-not-a-real-secret');
    assert.equal(read(s.dir, '.claude/settings.json').model, 'claude-test-selected');
    assert.match(JSON.stringify(read(s.dir, codeSettings())), /ANTHROPIC_API_KEY/);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('Codex active profile is updated without losing unrelated profile settings', () => {
  const s = sandbox();
  try {
    write(
      s.dir,
      '.codex/config.toml',
      'profile = "work"\n[profiles.work]\nmodel = "old-model"\nmodel_provider = "other"\nsandbox_mode = "read-only"\n',
    );
    const result = invoke(s, 'openai', 'openai-codex-cli');
    assert.equal(result.status, 0, result.stderr);
    const config = TOML.parse(fs.readFileSync(path.join(s.dir, '.codex/config.toml'), 'utf8'));
    const profile = (config.profiles as Record<string, Record<string, unknown>>).work;
    assert.equal(profile.model, 'gpt-test-selected');
    assert.equal(profile.model_provider, 'purpleschool');
    assert.equal(profile.sandbox_mode, 'read-only');
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('every target dry-run leaves existing configuration unchanged', () => {
  for (const [family, id] of cases) {
    const s = sandbox();
    try {
      write(s.dir, '.codex/config.toml', 'unrelated = "keep"\n');
      write(s.dir, '.qwen/settings.json', { unrelated: 'keep' });
      const before = fs.readFileSync(path.join(s.dir, '.codex/config.toml'), 'utf8');
      const result = invoke(s, family!, id!, 'dry-run');
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fs.readFileSync(path.join(s.dir, '.codex/config.toml'), 'utf8'), before);
      assert.deepEqual(read(s.dir, '.qwen/settings.json'), { unrelated: 'keep' });
      assert.equal(fs.existsSync(path.join(s.dir, rcFile())), false);
      assert.equal(fs.existsSync(path.join(s.dir, '.purpleschool-ai-backups')), false);
      assert.equal(fs.existsSync(path.join(s.dir, '.config/nvim/lua/plugins/purpleschool-avante.lua')), false);
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }
});

test('empty valid Claude discovery still offers built-in models', () => {
  assert.deepEqual(parseModelsResponse({ data: [] }), {});
  assert.ok(Object.keys(proxyClaudeModels({}) ?? {}).some((id) => id.startsWith('claude-sonnet')));
});

test('Qwen changes the selected endpoint and preserves other endpoints with the same model id', () => {
  const s = sandbox();
  try {
    write(s.dir, '.qwen/settings.json', {
      model: { name: 'gpt-test-selected', baseUrl: 'https://previous.invalid/v1', unrelated: 'keep' },
      modelProviders: { openai: [{ id: 'gpt-test-selected', baseUrl: 'https://previous.invalid/v1', envKey: 'PREVIOUS_KEY' }] },
    });
    assert.equal(invoke(s, 'openai', 'openai-qwen-code').status, 0);
    let config = read(s.dir, '.qwen/settings.json');
    assert.equal(config.model.baseUrl, 'https://example.invalid/openai/v1');
    assert.equal(config.model.unrelated, 'keep');
    assert.equal(config.modelProviders.openai[1].baseUrl, 'https://previous.invalid/v1');
    // A later user choice of the previous endpoint must survive removing our endpoint.
    config.model.baseUrl = 'https://previous.invalid/v1';
    write(s.dir, '.qwen/settings.json', config);
    assert.equal(invoke(s, 'openai', 'openai-qwen-code', 'remove').status, 0);
    config = read(s.dir, '.qwen/settings.json');
    assert.equal(config.model.name, 'gpt-test-selected');
    assert.equal(config.model.baseUrl, 'https://previous.invalid/v1');
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('Qwen removes an old selection without baseUrl only when its endpoint is unambiguous', () => {
  for (const duplicate of [false, true]) {
    const s = sandbox();
    try {
      write(s.dir, '.qwen/settings.json', {
        model: { name: 'gpt-test-selected', unrelated: 'keep' },
        security: { auth: { selectedType: 'openai' } },
        modelProviders: {
          openai: [
            { id: 'gpt-test-selected', baseUrl: 'https://example.invalid/openai/v1' },
            ...(duplicate ? [{ id: 'gpt-test-selected', baseUrl: 'https://other.invalid/v1' }] : []),
          ],
        },
      });
      assert.equal(invoke(s, 'openai', 'openai-qwen-code', 'remove').status, 0);
      const config = read(s.dir, '.qwen/settings.json');
      assert.equal(config.model.unrelated, 'keep');
      assert.equal(config.model.name, duplicate ? 'gpt-test-selected' : undefined);
      assert.equal(config.security.auth.selectedType, duplicate ? 'openai' : undefined);
      assert.equal(config.modelProviders.openai.length, duplicate ? 1 : 0);
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }
});

test('OpenCode keeps legacy OpenAI connection and both new families independently', () => {
  const s = sandbox();
  try {
    const legacy = {
      npm: '@ai-sdk/openai',
      name: 'Existing OpenAI',
      options: { baseURL: 'https://previous.invalid/v1', apiKey: '{env:PREVIOUS_KEY}' },
      models: { existing: { name: 'Existing' } },
    };
    write(s.dir, '.config/opencode/opencode.json', { provider: { purpleschool: legacy } });
    for (const [family, id] of [
      ['anthropic', 'opencode'],
      ['openai', 'openai-opencode'],
    ])
      assert.equal(invoke(s, family!, id!).status, 0);
    let providers = read(s.dir, '.config/opencode/opencode.json').provider;
    assert.deepEqual(providers.purpleschool, legacy);
    assert.equal(providers['purpleschool-anthropic'].npm, '@ai-sdk/anthropic');
    assert.equal(providers['purpleschool-openai'].npm, '@ai-sdk/openai');
    assert.equal(invoke(s, 'anthropic', 'opencode', 'remove').status, 0);
    providers = read(s.dir, '.config/opencode/opencode.json').provider;
    assert.deepEqual(providers.purpleschool, legacy);
    assert.ok(providers['purpleschool-openai']);
    assert.equal(providers['purpleschool-anthropic'], undefined);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

for (const action of ['apply', 'remove', 'dry-run']) {
  test(`Pi recognizes previous wizard configuration: ${action}`, () => {
    const s = sandbox();
    try {
      const legacy = {
        baseUrl: 'https://app.purpleschool.ru/api-v2/public/ai-proxy/anthropic/v1',
        apiKey: '$ANTHROPIC_API_KEY',
        models: [{ id: 'user-custom-model' }],
        custom: 'keep',
      };
      write(s.dir, '.pi/agent/models.json', { providers: { anthropic: legacy, unrelated: { apiKey: '$OTHER_KEY' } } });
      assert.match(invoke(s, 'anthropic', 'pi-cli', 'is-configured').stdout, /true/);
      assert.equal(invoke(s, 'anthropic', 'pi-cli', action).status, 0);
      const providers = read(s.dir, '.pi/agent/models.json').providers;
      if (action === 'dry-run') assert.deepEqual(providers.anthropic, legacy);
      else {
        assert.equal(providers.anthropic.baseUrl, undefined);
        assert.equal(providers.anthropic.apiKey, undefined);
        assert.deepEqual(providers.anthropic.models, legacy.models);
        assert.equal(providers.anthropic.custom, 'keep');
      }
      assert.equal(providers.unrelated.apiKey, '$OTHER_KEY');
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  });
}

test('Pi does not remove another Anthropic gateway or an unrelated credential', () => {
  for (const legacy of [
    { baseUrl: 'https://other.invalid/v1', apiKey: '$ANTHROPIC_API_KEY' },
    { baseUrl: 'https://app.purpleschool.ru/api-v2/public/ai-proxy/anthropic/v1', apiKey: '$USER_KEY' },
  ]) {
    const s = sandbox();
    try {
      write(s.dir, '.pi/agent/models.json', { providers: { anthropic: legacy } });
      assert.equal(invoke(s, 'anthropic', 'pi-cli', 'remove').status, 0);
      assert.deepEqual(read(s.dir, '.pi/agent/models.json').providers.anthropic, legacy);
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  }
});

test('Windsurf identity comes from product metadata, even with devin in the parent path', unix, () => {
  const s = sandbox();
  try {
    const real = path.join(s.dir, 'devin', 'bin', 'windsurf');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '#!/bin/sh\ncase "$1" in --version) printf "1.100.0\\n";; *) printf "anthropic.claude-code@2.1.300\\n";; esac', {
      mode: 0o755,
    });
    fs.symlinkSync(real, path.join(s.bin, 'windsurf'));
    write(s.dir, 'devin/resources/app/product.json', { applicationName: 'windsurf', nameShort: 'Windsurf' });
    const result = invoke(s, 'anthropic', 'windsurf', 'check');
    assert.equal(result.status, 0, result.stderr);
    write(s.dir, 'devin/resources/app/product.json', { applicationName: 'devin-desktop', nameShort: 'Devin' });
    const rejected = invoke(s, 'anthropic', 'windsurf', 'check');
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /найден Devin/);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('proxy models come before Claude Code built-ins; the model named in a 400 is suggested', () => {
  assert.deepEqual(Object.keys(proxyClaudeModels({ 'claude-haiku-5-5': 'Claude Haiku 5.5', 'gpt-x': 'GPT' }) ?? {}), [
    'claude-haiku-5-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-haiku-4-5-20251001',
  ]);
  const detail = 'Модель «claude-opus-4-8» недоступна на пробном балансе. Доступная модель: Claude Haiku 5.5 (claude-haiku-5-5).';
  assert.equal(suggestedModel(detail, ['claude-haiku-5-5', 'claude-sonnet-5'], ['claude-opus-4-8']), 'claude-haiku-5-5');
  assert.equal(suggestedModel(detail, ['claude-sonnet-5'], ['claude-opus-4-8']), 'claude-haiku-5-5');
  assert.equal(suggestedModel('Model not supported', ['claude-sonnet-5']), undefined);
});

test('Codex key lives in config.toml, not in the shell environment', () => {
  const s = sandbox();
  try {
    assert.equal(invoke(s, 'openai', 'openai-codex-cli').status, 0);
    const provider = (
      TOML.parse(fs.readFileSync(path.join(s.dir, '.codex/config.toml'), 'utf8')).model_providers as Record<string, Record<string, unknown>>
    ).purpleschool;
    assert.equal(typeof provider.experimental_bearer_token, 'string');
    assert.ok((provider.experimental_bearer_token as string).length > 0);
    assert.equal(provider.env_key, undefined);
    const rc = path.join(s.dir, process.platform === 'darwin' ? '.bash_profile' : '.bashrc');
    if (fs.existsSync(rc)) assert.doesNotMatch(fs.readFileSync(rc, 'utf8'), /OPENAI_API_KEY/);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('an upgrade replaces the legacy env_key provider and removal keeps a key OpenCode still uses', () => {
  const s = sandbox();
  try {
    write(
      s.dir,
      '.codex/config.toml',
      'model_provider = "purpleschool"\n[model_providers.purpleschool]\nname = "PurpleSchool OpenAI Proxy"\nenv_key = "OPENAI_API_KEY"\n',
    );
    stub(s, 'opencode', 'printf "1.0.0\\n"');
    assert.equal(invoke(s, 'openai', 'openai-opencode').status, 0);
    assert.equal(invoke(s, 'openai', 'openai-codex-cli').status, 0);
    const provider = (
      TOML.parse(fs.readFileSync(path.join(s.dir, '.codex/config.toml'), 'utf8')).model_providers as Record<string, Record<string, unknown>>
    ).purpleschool;
    assert.equal(provider.env_key, undefined);
    assert.equal(invoke(s, 'openai', 'openai-codex-cli', 'remove').status, 0);
    assert.match(fs.readFileSync(path.join(s.dir, process.platform === 'darwin' ? '.bash_profile' : '.bashrc'), 'utf8'), /OPENAI_API_KEY/);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

// Настройка из установщика: без вопросов, по спискам «включить» и «выключить» (src/main/connect/run.ts).
interface Result {
  id: string;
  ok: boolean;
  model?: string;
  notes?: string[];
  error?: string;
  needLogin?: boolean;
}
function connect(
  s: ReturnType<typeof sandbox>,
  o: { enable?: string[]; disable?: string[]; key?: string | null; env?: Record<string, string> },
) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--import', './test/connect/fixtures/preload.mjs', 'test/connect/fixtures/run.mts'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...s.env,
        TEST_MODEL: 'gpt-test-selected',
        TEST_API_LOG: path.join(s.dir, 'api-log'),
        TEST_ENABLE: (o.enable ?? []).join(','),
        TEST_DISABLE: (o.disable ?? []).join(','),
        ...(o.key === null ? {} : { TEST_KEY: o.key ?? 'test-only-api-key' }),
        ...o.env,
      },
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.trim().split('\n').pop()!;
  return { results: JSON.parse(out) as Result[], stdout: result.stdout, stderr: result.stderr };
}
const byId = (r: Result[], id: string) => r.find((x) => x.id === id)!;
const requests = (s: ReturnType<typeof sandbox>) =>
  fs.existsSync(path.join(s.dir, 'api-log'))
    ? fs
        .readFileSync(path.join(s.dir, 'api-log'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];

test('connect: Claude Code gets the default model, checked by a real request before writing', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'claude', 'printf "2.1.300\\n"');
    const { results } = connect(s, { enable: ['claude-code-cli'], env: { TEST_MODEL: 'claude-sonnet-5' } });
    assert.equal(byId(results, 'claude-code-cli').ok, true, byId(results, 'claude-code-cli').error);
    assert.equal(read(s.dir, '.claude/settings.json').model, 'claude-sonnet-5');
    const r = requests(s);
    assert.ok(r[0].url.endsWith('/v1/models'));
    assert.equal(JSON.parse(r[1].body).model, 'claude-sonnet-5');
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('connect: trial balance — a model rejected with 400 is replaced by the one the proxy names', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'claude', 'printf "2.1.300\\n"');
    const { results } = connect(s, {
      enable: ['claude-code-cli'],
      env: { TEST_MODEL: 'claude-haiku-5-5', TEST_PROBE_REJECT: 'claude-sonnet-5', TEST_PROBE_SUGGEST: 'claude-haiku-5-5' },
    });
    assert.equal(byId(results, 'claude-code-cli').ok, true);
    assert.deepEqual(
      requests(s)
        .slice(1)
        .map((r) => JSON.parse(r.body).model),
      ['claude-sonnet-5', 'claude-haiku-5-5'],
    );
    assert.equal(read(s.dir, '.claude/settings.json').model, 'claude-haiku-5-5');
    assert.equal(read(s.dir, '.claude.json').model, 'claude-haiku-5-5');
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('connect: when the proxy rejects every model, nothing is written', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'codex', 'printf "1.0.0\\n"');
    const { results } = connect(s, {
      enable: ['openai-codex-cli'],
      env: { TEST_PROBE_REJECT: 'gpt-test-selected', TEST_PROBE_SUGGEST: 'gpt-test-selected' },
    });
    assert.equal(byId(results, 'openai-codex-cli').ok, false);
    assert.match(byId(results, 'openai-codex-cli').error!, /Настройки не записаны/);
    assert.equal(fs.existsSync(path.join(s.dir, '.codex/config.toml')), false);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('connect: Codex prefers the PurpleFlow default model when the proxy serves it', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'codex', 'printf "1.0.0\\n"');
    const { results } = connect(s, {
      enable: ['openai-codex-cli'],
      env: { TEST_MODELS: 'deepseek-v4-pro,gpt-6-luna,gpt-6.1-terra', TEST_MODEL: 'gpt-6.1-terra' },
    });
    assert.equal(byId(results, 'openai-codex-cli').ok, true);
    assert.equal(TOML.parse(fs.readFileSync(path.join(s.dir, '.codex/config.toml'), 'utf8')).model, 'gpt-6.1-terra');
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('connect: without a key nothing is requested or written, and login is asked for', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'codex', 'printf "1.0.0\\n"');
    const { results } = connect(s, { enable: ['openai-codex-cli'], key: '' });
    assert.equal(byId(results, 'openai-codex-cli').needLogin, true);
    assert.equal(requests(s).length, 0);
    assert.equal(fs.existsSync(path.join(s.dir, '.codex')), false);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('connect: a key rejected by the proxy asks for login and writes nothing', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'codex', 'printf "1.0.0\\n"');
    const { results } = connect(s, { enable: ['openai-codex-cli'], env: { TEST_MODELS_STATUS: '401' } });
    assert.equal(byId(results, 'openai-codex-cli').needLogin, true);
    assert.equal(fs.existsSync(path.join(s.dir, '.codex')), false);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('connect: an existing PurpleSchool key is reused, so another app connects without login', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'claude', 'printf "2.1.300\\n"');
    stub(s, 'codex', 'printf "1.0.0\\n"');
    connect(s, { enable: ['claude-code-cli'], env: { TEST_MODEL: 'claude-sonnet-5' } });
    // Адрес прокси в тестовом окружении — настоящий: так существующий ключ распознаётся как наш.
    s.env.TEST_BASE_URL = ANTHROPIC_BASE_URL;
    assert.equal(invoke(s, 'anthropic', 'claude-code-cli').status, 0);
    const { results } = connect(s, { enable: ['openai-codex-cli'], key: null });
    assert.equal(byId(results, 'openai-codex-cli').ok, true, byId(results, 'openai-codex-cli').error);
    const provider = (
      TOML.parse(fs.readFileSync(path.join(s.dir, '.codex/config.toml'), 'utf8')).model_providers as Record<string, Record<string, unknown>>
    ).purpleschool;
    assert.equal(provider.experimental_bearer_token, 'test-only-key-not-a-real-secret');
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('connect: Codex login restriction is lifted automatically, unrelated settings kept', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'codex', 'printf "0.156.1\\n"');
    write(s.dir, '.codex/config.toml', 'forced_login_method = "chatgpt"\nunrelated = "keep"\n');
    const { results } = connect(s, { enable: ['openai-codex-cli'] });
    assert.equal(byId(results, 'openai-codex-cli').ok, true);
    assert.ok(byId(results, 'openai-codex-cli').notes!.some((n) => /ChatGPT/.test(n)));
    const config = TOML.parse(fs.readFileSync(path.join(s.dir, '.codex/config.toml'), 'utf8'));
    assert.equal(config.forced_login_method, undefined);
    assert.equal(config.unrelated, 'keep');
    assert.equal(config.model_provider, 'purpleschool');
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test("connect: Codex also fixes an editor's executable override", unix, () => {
  const s = sandbox();
  try {
    stub(s, 'codex', 'printf "1.0.0\\n"');
    stub(s, 'code', 'case "$1" in --version) printf "1.100.0\\n";; *) printf "openai.chatgpt@1.0.0\\n";; esac');
    write(s.dir, codeSettings(), { 'chatgpt.cliExecutable': '/old/codex', other: 'keep' });
    const { results } = connect(s, { enable: ['openai-codex-cli'] });
    assert.equal(byId(results, 'openai-codex-cli').ok, true, byId(results, 'openai-codex-cli').error);
    assert.deepEqual(read(s.dir, codeSettings()), { other: 'keep' });
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('connect: Claude conflicts in settings are removed automatically, other settings kept', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'claude', 'printf "2.1.300\\n"');
    write(s.dir, '.claude/settings.json', { apiKeyHelper: 'old-helper', keep: 'yes' });
    const { results } = connect(s, { enable: ['claude-code-cli'], env: { TEST_MODEL: 'claude-sonnet-5' } });
    assert.equal(byId(results, 'claude-code-cli').ok, true, byId(results, 'claude-code-cli').error);
    const settings = read(s.dir, '.claude/settings.json');
    assert.equal(settings.apiKeyHelper, undefined);
    assert.equal(settings.keep, 'yes');
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('connect: an inherited Claude token stops setup before writing and is never shown', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'claude', 'printf "2.1.300\\n"');
    const { results, stdout } = connect(s, {
      enable: ['claude-code-cli'],
      env: { TEST_MODEL: 'claude-sonnet-5', ANTHROPIC_AUTH_TOKEN: 'test-token-never-print' },
    });
    assert.equal(byId(results, 'claude-code-cli').ok, false);
    assert.match(byId(results, 'claude-code-cli').error!, /ANTHROPIC_AUTH_TOKEN/);
    assert.doesNotMatch(stdout, /test-token-never-print/);
    assert.equal(fs.existsSync(path.join(s.dir, '.claude')), false);
    assert.equal(fs.existsSync(path.join(s.dir, rcFile())), false);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('connect: VS Code extension conflicts are removed, other extension env kept', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'code', 'case "$1" in --version) printf "1.100.0\\n";; *) printf "anthropic.claude-code@2.1.300\\n";; esac');
    write(s.dir, codeSettings(), {
      'claudeCode.environmentVariables': [
        { name: 'ANTHROPIC_AUTH_TOKEN', value: 'old-conflict' },
        { name: 'OTHER', value: 'keep' },
      ],
    });
    const { results } = connect(s, { enable: ['vscode'], env: { TEST_MODEL: 'claude-sonnet-5' } });
    assert.equal(byId(results, 'vscode').ok, true, byId(results, 'vscode').error);
    const vars = read(s.dir, codeSettings())['claudeCode.environmentVariables'];
    assert.ok(!vars.some((e: { name: string }) => e.name === 'ANTHROPIC_AUTH_TOKEN'));
    assert.ok(vars.some((e: { name: string; value: string }) => e.name === 'OTHER' && e.value === 'keep'));
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('connect: a failed CLI installation stops before any request or write', () => {
  const s = sandbox();
  try {
    stub(s, 'npm', 'exit 1');
    const { results } = connect(s, { enable: ['openai-codex-cli'] });
    assert.match(byId(results, 'openai-codex-cli').error!, /Не удалось установить/);
    assert.equal(requests(s).length, 0);
    assert.equal(fs.existsSync(path.join(s.dir, '.codex')), false);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('connect: disconnecting needs no key and keeps the Claude key other apps use', () => {
  const s = sandbox();
  try {
    assert.equal(invoke(s, 'anthropic', 'claude-code-cli').status, 0);
    assert.equal(invoke(s, 'openai', 'openai-codex-cli').status, 0);
    const { results } = connect(s, { disable: ['openai-codex-cli'], key: '' });
    assert.equal(byId(results, 'openai-codex-cli').ok, true);
    assert.equal(requests(s).length, 0);
    assert.match(fs.readFileSync(path.join(s.dir, rcFile()), 'utf8'), /ANTHROPIC_API_KEY/);
    assert.equal(TOML.parse(fs.readFileSync(path.join(s.dir, '.codex/config.toml'), 'utf8')).model_provider, undefined);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

for (const keepQwen of [false, true]) {
  test(`connect: disconnecting Claude and Pi together considers remaining clients (Qwen=${keepQwen})`, unix, () => {
    const s = sandbox();
    try {
      s.env.TEST_BASE_URL = ANTHROPIC_BASE_URL;
      for (const id of ['claude-code-cli', 'pi-cli', ...(keepQwen ? ['anthropic-qwen-code'] : [])])
        assert.equal(invoke(s, 'anthropic', id).status, 0);
      const { results } = connect(s, { disable: ['claude-code-cli', 'pi-cli'], key: '' });
      assert.ok(
        results.every((r) => r.ok),
        JSON.stringify(results),
      );
      const after = fs.readFileSync(path.join(s.dir, rcFile()), 'utf8');
      assert.doesNotMatch(after, /ANTHROPIC_BASE_URL/);
      assert.equal(after.includes('ANTHROPIC_API_KEY'), keepQwen);
      assert.equal(read(s.dir, '.pi/agent/models.json').providers['purpleschool-anthropic'], undefined);
      assert.equal(
        byId(results, 'claude-code-cli').notes!.some((n) => n.includes('Общий ANTHROPIC_API_KEY сохранён')),
        keepQwen,
      );
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  });
}

test('connect: a failed removal of a key consumer preserves its credential', () => {
  const s = sandbox();
  try {
    s.env.TEST_BASE_URL = ANTHROPIC_BASE_URL;
    assert.equal(invoke(s, 'anthropic', 'claude-code-cli').status, 0);
    write(s.dir, '.pi/agent/models.json', '{broken');
    const { results } = connect(s, { disable: ['claude-code-cli', 'pi-cli'], key: '' });
    assert.equal(byId(results, 'pi-cli').ok, false);
    assert.match(fs.readFileSync(path.join(s.dir, rcFile()), 'utf8'), /ANTHROPIC_API_KEY/);
    assert.equal(fs.readFileSync(path.join(s.dir, '.pi/agent/models.json'), 'utf8'), '{broken');
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('connect: Claude uses CLAUDE_CONFIG_DIR without touching the default profile', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'claude', 'printf "2.1.300\\n"');
    s.env.CLAUDE_CONFIG_DIR = path.join(s.dir, 'claude-work');
    write(s.dir, '.claude/settings.json', { defaultProfile: 'keep' });
    const { results } = connect(s, { enable: ['claude-code-cli'], env: { TEST_MODEL: 'claude-sonnet-5' } });
    assert.equal(byId(results, 'claude-code-cli').ok, true, byId(results, 'claude-code-cli').error);
    assert.equal(read(s.dir, 'claude-work/settings.json').model, 'claude-sonnet-5');
    assert.equal(read(s.dir, 'claude-work/.claude.json').hasCompletedOnboarding, true);
    assert.deepEqual(read(s.dir, '.claude/settings.json'), { defaultProfile: 'keep' });
    connect(s, { disable: ['claude-code-cli'], key: '' });
    assert.equal(read(s.dir, 'claude-work/settings.json').env.ANTHROPIC_API_KEY, undefined);
    assert.deepEqual(read(s.dir, '.claude/settings.json'), { defaultProfile: 'keep' });
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('connect: portable VS Code is set up and cleaned in its portable profile', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'code', 'case "$1" in --version) printf "1.100.0\\n";; *) printf "anthropic.claude-code@2.1.300\\n";; esac');
    write(s.dir, 'data/user-data/User/settings.json', { portable: 'keep' });
    const { results } = connect(s, { enable: ['vscode'], env: { TEST_MODEL: 'claude-sonnet-5' } });
    assert.equal(byId(results, 'vscode').ok, true, byId(results, 'vscode').error);
    const config = read(s.dir, 'data/user-data/User/settings.json');
    assert.equal(config.portable, 'keep');
    assert.ok(config['claudeCode.environmentVariables'].some((e: { name: string }) => e.name === 'ANTHROPIC_API_KEY'));
    assert.equal(fs.existsSync(path.join(s.dir, '.config/Code/User/settings.json')), false);
    connect(s, { disable: ['vscode'], key: '' });
    assert.deepEqual(read(s.dir, 'data/user-data/User/settings.json'), { portable: 'keep' });
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('connect: an invalid portable profile stops before any request', unix, () => {
  const s = sandbox();
  try {
    stub(s, 'code', 'printf "1.100.0\\n"');
    s.env.VSCODE_PORTABLE = path.join(s.dir, 'missing-data');
    const { results } = connect(s, { enable: ['vscode'] });
    assert.match(byId(results, 'vscode').error!, /VSCODE_PORTABLE/);
    assert.equal(requests(s).length, 0);
    assert.equal(fs.existsSync(path.join(s.dir, '.claude')), false);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

function stubSandboxEditor(s: ReturnType<typeof sandbox>, kind: 'snap' | 'flatpak', config?: string) {
  if (kind === 'snap') {
    write(s.dir, 'snap-mount/usr/share/code/resources/app/product.json', { applicationName: 'code', nameShort: 'Code' });
    stub(
      s,
      'snap',
      `case "$1" in\nlist) printf "code 1.100.0\\n";;\nrun) case "$2" in\n--shell) printf "PURPLESCHOOL_HOME=%s\\nPURPLESCHOOL_CONFIG=%s\\nPURPLESCHOOL_SNAP=%s\\n" "$HOME" "${config ?? '$HOME/snap/code/current/.config'}" "$HOME/snap-mount";;\n*) printf "%s\\n" "$*" >> "$HOME/editor-calls"; case "$*" in *--version*) printf "1.100.0\\n";; *) printf "anthropic.claude-code@2.1.300\\nopenai.chatgpt@1.0.0\\n";; esac;;\nesac;;\nesac`,
    );
  } else {
    write(s.dir, 'flatpak-mount/files/extra/vscode/resources/app/product.json', { applicationName: 'code', nameShort: 'Code' });
    stub(
      s,
      'flatpak',
      'case "$1" in\ninfo) case "$*" in *--user*) printf "%s\\n" "$HOME/flatpak-mount";; *) exit 1;; esac;;\nrun) case "$*" in\n*--command=sh*) printf "PURPLESCHOOL_HOME=%s\\nPURPLESCHOOL_CONFIG=%s\\nPURPLESCHOOL_SNAP=\\n" "$HOME" "$HOME/.var/app/com.visualstudio.code/config";;\n*) printf "%s\\n" "$*" >> "$HOME/editor-calls"; case "$*" in *--version*) printf "1.100.0\\n";; *) printf "anthropic.claude-code@2.1.300\\nopenai.chatgpt@1.0.0\\n";; esac;;\nesac;;\nesac',
    );
  }
}

for (const kind of ['snap', 'flatpak'] as const) {
  test(`connect: a ${kind} VS Code is checked and set up in its own profile`, { skip: process.platform !== 'linux' }, () => {
    const s = sandbox();
    try {
      stubSandboxEditor(s, kind);
      const { results } = connect(s, { enable: ['vscode'], env: { TEST_MODEL: 'claude-sonnet-5' } });
      assert.equal(byId(results, 'vscode').ok, true, byId(results, 'vscode').error);
      const file =
        kind === 'snap'
          ? 'snap/code/current/.config/Code/User/settings.json'
          : '.var/app/com.visualstudio.code/config/Code/User/settings.json';
      assert.ok(
        read(s.dir, file)['claudeCode.environmentVariables'].some(
          (e: { name: string; value: string }) => e.name === 'ANTHROPIC_MODEL' && e.value === 'claude-sonnet-5',
        ),
      );
      const calls = fs.readFileSync(path.join(s.dir, 'editor-calls'), 'utf8');
      assert.match(calls, /--list-extensions/);
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  });
}

test('connect: removal finds the same custom sandbox config that setup used', { skip: process.platform !== 'linux' }, () => {
  const s = sandbox();
  try {
    stubSandboxEditor(s, 'snap', '$HOME/custom-snap-config');
    connect(s, { enable: ['vscode'], env: { TEST_MODEL: 'claude-sonnet-5' } });
    assert.match(invoke(s, 'anthropic', 'vscode', 'is-configured').stdout, /true/);
    const { results } = connect(s, { disable: ['vscode'], key: '' });
    assert.equal(byId(results, 'vscode').ok, true, byId(results, 'vscode').error);
    assert.equal(read(s.dir, 'custom-snap-config/Code/User/settings.json')['claudeCode.environmentVariables'], undefined);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

for (const scenario of ['active Code', 'invalid metadata', 'another product', 'broken version command'] as const) {
  test(`connect: versioned Windows-style installation is resolved before checking extensions: ${scenario}`, unix, () => {
    const s = sandbox();
    try {
      const commit = '1234567890abcdef1234567890abcdef12345678';
      const installation = 'Microsoft VS Code';
      const command = path.join(s.dir, installation, 'bin/code.cmd');
      const body = [
        '#!/bin/sh',
        'printf "%s\\n" "$1" >> "$HOME/editor-calls"',
        'case "$1" in',
        scenario === 'broken version command' ? '--version) exit 2;;' : '--version) printf "%s\\n" "1.139.1" "' + commit + '" "x64";;',
        '*) printf "%s\\n" "anthropic.claude-code@2.1.300";;',
        'esac',
        '',
      ].join('\n');
      write(s.dir, path.join(installation, 'bin/code.cmd'), body);
      fs.chmodSync(command, 0o755);
      fs.symlinkSync(command, path.join(s.bin, 'code'));
      write(s.dir, path.join(installation, 'resources/app/product.json'), { applicationName: 'code', nameShort: 'Stale Code' });
      write(s.dir, `${installation}/abcdef1234/resources/app/product.json`, { applicationName: 'devin', nameShort: 'Old Devin' });
      const activeFile = `${installation}/${commit.slice(0, 10)}/resources/app/product.json`;
      // Нечитаемые метаданные больше не останавливают настройку: спросить некого, а расширение проверяет сам редактор.
      const proceeds = scenario === 'active Code' || scenario === 'invalid metadata';
      write(
        s.dir,
        activeFile,
        scenario === 'invalid metadata'
          ? '{broken'
          : {
              applicationName: scenario === 'another product' ? 'devin' : 'code',
              nameShort: scenario === 'another product' ? 'Devin' : 'Code',
            },
      );
      const { results } = connect(s, { enable: ['vscode'], env: { TEST_MODEL: 'claude-sonnet-5' } });
      const r = byId(results, 'vscode');
      assert.equal(r.ok, proceeds, r.error);
      const calls = fs.readFileSync(path.join(s.dir, 'editor-calls'), 'utf8').trim().split('\n');
      assert.deepEqual(
        calls.filter((c) => c.startsWith('--')),
        proceeds ? ['--version', '--list-extensions'] : ['--version'],
      );
      if (proceeds) assert.equal(read(s.dir, '.claude/settings.json').model, 'claude-sonnet-5');
      else {
        assert.equal(requests(s).length, 0);
        assert.equal(fs.existsSync(path.join(s.dir, '.claude')), false);
        assert.match(r.error!, scenario === 'another product' ? /найден Devin/ : /Не удалось проверить версию/);
      }
    } finally {
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  });
}

test('connect: scan always lists terminal agents and reports what is already connected', () => {
  const s = sandbox();
  try {
    s.env.TEST_BASE_URL = ANTHROPIC_BASE_URL;
    assert.equal(invoke(s, 'anthropic', 'pi-cli').status, 0);
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'test/connect/fixtures/run.mts', 'scan'], {
      cwd: root,
      env: s.env,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    const list = JSON.parse(result.stdout.trim()) as { id: string; configured: boolean }[];
    // Редакторы ищутся и в стандартных папках (/Applications), поэтому на машине разработчика в списке могут быть и они.
    const always = [
      'claude-code-cli',
      'openai-codex-cli',
      'opencode',
      'openai-opencode',
      'pi-cli',
      'openai-pi-cli',
      'anthropic-qwen-code',
      'openai-qwen-code',
      'crush',
      'openai-crush',
    ];
    for (const id of always)
      assert.ok(
        list.some((c) => c.id === id),
        id,
      );
    // Neovim — редактор: без установленного nvim его строки нет.
    assert.ok(!list.some((c) => c.id === 'neovim-avante'));
    assert.equal((list.find((c) => c.id === 'pi-cli') as { installed?: boolean }).installed, false);
    assert.equal(list.find((c) => c.id === 'pi-cli')!.configured, true);
    assert.equal(list.find((c) => c.id === 'claude-code-cli')!.configured, false);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('Crush: both families live in their own crushrc blocks, repeatable and removable without touching user lines', () => {
  const s = sandbox();
  try {
    write(s.dir, '.config/crush/crushrc', '# мои настройки\npermissions allow view edit\n');
    for (let i = 0; i < 2; i++) {
      assert.equal(invoke(s, 'anthropic', 'crush').status, 0);
      assert.equal(invoke(s, 'openai', 'openai-crush').status, 0);
    }
    const rc = () => fs.readFileSync(path.join(s.dir, '.config/crush/crushrc'), 'utf8');
    const text = rc();
    assert.match(text, /^permissions allow view edit$/m);
    assert.equal(text.split('# >>> purpleschool anthropic >>>').length, 2, 'один блок Claude');
    assert.equal(text.split('# >>> purpleschool openai >>>').length, 2, 'один блок GPT');
    assert.match(text, /provider add purpleschool-anthropic --type messages --base-url '[^']+\/v1' --api-key "\$ANTHROPIC_API_KEY"/);
    assert.match(text, /provider add purpleschool-openai --type responses --base-url '[^']+\/v1' --api-key "\$OPENAI_API_KEY"/);
    assert.match(text, /model add 'purpleschool-anthropic\/claude-test-selected' --name 'Claude Test'/);
    assert.match(invoke(s, 'anthropic', 'crush', 'is-configured').stdout, /true/);
    assert.equal(invoke(s, 'anthropic', 'crush', 'remove').status, 0);
    const after = rc();
    assert.doesNotMatch(after, /purpleschool anthropic/);
    assert.match(after, /purpleschool openai/);
    assert.match(after, /^permissions allow view edit$/m);
    assert.match(invoke(s, 'anthropic', 'crush', 'is-configured').stdout, /false/);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('Crush: a model name with quotes cannot break out of the bash string', unix, async () => {
  const { buildCrush } = await import('../../src/main/connect/services/shared/proxyClients.js');
  const s = sandbox();
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, SHELL: process.env.SHELL };
  try {
    Object.assign(process.env, { HOME: s.dir, XDG_CONFIG_HOME: path.join(s.dir, '.config'), SHELL: '/bin/bash' });
    await buildCrush('anthropic').apply({
      apiKey: 'test-only-key',
      baseUrl: 'https://example.invalid/anthropic',
      platform: 'linux',
      dryRun: false,
      model: 'claude-x',
      proxyModels: { 'claude-x': "Claude 'quoted' $(touch pwned)" },
    });
    const text = fs.readFileSync(path.join(s.dir, '.config/crush/crushrc'), 'utf8');
    // Bash читает строку как один литерал: команда внутри не выполняется.
    const out = spawnSync(
      '/bin/bash',
      [
        '-c',
        `set -- ${text
          .split('\n')
          .find((l) => l.startsWith('model add'))!
          .slice('model add '.length)}; printf '%s' "$3"`,
      ],
      {
        cwd: s.dir,
        encoding: 'utf8',
      },
    );
    assert.equal(out.stdout, "Claude 'quoted' $(touch pwned)");
    assert.equal(fs.existsSync(path.join(s.dir, 'pwned')), false);
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});

test('JetBrains is detected by any IDE settings folder', async () => {
  const { jetbrainsInstalled } = await import('../../src/main/connect/core/os.js');
  const s = sandbox();
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, APPDATA: process.env.APPDATA };
  try {
    Object.assign(process.env, { HOME: s.dir, XDG_CONFIG_HOME: path.join(s.dir, '.config'), APPDATA: path.join(s.dir, 'AppData') });
    assert.equal(jetbrainsInstalled(), false);
    const root =
      process.platform === 'darwin'
        ? path.join(s.dir, 'Library/Application Support/JetBrains')
        : process.platform === 'win32'
          ? path.join(s.dir, 'AppData/JetBrains')
          : path.join(s.dir, '.config/JetBrains');
    fs.mkdirSync(path.join(root, 'Toolbox'), { recursive: true });
    assert.equal(jetbrainsInstalled(), false, 'одна папка Toolbox — ещё не IDE');
    fs.mkdirSync(path.join(root, 'WebStorm2026.2'), { recursive: true });
    assert.equal(jetbrainsInstalled(), true);
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
});
