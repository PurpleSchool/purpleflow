// Monaco для диффа: воркер из бандла, тема и язык по расширению файла.
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

// Monaco из бандла, без CDN: приложение работает офлайн.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

// Дифф только для чтения: языковые сервисы TS/JS не нужны и без своих воркеров дают ложные ошибки.
{
  const m = monaco as unknown as { languages?: { typescript?: TsApi }; typescript?: TsApi };
  const ts = m.typescript ?? m.languages?.typescript;
  for (const d of [ts?.typescriptDefaults, ts?.javascriptDefaults]) {
    d?.setDiagnosticsOptions?.({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
  }
}
interface TsApi {
  typescriptDefaults?: { setDiagnosticsOptions?: (o: object) => void };
  javascriptDefaults?: { setDiagnosticsOptions?: (o: object) => void };
}

monaco.editor.defineTheme('purpleflow-night', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '5f616a', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'b2a5f5' },
    { token: 'string', foreground: '9fcfb5' },
    { token: 'number', foreground: 'd9b97f' },
    { token: 'type', foreground: '9cc0dc' },
  ],
  colors: {
    'editor.background': '#00000000',
    'editor.foreground': '#d4d5da',
    'editorLineNumber.foreground': '#3e4047',
    'editorLineNumber.activeForeground': '#a7a9b1',
    'editor.lineHighlightBackground': '#14151900',
    'editor.lineHighlightBorder': '#00000000',
    'editorGutter.background': '#00000000',
    'diffEditor.insertedTextBackground': '#74c4a01c',
    'diffEditor.removedTextBackground': '#df7e8d22',
    'diffEditor.insertedLineBackground': '#74c4a00c',
    'diffEditor.removedLineBackground': '#df7e8d0e',
    'diffEditorGutter.insertedLineBackground': '#74c4a018',
    'diffEditorGutter.removedLineBackground': '#df7e8d18',
    'diffEditor.diagonalFill': '#ffffff0c',
    'diffEditor.border': '#ffffff0e',
    'editor.selectionBackground': '#8a74ee40',
    'scrollbarSlider.background': '#ffffff12',
    'scrollbarSlider.hoverBackground': '#ffffff22',
    'editorOverviewRuler.border': '#00000000',
    'editorWidget.background': '#1a1b1fee',
  },
});
const LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  py: 'python',
  go: 'go',
  rs: 'rust',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  sql: 'sql',
  vue: 'html',
};
export const langOf = (p: string) => LANG[p.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext';
