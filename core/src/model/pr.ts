// Pull Request: статус, замечания и круг доработки.

/** Состояние Pull Request и проверок CI. */
export interface PrStatus {
  url: string;
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  mergeable: boolean;
  conflicts: boolean;
  /** Слияние заблокировано правилами ветки (нужно ревью, обязательные проверки). */
  blocked: boolean;
  /** В базовой ветке есть коммиты, которых нет в ветке PR. */
  behind: boolean;
  review: string | null;
  checks: { total: number; passed: number; failed: number; pending: number };
  /** Упавшие проверки CI: название и ссылка (для GitHub Actions — на job с логом). */
  failedChecks?: { name: string; url: string | null }[];
  mergeCommit: string | null;
}

/** Замечание в PR: обсуждение в коде, итог ревью, общий комментарий или упавшая проверка CI. */
export interface PrComment {
  id: string;
  kind: 'thread' | 'review' | 'comment' | 'check';
  author: string;
  body: string;
  at: string;
  url?: string;
  path?: string;
  line?: number;
  /** Обсуждение в коде закрыто как решённое или устарело после новых коммитов. */
  resolved?: boolean;
  outdated?: boolean;
  /** Ответы в обсуждении (первое сообщение — body). */
  replies?: { author: string; body: string; at: string }[];
  /** Состояние ревью: APPROVED, CHANGES_REQUESTED, COMMENTED. */
  state?: string;
}

export interface PrDetails {
  title: string;
  status: PrStatus;
  comments: PrComment[];
  fetchedAt: string;
}

/** Что отработать в круге доработки по PR. */
export interface PrFollowupItem {
  id: string;
  kind: PrComment['kind'];
  author: string;
  body: string;
  path?: string;
  line?: number;
  url?: string;
}
