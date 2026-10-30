// План: proposal, tasks и design изменения OpenSpec.
import type { LineComment, RunFile } from '@purpleflow/core';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { ChangeDocs } from '../../../../../shared/ipc';
import { CommentableMarkdown } from '../../../components/CommentableMarkdown';
import { Empty } from '../../../components/ui';

export function PlanView({
  docs,
  run,
  comments,
  onComments,
  editable,
}: {
  docs: ChangeDocs | null;
  run: RunFile;
  comments: LineComment[];
  onComments: (c: LineComment[]) => void;
  editable: boolean;
}) {
  const [specOpen, setSpecOpen] = useState<string | null>(null);
  // Путь от корня рабочей копии — так планировщик сразу найдёт файл.
  const at = (f: string) => `openspec/changes/${run.changeId}/${f}`;
  const doc = (f: string, source: string, className?: string) => (
    <CommentableMarkdown
      file={at(f)}
      source={source}
      comments={comments}
      onComments={onComments}
      editable={editable}
      className={className}
    />
  );
  if (!docs)
    return (
      <div className="center">
        <span className="spinner big" />
      </div>
    );
  if (!docs.proposal && !docs.tasks) {
    return (
      <Empty icon={<Sparkles />} title="План ещё пишется">
        Планировщик создаёт изменение <code>{run.changeId}</code>. Ход работы — в логе этой попытки ниже, когда она закончится, здесь
        появятся файлы.
      </Empty>
    );
  }
  const done = (docs.tasks.match(/- \[x\]/gi) ?? []).length;
  const all = (docs.tasks.match(/- \[[ x]\]/gi) ?? []).length;
  return (
    <div className="scroll">
      <div className="plan">
        <article className="doc bezel">
          <header className="doc-head">
            <span>proposal.md</span>
            <span className="mono muted">{run.changeId}</span>
          </header>
          {doc('proposal.md', docs.proposal)}
        </article>
        <article className="doc bezel">
          <header className="doc-head">
            <span>tasks.md</span>
            {all > 0 && (
              <span className="progress" title={`${done} из ${all}`}>
                <i style={{ width: `${(done / all) * 100}%` }} />
                <b>
                  {done}/{all}
                </b>
              </span>
            )}
          </header>
          {doc('tasks.md', docs.tasks, 'tasks')}
        </article>
        {docs.design && (
          <article className="doc bezel">
            <header className="doc-head">
              <span>design.md</span>
            </header>
            {doc('design.md', docs.design)}
          </article>
        )}
        {docs.specs.length > 0 && (
          <article className="doc bezel">
            <header className="doc-head">
              <span>Дельты спецификаций</span>
              <span className="muted">{docs.specs.length}</span>
            </header>
            {docs.specs.map((s) => (
              <div key={s.path} className="spec">
                <button
                  className="spec-toggle"
                  onClick={() => setSpecOpen(specOpen === s.path ? null : s.path)}
                  aria-expanded={specOpen === s.path}
                >
                  <span className="mono">{s.path}</span>
                  <span className="muted">{specOpen === s.path ? 'свернуть' : 'показать'}</span>
                </button>
                {(specOpen === s.path || comments.some((c) => c.file === at(s.path))) && doc(s.path, s.content, 'spec-md')}
              </div>
            ))}
          </article>
        )}
      </div>
    </div>
  );
}
