import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyMention, rankFiles, rankSkills, tokenAt } from './mentions';

test('tokenAt: @ и / в начале слова под курсором', () => {
  assert.deepEqual(tokenAt('посмотри @src/a', 15), { kind: 'file', query: 'src/a', start: 9, end: 15 });
  assert.deepEqual(tokenAt('@', 1), { kind: 'file', query: '', start: 0, end: 1 });
  // Курсор в середине слова: запрос — до курсора, слово целиком заменится.
  assert.deepEqual(tokenAt('/rev12 дальше', 4), { kind: 'skill', query: 'rev', start: 0, end: 6 });
  assert.deepEqual(tokenAt('строка\n/de', 10), { kind: 'skill', query: 'de', start: 7, end: 10 });
  assert.equal(tokenAt('почта a@b.c', 11), null, '@ внутри слова — не упоминание');
  assert.equal(tokenAt('путь /usr/bin', 13), null, 'путь — не скилл');
  assert.equal(tokenAt('просто текст', 6), null);
  assert.equal(tokenAt('@файл ', 6), null, 'после пробела слово закончилось');
});

test('rankFiles: имя с начала, имя содержит, путь содержит, буквы по порядку', () => {
  const files = ['src/components/Button.tsx', 'src/lib/button-utils.ts', 'docs/buttons/guide.md', 'src/b/u/t.ts', 'README.md'];
  // Внутри одного класса совпадения выше короткий путь.
  assert.deepEqual(rankFiles(files, 'butt'), [
    'src/lib/button-utils.ts',
    'src/components/Button.tsx',
    'docs/buttons/guide.md',
    'src/b/u/t.ts',
  ]);
  assert.deepEqual(rankFiles(files, 'utils'), ['src/lib/button-utils.ts']);
  assert.deepEqual(rankFiles(files, 'sbut'), [
    'src/b/u/t.ts',
    'docs/buttons/guide.md',
    'src/lib/button-utils.ts',
    'src/components/Button.tsx',
  ]);
  assert.deepEqual(rankFiles(files, 'zzz'), []);
  assert.deepEqual(rankFiles(files, '', 2), files.slice(0, 2));
});

test('rankSkills: имя с начала, имя содержит, описание', () => {
  const s = (name: string, description?: string) => ({ name, description, path: `/${name}`, source: 'project' as const });
  const skills = [s('deploy', 'Выкатить'), s('pr-review', 'Ревью PR'), s('review', 'Ревью кода'), s('pdf')];
  assert.deepEqual(
    rankSkills(skills, 'rev').map((x) => x.name),
    ['review', 'pr-review'],
  );
  assert.deepEqual(
    rankSkills(skills, 'выкат').map((x) => x.name),
    ['deploy'],
  );
  assert.equal(rankSkills(skills, '').length, 4);
});

test('applyMention: заменяет набранное слово и ставит курсор после пробела', () => {
  const text = 'глянь @bu и ответь';
  const t = tokenAt(text, 9)!;
  assert.deepEqual(applyMention(text, t, 'src/Button.tsx'), { text: 'глянь @src/Button.tsx и ответь', caret: 22 });
  const s = tokenAt('/re', 3)!;
  assert.deepEqual(applyMention('/re', s, 'review'), { text: '/review ', caret: 8 });
});
