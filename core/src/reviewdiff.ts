/**
 * Дифф для ревью: без генерируемого, код — первым, большие тексты урезаны, крупный дифф — на части
 * для параллельных ревьюеров. Иначе ревьюер видит начало диффа (сборочные артефакты, тексты промптов)
 * и не доходит до кода, где ошибки.
 */

/** Генерируемое и lock-файлы — в ревью не идут (pathspec-глобы git). */
export const GENERATED_GLOBS = [
  '**/*.tsbuildinfo',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lockb',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/go.sum',
  '**/*.map',
  '**/*.min.js',
  '**/*.min.css',
  '**/next-env.d.ts',
  '**/__snapshots__/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
];

/** Сборочные артефакты, которые агент случайно меняет запуском сборки или dev-сервера, — откатываются после реализации. */
export const ARTIFACT_RE = /(^|\/)(next-env\.d\.ts|\.DS_Store|npm-debug\.log[^/]*|yarn-error\.log)$|\.tsbuildinfo$/;

export interface FileDiff {
  path: string;
  text: string;
}

/** Сколько строк добавлено и удалено в диффе одного файла. */
export function lineStats(text: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of text.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  return { add, del };
}

export function splitDiff(diff: string): FileDiff[] {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((c) => c.startsWith('diff --git '))
    .map((text) => ({ path: text.match(/^diff --git a\/(.+?) b\//)?.[1] ?? '', text }));
}

const CODE = /\.(m?[jt]sx?|cjs|py|go|rs|java|kt|kts|swift|rb|php|cs|cpp|cc|c|h|hpp|scala|ex|exs|vue|svelte|sql|prisma|graphql|gql|sh|tf)$/i;
const TEST = /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec|e2e-spec)\.[a-z]+$|_test\.(go|py)$/i;
/** Код, который по сути — большой текст: промпты, словари, фикстуры. */
const TEXTY = /(prompt|template|fixture|mock|i18n|locale|translation)s?[./-]/i;

/** 0 — код, 1 — тесты, 2 — миграции и схемы, 3 — тексты и данные, 4 — OpenSpec (план уже в промпте). */
export function priorityOf(path: string, size: number): number {
  if (path.startsWith('openspec/')) return 4;
  if (!CODE.test(path)) return 3;
  if (TEXTY.test(path) && size > 12_000) return 3;
  if (TEST.test(path)) return 1;
  if (/migrations?\//i.test(path) || /\.(sql|prisma)$/i.test(path)) return 2;
  return 0;
}

/** Больше этого один файл в ревью не занимает: начало файла и пометка, что остальное — через git diff. */
export const FILE_CAP = 24_000;

export interface ReviewParts {
  /** Дифф каждой части — для отдельного ревьюера. */
  parts: string[];
  /** Пути в каждой части. */
  files: string[][];
  /** Файлы, которые урезаны до начала. */
  trimmed: string[];
  /** Не вошли ни в одну часть — ревьюеры дочитают сами через git diff. */
  omitted: string[];
}

/** Модуль файла — первые три сегмента пути: связанные файлы попадают к одному ревьюеру. */
const moduleOf = (path: string) => path.split('/').slice(0, 3).join('/');

export function packReview(diff: string, budget: number, maxParts = 4): ReviewParts {
  const trimmed: string[] = [];
  const files = splitDiff(diff)
    .map((f) => {
      const size = f.text.length;
      let text = f.text;
      if (size > FILE_CAP && !f.path.startsWith('openspec/')) {
        trimmed.push(f.path);
        text =
          f.text.slice(0, FILE_CAP) +
          `\n… (файл урезан: ${Math.round(size / 1024)} КБ в диффе — остальное смотри через git diff -- ${f.path})\n`;
      }
      return { ...f, text, prio: priorityOf(f.path, size) };
    })
    // OpenSpec (proposal, tasks, спецификации) ревьюер уже получает в промпте отдельно.
    .filter((f) => f.prio < 4);
  // Сначала код, внутри приоритета — по модулям, чтобы связанное шло рядом.
  files.sort((a, b) => a.prio - b.prio || moduleOf(a.path).localeCompare(moduleOf(b.path)) || a.path.localeCompare(b.path));

  const total = files.reduce((n, f) => n + f.text.length, 0);
  const count = Math.min(maxParts, Math.max(1, Math.ceil(total / budget)));
  const parts: FileDiff[][] = Array.from({ length: count }, () => []);
  const sizes = new Array<number>(count).fill(0);
  const omitted: string[] = [];
  if (count === 1) {
    for (const f of files) {
      if (sizes[0] + f.text.length > budget) omitted.push(f.path);
      else {
        parts[0].push(f);
        sizes[0] += f.text.length;
      }
    }
  } else {
    // Модули целиком — в наименее заполненную часть; не влезает модуль — по файлам.
    const groups = new Map<string, typeof files>();
    for (const f of files) {
      const key = `${f.prio}:${moduleOf(f.path)}`;
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    for (const group of groups.values()) {
      const size = group.reduce((n, f) => n + f.text.length, 0);
      const i = sizes.indexOf(Math.min(...sizes));
      if (sizes[i] + size <= budget) {
        parts[i].push(...group);
        sizes[i] += size;
        continue;
      }
      for (const f of group) {
        const j = sizes.indexOf(Math.min(...sizes));
        if (sizes[j] + f.text.length > budget) omitted.push(f.path);
        else {
          parts[j].push(f);
          sizes[j] += f.text.length;
        }
      }
    }
  }
  const used = parts.filter((p) => p.length);
  return {
    parts: used.map((p) => p.map((f) => f.text).join('')),
    files: used.map((p) => p.map((f) => f.path)),
    trimmed,
    omitted,
  };
}
