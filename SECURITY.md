# Безопасность / Security

Нашли уязвимость — не открывайте публичный issue. Сообщите приватно через [GitHub Security Advisories](../../security/advisories/new): что затронуто, как воспроизвести, чем грозит. Ответим в течение нескольких рабочих дней.

Found a vulnerability? Please do not open a public issue. Report it privately via [GitHub Security Advisories](../../security/advisories/new) with the affected area, reproduction steps and impact.

## Что важно для модели угроз / Threat model notes

- Ключи AI-прокси и токен аккаунта хранятся в main-процессе через `safeStorage` и никогда не передаются в окно (renderer).
- Окно работает с `sandbox`, `contextIsolation` и без Node; вкладка «Браузер» — отдельная сессия без preload, только `localhost`.
- Агенты (`claude`, `codex`) запускаются как внешние CLI в рабочей копии прогона; PurpleFlow не выполняет код из ответов модели сам, кроме команд, которые человек подтвердил кнопкой.
