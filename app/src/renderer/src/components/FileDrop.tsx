import { useEffect, useRef, useState } from 'react';
import { FileText, Paperclip, X } from 'lucide-react';

export interface PickedFile {
  id: string;
  name: string;
  file: File;
  /** Превью для изображений; у остальных файлов — null. */
  url: string | null;
}

const MAX_MB = 20;
const isImage = (f: File) => /^image\/(png|jpe?g|gif|webp|bmp)$/.test(f.type);

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}

/** Файлы к задаче: изображения, документы, логи, выгрузки — перетащить, вставить из буфера (⌘V) или выбрать. */
export function FileDrop({ files, onChange }: { files: PickedFile[]; onChange: (next: PickedFile[]) => void }) {
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(files);
  latest.current = files;

  const add = (list: FileList | File[]) => {
    const all = [...list];
    const big = all.filter((f) => f.size > MAX_MB * 1024 * 1024);
    setError(big.length ? `Файлы больше ${MAX_MB} МБ пропущены: ${big.map((f) => f.name).join(', ')}` : null);
    const ok = all
      .filter((f) => f.size <= MAX_MB * 1024 * 1024)
      .map((f, i) => ({
        id: `${Date.now()}-${i}-${f.name}`,
        name: f.name || `screenshot-${i + 1}.png`,
        file: f,
        url: isImage(f) ? URL.createObjectURL(f) : null,
      }));
    if (ok.length) onChange([...latest.current, ...ok]);
  };

  // Вставка из буфера в любом месте экрана новой задачи: скриншот или скопированный в Finder файл. Текст вставляется как обычно.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const pasted = [...(e.clipboardData?.files ?? [])];
      if (pasted.length) {
        e.preventDefault();
        add(pasted);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const remove = (id: string) => {
    const f = files.find((x) => x.id === id);
    if (f?.url) URL.revokeObjectURL(f.url);
    onChange(files.filter((x) => x.id !== id));
  };

  return (
    <div
      className={`imgdrop ${over ? 'is-over' : ''} ${files.length ? 'has-items' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        add(e.dataTransfer.files);
      }}
    >
      {files.map((f) =>
        f.url ? (
          <figure key={f.id} className="imgdrop-thumb" title={f.name}>
            <img src={f.url} alt={f.name} />
            <button className="imgdrop-del" onClick={() => remove(f.id)} title="Убрать">
              <X size={12} />
            </button>
          </figure>
        ) : (
          <figure key={f.id} className="file-chip" title={f.name}>
            <FileText size={16} />
            <span className="file-chip-text">
              <strong>{f.name}</strong>
              <small>{fileSize(f.file.size)}</small>
            </span>
            <button className="imgdrop-del" onClick={() => remove(f.id)} title="Убрать">
              <X size={12} />
            </button>
          </figure>
        ),
      )}
      <button className="imgdrop-add" onClick={() => input.current?.click()}>
        <Paperclip size={18} />
        <span>
          <strong>{files.length ? 'Ещё файл' : 'Файлы к задаче'}</strong>
          <small>
            Макеты, скриншоты, документы, логи — перетащите, вставьте {window.purpleflow.platform === 'darwin' ? '⌘V' : 'Ctrl+V'} или
            выберите
          </small>
        </span>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) add(e.target.files);
          e.target.value = '';
        }}
      />
      {error && <p className="imgdrop-error">{error}</p>}
    </div>
  );
}
