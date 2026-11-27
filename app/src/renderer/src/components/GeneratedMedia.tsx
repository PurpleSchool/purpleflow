// Картинки, которые агент нарисовал через MCP PurpleSchool: прямо в ответе, под шагами — не в свёрнутом списке вызовов.
// Пока generate_image работает — заглушка с промптом. Картинку скачивает main: CSP окна не пускает внешние ссылки.
import { useEffect, useState } from 'react';
import type { ChatToolPart } from '@purpleflow/core';
import { Download, ExternalLink, ImageOff, Maximize2, Sparkles, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { bridge } from '../lib/api';

const GENERATE = 'purpleschool · generate_image';
const MEDIA_CALL = /^purpleschool · (generate_image|get_image_task)\b/;

/** Промпт из строки вызова: «purpleschool · generate_image <первая строка промпта>». */
const promptOf = (t: ChatToolPart) => (t.text.startsWith(GENERATE) ? t.text.slice(GENERATE.length).trim() : '');

export function GeneratedMedia({ items }: { items: ChatToolPart[] }) {
  const calls = items.filter((t) => MEDIA_CALL.test(t.text));
  if (!calls.length) return null;
  // Подпись картинки — промпт последнего generate_image до неё (get_image_task своего промпта не знает).
  const shown: { url: string; prompt: string }[] = [];
  let prompt = '';
  for (const t of calls) {
    prompt = promptOf(t) || prompt;
    for (const url of t.images ?? []) if (!shown.some((s) => s.url === url)) shown.push({ url, prompt });
  }
  const drawing = calls.filter((t) => t.text.startsWith(GENERATE) && t.status === 'running');
  if (!shown.length && !drawing.length) return null;
  return (
    <div className="chat-gen">
      {shown.map((s) => (
        <GenImage key={s.url} url={s.url} prompt={s.prompt} />
      ))}
      {drawing.map((t, i) => (
        <figure key={t.id ?? i} className="chat-gen-card is-drawing" aria-label="Рисую картинку">
          <div className="chat-gen-frame">
            <Sparkles size={20} />
            <span>Рисую картинку…</span>
          </div>
          {promptOf(t) && <figcaption>{promptOf(t)}</figcaption>}
        </figure>
      ))}
    </div>
  );
}

function GenImage({ url, prompt }: { url: string; prompt: string }) {
  const [media, setMedia] = useState<{ src: string; mime: string; data: Uint8Array } | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let blob: string | null = null;
    void bridge.mediaFetch(url).then((m) => {
      if (!alive) return;
      if (!m) return setFailed(true);
      blob = URL.createObjectURL(new Blob([m.data as BlobPart], { type: m.mime }));
      setMedia({ src: blob, mime: m.mime, data: m.data });
    });
    return () => {
      alive = false;
      if (blob) URL.revokeObjectURL(blob);
    };
  }, [url]);
  const save = async () => {
    if (!media) return;
    const path = await bridge.mediaSave(media.data, fileName(prompt, media.mime));
    if (path) setSaved(path);
  };
  const alt = prompt || 'Картинка от агента';
  return (
    <figure className={`chat-gen-card ${media ? '' : 'is-loading'}`}>
      <div className="chat-gen-frame">
        {media ? (
          <button type="button" className="chat-gen-img" onClick={() => setZoom(true)} title="Увеличить">
            <img src={media.src} alt={alt} />
          </button>
        ) : failed ? (
          <>
            <ImageOff size={20} />
            <span>Не удалось загрузить картинку</span>
            <button type="button" className="link" onClick={() => void window.open(url, '_blank')}>
              Открыть в браузере
            </button>
          </>
        ) : (
          <span className="spinner" />
        )}
        {media && (
          <div className="chat-gen-tools">
            <button type="button" aria-label="Увеличить" title="Увеличить" onClick={() => setZoom(true)}>
              <Maximize2 size={14} />
            </button>
            <button type="button" aria-label="Скачать" title="Скачать" onClick={() => void save()}>
              <Download size={14} />
            </button>
          </div>
        )}
      </div>
      {saved ? <figcaption className="chat-gen-saved">Сохранено: {saved}</figcaption> : prompt && <figcaption>{prompt}</figcaption>}
      {zoom && media && <Lightbox src={media.src} alt={alt} onClose={() => setZoom(false)} onSave={() => void save()} url={url} />}
    </figure>
  );
}

/** Имя файла по умолчанию: начало промпта латиницей, расширение — по типу картинки. */
function fileName(prompt: string, mime: string): string {
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }[mime] ?? 'png';
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-');
  return `${slug || 'image'}.${ext}`;
}

/** Картинка во весь экран поверх приложения: Esc или клик по фону закрывают. */
function Lightbox({ src, alt, url, onClose, onSave }: { src: string; alt: string; url: string; onClose: () => void; onSave: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal aria-label="Картинка" onClick={onClose}>
      <img src={src} alt={alt} />
      <div className="lightbox-tools" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onSave}>
          <Download size={15} /> Скачать
        </button>
        <button type="button" onClick={() => void window.open(url, '_blank')}>
          <ExternalLink size={15} /> Оригинал
        </button>
        <button type="button" aria-label="Закрыть" title="Закрыть (Esc)" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
