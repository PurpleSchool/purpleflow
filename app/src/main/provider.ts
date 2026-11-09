/**
 * Провайдер аккаунта и AI-прокси — PurpleSchool. Всё, что знает о нём main, собрано здесь.
 *
 * Аккаунт необязателен: без него claude и codex работают по подпискам пользователя. Сборка без аккаунта —
 * PURPLEFLOW_ACCOUNT=off при сборке или запуске: пропадают экран входа, вкладки «Аккаунт» и «Расход»,
 * а прокси подключается только по адресу, указанному в настройках вручную.
 */
const flag = process.env.PURPLEFLOW_ACCOUNT || process.env.PURPLEFLOW_ACCOUNT_BUILD || '';

export const ACCOUNT_ENABLED = !/^(off|0|false|no)$/i.test(flag);

/**
 * Куда уходят отчёты об ошибках (GlitchTip). DSN только принимает события, поэтому хранится открыто.
 * PURPLEFLOW_ERROR_REPORTS=off отключает отчёты при сборке или запуске, =on включает их вне собранного приложения.
 */
export const ERROR_REPORTS_DSN = 'https://4a6c8ccfd9bc4128ba19f6f5fa1966c5@errors.purplecode.ru/5';
export const ERROR_REPORTS_FLAG = process.env.PURPLEFLOW_ERROR_REPORTS || process.env.PURPLEFLOW_ERROR_REPORTS_BUILD || '';

/** API аккаунта: вход, ключи, расход. */
export const ACCOUNT_API = (process.env.PURPLEFLOW_API_URL || 'https://app.purpleschool.ru/api-v2').replace(/\/+$/, '');

/**
 * Адреса AI-прокси — как в официальной инструкции подключения (GET /public/ai-proxy/setup-instructions):
 * claude — Anthropic API, codex — OpenAI Responses API. Переопределяются переменными PURPLEFLOW_PROXY_URL и
 * PURPLEFLOW_CODEX_PROXY_URL или полями baseUrl и codexBaseUrl в settings.json. Без аккаунта адресов по умолчанию нет.
 */
export const DEFAULT_PROXY = {
  claude: process.env.PURPLEFLOW_PROXY_URL || (ACCOUNT_ENABLED ? `${ACCOUNT_API}/public/ai-proxy/anthropic` : ''),
  codex: process.env.PURPLEFLOW_CODEX_PROXY_URL || (ACCOUNT_ENABLED ? `${ACCOUNT_API}/public/ai-proxy/openai/v1` : ''),
};
