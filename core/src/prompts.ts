import fs from 'node:fs';
import path from 'node:path';

/** Промпты стадий лежат в core/prompts/*.md и подставляют переменные вида {{name}}. */
export class Prompts {
  constructor(private dir: string) {}

  raw(name: string): string {
    return fs.readFileSync(path.join(this.dir, name), 'utf8');
  }

  render(name: string, vars: Record<string, string | number | undefined>): string {
    return this.raw(name).replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(vars[k] ?? ''));
  }

  json<T>(name: string): T {
    return JSON.parse(this.raw(name)) as T;
  }
}
