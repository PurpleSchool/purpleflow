// Скиллы: установка и удаление через `npx skills` (подменён заглушкой, сети нет).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Kernel } from './kernel.js';
import { copySkill, installSkill, removeSkill } from './services/skillstore.js';
import type { CoreSettings } from './types.js';

const unix = { skip: process.platform === 'win32' };
const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

/** Ядро с заглушкой npx: пишет аргументы и окружение, на add создаёт скилл в .agents/skills и .claude/skills, на remove — удаляет. */
function setup(t: { after: (fn: () => void) => void }, removeFails = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-skills-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const project = path.join(root, 'project');
  fs.mkdirSync(bin);
  fs.mkdirSync(project);
  const log = path.join(root, 'npx.log');
  fs.writeFileSync(
    path.join(bin, 'npx'),
    `#!/bin/sh
echo "$* | telemetry=$DISABLE_TELEMETRY" >> "${log}"
skill=""; prev=""
for a in "$@"; do [ "$prev" = "-s" ] && skill="$a"; prev="$a"; done
case "$3" in
  add) for d in .agents/skills .claude/skills; do mkdir -p "$d/$skill"; printf -- '---\\ndescription: Скилл\\n---\\n' > "$d/$skill/SKILL.md"; done ;;
  remove) ${removeFails ? 'echo "SKILLS_REMOVE_UNTRACKED_SKIPPED" >&2; exit 1' : 'rm -rf ".agents/skills/$skill" ".claude/skills/$skill"'} ;;
esac
`,
    { mode: 0o755 },
  );
  const settings = { enabledAgents: ['claude', 'agy'], userConfig: false, agents: {}, models: {} } as unknown as CoreSettings;
  const k = new Kernel({
    dataDir: path.join(root, 'data'),
    promptsDir: PROMPTS,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    getSettings: () => settings,
  });
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n');
  return { k, project, calls };
}

test('installSkill: npx skills add для включённых агентов, без вопросов и телеметрии; список обновлён', unix, async (t) => {
  const { k, project, calls } = setup(t);
  const skills = await installSkill(k, { projectPath: project, source: 'vercel-labs/agent-skills', skill: 'react-native' });
  assert.equal(calls()[0], '-y skills add vercel-labs/agent-skills -s react-native -a claude-code -a antigravity-cli -y | telemetry=1');
  assert.ok(skills.some((s) => s.name === 'react-native' && s.source === 'project'));
  await assert.rejects(installSkill(k, { projectPath: project, source: 'evil; rm -rf /', skill: 'x' }), /Неверное имя/);
});

test('removeSkill: поставленный через skills убирает CLI — в корзину ничего', unix, async (t) => {
  const { k, project, calls } = setup(t);
  await installSkill(k, { projectPath: project, source: 'a/b', skill: 'rn' });
  const r = await removeSkill(k, { projectPath: project, name: 'rn', source: 'project' });
  assert.match(calls()[1], /^-y skills remove -s rn -y /);
  assert.deepEqual(r.leftovers, []);
  assert.ok(!r.skills.some((s) => s.name === 'rn'));
});

test('removeSkill: положенный руками — CLI его не знает, обе копии папки уходят окну на корзину', unix, async (t) => {
  const { k, project } = setup(t, true);
  for (const d of ['.agents/skills/mine', '.claude/skills/mine']) {
    fs.mkdirSync(path.join(project, d), { recursive: true });
    fs.writeFileSync(path.join(project, d, 'SKILL.md'), '---\ndescription: Свой\n---');
  }
  const r = await removeSkill(k, { projectPath: project, name: 'mine', source: 'project' });
  assert.deepEqual(r.leftovers.map((p) => path.relative(project, p).split(path.sep).join('/')).sort(), [
    '.agents/skills/mine',
    '.claude/skills/mine',
  ]);
  await assert.rejects(removeSkill(k, { projectPath: project, name: 'нет-такого', source: 'project' }), /уже удалён|Неверное имя/);
});

test('installSkill: только для выбранных агентов из включённых', unix, async (t) => {
  const { k, project, calls } = setup(t);
  await installSkill(k, { projectPath: project, source: 'a/b', skill: 'x', agents: ['agy', 'codex'] });
  // codex выключен в настройках — его нет; agy выбран.
  assert.match(calls()[0], / -a antigravity-cli -y /);
  assert.doesNotMatch(calls()[0], /claude-code|codex/);
  await assert.rejects(installSkill(k, { projectPath: project, source: 'a/b', skill: 'x', agents: ['codex'] }), /ни один агент/);
});

test('copySkill: скилл claude копируется для agy в .agents/skills; повтор и команды — ошибка', unix, async (t) => {
  const { k, project } = setup(t);
  const dir = path.join(project, '.claude/skills/mine');
  fs.mkdirSync(path.join(dir, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\ndescription: Свой\n---');
  fs.writeFileSync(path.join(dir, 'refs/a.md'), 'справка');
  const skills = await copySkill(k, { projectPath: project, name: 'mine', source: 'project', to: 'agy' });
  assert.equal(fs.readFileSync(path.join(project, '.agents/skills/mine/refs/a.md'), 'utf8'), 'справка');
  assert.ok(skills.find((s) => s.name === 'mine')!.agents!.includes('agy'));
  await assert.rejects(copySkill(k, { projectPath: project, name: 'mine', source: 'project', to: 'agy' }), /уже видит/);
  fs.mkdirSync(path.join(project, '.claude/commands'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude/commands/deploy.md'), 'Выкатить');
  await assert.rejects(copySkill(k, { projectPath: project, name: 'deploy', source: 'project', to: 'codex' }), /только скиллы/);
});
