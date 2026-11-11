// Упоминания в чате: файлы, скиллы и команды, блок промпта.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findMentions, listSkills, mentionsBlock, walkFiles } from './services/mentions.js';

function tree(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mentions-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

test('walkFiles: файлы папки без служебных каталогов, с пределом', (t) => {
  const root = tree(t, { 'a.ts': '', 'src/b.ts': '', 'node_modules/x/i.js': '', '.git/HEAD': '', 'dist/out.js': '' });
  assert.deepEqual(walkFiles(root), ['a.ts', 'src/b.ts']);
  assert.deepEqual(walkFiles(root, 1), ['a.ts']);
  assert.deepEqual(walkFiles(path.join(root, 'нет')), []);
});

test('listSkills: скиллы и команды проекта и пользователя, описания, проектный важнее', (t) => {
  const project = tree(t, {
    '.claude/skills/review/SKILL.md': '---\nname: review\ndescription: "Ревью по чек-листу"\n---\n\nТекст',
    '.claude/skills/empty/README.md': 'не скилл',
    '.claude/commands/deploy.md': '# Выкатить на стейджинг\n\nшаги',
    '.claude/commands/frontend/test.md': 'Прогнать тесты фронта',
    '.agents/skills/shared/SKILL.md': '---\ndescription: Общий\n---',
  });
  const home = tree(t, {
    '.claude/skills/review/SKILL.md': '---\ndescription: Пользовательский\n---',
    '.claude/skills/pdf/SKILL.md': '---\ndescription: PDF\n---',
    '.codex/prompts/explain.md': 'Объясни код',
    // Синхронизированные с claude.ai — на уровень глубже.
    '.claude/skills/synced/acc-123/xlsx/SKILL.md': '---\ndescription: Таблицы\n---',
    '.claude/skills/synced/manifest.json': '{}',
    '.claude/plugins/installed_plugins.json': JSON.stringify({
      version: 2,
      plugins: { 'tools@market': [{ installPath: '__PLUGIN__' }], 'broken@market': [{}] },
    }),
  });
  const plugin = path.join(home, 'plugin');
  fs.mkdirSync(path.join(plugin, 'skills', 'lint'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'skills', 'lint', 'SKILL.md'), '---\ndescription: Линт\n---');
  fs.mkdirSync(path.join(plugin, 'commands'));
  fs.writeFileSync(path.join(plugin, 'commands', 'ship.md'), 'Выкатить');
  const pj = path.join(home, '.claude/plugins/installed_plugins.json');
  // Путь — как JSON-строка: на Windows в нём обратные слэши, без экранирования JSON не прочитается.
  fs.writeFileSync(pj, fs.readFileSync(pj, 'utf8').replace('"__PLUGIN__"', JSON.stringify(plugin)));
  const all = listSkills({ projectPath: project, userConfig: true, home });
  assert.deepEqual(
    all.map((s) => [s.name, s.source, s.description]),
    [
      ['deploy', 'project', 'Выкатить на стейджинг'],
      ['explain', 'user', 'Объясни код'],
      ['frontend:test', 'project', 'Прогнать тесты фронта'],
      ['pdf', 'user', 'PDF'],
      ['review', 'project', 'Ревью по чек-листу'],
      ['shared', 'project', 'Общий'],
      ['tools:lint', 'user', 'Линт'],
      ['tools:ship', 'user', 'Выкатить'],
      ['xlsx', 'user', 'Таблицы'],
    ],
  );
  assert.equal(all.find((s) => s.name === 'review')!.path, path.join(project, '.claude/skills/review/SKILL.md'));
  // Без настроек пользователя агент не видит ~/.claude — и подсказка тоже.
  assert.deepEqual(
    listSkills({ projectPath: project, userConfig: false, home }).map((s) => s.name),
    ['deploy', 'frontend:test', 'review', 'shared'],
  );
  // Чат без проекта — только пользовательские.
  assert.deepEqual(
    listSkills({ userConfig: true, home }).map((s) => s.name),
    ['explain', 'pdf', 'review', 'tools:lint', 'tools:ship', 'xlsx'],
  );
});

test('findMentions: существующие файлы внутри папки и известные скиллы; mentionsBlock', (t) => {
  const cwd = tree(t, { 'src/a.ts': '', 'README.md': '' });
  const skills = [{ name: 'review', path: '/s/review/SKILL.md', source: 'project' as const }];
  const m = findMentions(
    'Посмотри @src/a.ts, и @README.md. А @нет.ts и @../чужое и a@b.c — нет. /review пожалуйста, путь /usr/bin и /unknown не скиллы',
    cwd,
    skills,
  );
  assert.deepEqual(m.files, [path.join(cwd, 'src/a.ts'), path.join(cwd, 'README.md')]);
  assert.deepEqual(m.skills, skills);
  assert.equal(
    mentionsBlock(m),
    `\n\nФайлы, которые упомянул человек (открой и прочитай):\n- ${path.join(cwd, 'src/a.ts')}\n- ${path.join(cwd, 'README.md')}` +
      '\n\nЧеловек вызвал скилл — прочитай инструкции и следуй им:\n- /review: /s/review/SKILL.md',
  );
  assert.equal(mentionsBlock(findMentions('без упоминаний', cwd, skills)), '');
});
