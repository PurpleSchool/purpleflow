// Протокол ядра: события (ядро → окно) и команды (окно → ядро).

import type { ChatFile } from './chat.js';
import type {
  ControlAction,
  GateId,
  LineComment,
  ManagerMessage,
  PreviewState,
  ReviewResult,
  RunFile,
  RunMode,
  RunStatus,
  StageId,
  TestResult,
  Workspace,
} from './run.js';
import type { PrFollowupItem } from './pr.js';

export type CoreEvent =
  | { type: 'stage.started'; runId: string; stage: StageId; attempt: number }
  | { type: 'agent.output'; runId: string; stage: StageId; text: string }
  | { type: 'tests.result'; runId: string; result: TestResult }
  | { type: 'review.result'; runId: string; result: ReviewResult }
  | { type: 'gate.waiting'; runId: string; gate: GateId; message?: string }
  | { type: 'stage.failed'; runId: string; stage: StageId; error: string }
  | { type: 'run.finished'; runId: string; status: RunStatus; message?: string }
  /** Кадр браузера агента визуальной проверки (JPEG base64); null — трансляция закончилась. */
  | { type: 'visual.frame'; runId: string; frame: { data: string; url: string; width: number; height: number } | null }
  /** Приложение прогона для ручной проверки во вкладке «Браузер». */
  | { type: 'preview.state'; runId: string; state: PreviewState }
  /** Снимок run.json после каждого изменения — UI просто перерисовывается. */
  | { type: 'run.updated'; run: RunFile }
  /** Чат менеджера прогона изменился; thinking — менеджер готовит ответ. */
  | { type: 'manager.updated'; runId: string; messages: ManagerMessage[]; thinking: boolean }
  | { type: 'run.deleted'; runId: string }
  /** Чат изменился: новое сообщение, кусок ответа или конец хода; busy — агент отвечает. */
  | { type: 'chat.updated'; chat: ChatFile; busy: boolean }
  | { type: 'chat.deleted'; chatId: string };

export interface StartRunInput {
  projectPath: string;
  task: string;
  testCommand: string;
  setupCommand?: string;
  lintCommand?: string;
  mode?: RunMode;
  /** Визуальная проверка: команда запуска приложения ({port} — свободный порт) и адрес. */
  runCommand?: string;
  appUrl?: string;
  visual?: boolean;
  autopilot?: boolean;
  visualNotes?: string;
  envFiles?: string[];
  workspace?: Workspace;
  /** Ветка, от которой начать задачу; по умолчанию — текущая ветка проекта. */
  baseBranch?: string;
  /** Изображения к задаче (скриншоты, макеты) — байты из окна. */
  attachments?: { name: string; data: Uint8Array }[];
  /** Вложения прошлого прогона (следующая часть задачи) — копируются как есть. */
  attachmentPaths?: string[];
}

export type CoreCommand =
  | { type: 'run.start'; input: StartRunInput }
  | { type: 'run.resume'; runId: string }
  | { type: 'gate.approve'; runId: string; comment?: string }
  | { type: 'gate.reject'; runId: string; comment: string; lineComments?: LineComment[] }
  | { type: 'gate.cancel'; runId: string }
  /** Попытки исчерпаны: человек принимает как есть и идёт на приёмку. */
  | { type: 'gate.accept'; runId: string }
  /** Ответы на вопросы уточнения (пустой список — продолжить без ответов). */
  | { type: 'gate.answer'; runId: string; answers: { q: string; a: string }[] }
  /** Приёмка: небольшая правка в той же ветке — потом только проверки и снова приёмка, без ревью и визуальной. */
  | { type: 'gate.fix'; runId: string; comment: string; lineComments?: LineComment[] }
  | { type: 'run.stop'; runId: string }
  /** Управление на ходу: заметка, пауза, переделать попытку, вернуться к плану. */
  | { type: 'run.control'; runId: string; action: ControlAction }
  /** Не ждать реализации и проверок: остановить текущую попытку и перейти к ревью (или приёмке). */
  | { type: 'run.skipChecks'; runId: string }
  /** Ещё раз визуальная проверка (например, после правки команды запуска) — с приёмки или остановленного прогона. */
  | { type: 'run.rerunVisual'; runId: string }
  | { type: 'run.merge'; runId: string; target: string }
  /** Отправить ветку на GitHub и открыть Pull Request в base. */
  | { type: 'run.pr'; runId: string; base: string }
  /** Влить открытый PR (gh pr merge --merge). */
  | { type: 'run.prMerge'; runId: string }
  | { type: 'run.prFollowup'; runId: string; items: PrFollowupItem[]; note?: string }
  | { type: 'run.updateBranch'; runId: string }
  /** Удалить прогон: рабочую копию, данные приложения и, по желанию, ветку purpleflow/<id>. */
  | { type: 'run.delete'; runId: string; deleteBranch: boolean };
