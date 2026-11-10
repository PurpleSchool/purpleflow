// Отчёты об ошибках и статистика использования — один выключатель в настройках.

/**
 * Значение выключателя из сохранённых настроек. Раньше выключателей было два: выключенный любой из них выключает общий.
 * Кто настроил приложение до появления отчётов, предупреждения не видел: для них отправка выключена, пока не включат сами.
 */
export function diagnosticsFrom(raw: {
  diagnostics?: boolean;
  errorReports?: boolean;
  usageEvents?: boolean;
  onboarded?: boolean;
}): boolean {
  if (raw.diagnostics !== undefined) return raw.diagnostics;
  const fallback = !raw.onboarded;
  return (raw.errorReports ?? fallback) && (raw.usageEvents ?? fallback);
}
