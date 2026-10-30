import { getLocales } from 'expo-localization';
import { useSyncExternalStore } from 'react';

const en = {
  incidents: 'Incidents', settings: 'Settings', connect: 'Connect', incident: 'Incident',
  signIn: 'Sign in', backendUrl: 'Backend URL', savedServer: 'Saved on this device. Use the address of your i7y installation.', language: 'Language', toggleTheme: 'Toggle theme', unsupportedServer: 'This server does not support the mobile app yet. Update the server to enable access.',
  connectTitle: 'Your response starts here', connectBody: 'Connect to your i7y server to follow incidents and take ownership when it matters.',
  server: 'Server', serverUrl: 'Server URL', serverPlaceholder: 'https://inventory.example.com', verifyServer: 'Verify server',
  verified: 'Server verified', browserLogin: 'Sign in with browser', browserLoginBody: 'Sign in securely on your server. Return here when you finish.',
  compareCode: 'Compare this code with the one in your browser before approving.', waitingLogin: 'Waiting for browser sign-in…',
  working: 'Working…', cancel: 'Cancel', retry: 'Try again', refresh: 'Refresh', loading: 'Loading…',
  connectionError: 'Could not connect. Check the server address and try again.', signInError: 'Sign-in did not finish. Please try again.',
  requestError: 'Could not load data. Check your connection and try again.', refreshError: 'Could not refresh. Previously loaded data is still shown.',
  actionError: 'Could not complete the action. Your choices have been kept.', conflict: 'This incident changed. Review the latest state before trying again.',
  uncertain: 'The result is not yet confirmed. Refresh to check the incident before taking another action.', confirmed: 'Latest state confirmed. Review the incident before taking another action.',
  organization: 'Organization', noOrganizations: 'No organizations available', noOrganizationsBody: 'Ask your server administrator for access to an organization.',
  search: 'Search incidents', status: 'Status', severity: 'Severity', open: 'Open', resolved: 'Resolved', all: 'All',
  info: 'Info', warning: 'Warning', critical: 'Critical', inProgress: 'In progress', overdue: 'Overdue', mine: 'Assigned to you',
  empty: 'All clear', emptyBody: 'No incidents match these filters. Change your filters or pull to refresh.', clearFilters: 'Reset filters',
  more: 'Load more', resource: 'Resource', origin: 'Origin', opened: 'Opened', deadline: 'Claim deadline', assignee: 'Assignee', unassigned: 'Unassigned',
  details: 'Details', response: 'Response', claim: 'Claim incident', extend: 'Extend deadline', resolve: 'Resolve incident',
  claimBody: 'Choose how long you need. The deadline is shown in your local time.', minutes: '{count} min', customMinutes: 'Custom minutes',
  custom: 'Custom', invalidMinutes: 'Enter a whole number from 1 to 10,080 minutes.', deadlinePreview: 'New deadline: {date}',
  reader: 'Your organization role allows viewing only.', otherOwner: 'Another responder owns this incident until the deadline.',
  resolveTitle: 'Resolve this incident?', resolveBody: 'This marks the incident as manually resolved for everyone in the organization.',
  resolveRuleBody: 'This resolves the current incident. The rule stays active and can open a new incident if the problem continues.',
  resolvedAt: 'Resolved at', resolutionReason: 'Resolution', evidence: 'Evidence', timeline: 'Timeline', noEvidence: 'No evidence supplied.', noEvents: 'No timeline events supplied.',
  eventOpened: 'Incident opened', eventClaimed: 'Incident claimed', eventExtended: 'Deadline extended', eventResolved: 'Incident resolved', eventUpdated: 'Incident updated',
  account: 'Account', role: 'Role', readerRole: 'Reader', editorRole: 'Editor', adminRole: 'Administrator',
  notifications: 'Notifications', pushEnabled: 'Notifications enabled', pushDisabled: 'Notifications disabled', pushUnconfigured: 'Server push is not configured',
  pushDenied: 'Notification permission denied', pushRegistering: 'Enabling notifications…', pushUnavailable: 'Notifications unavailable', pushPending: 'Notification removal pending',
  pushEnabledBody: 'Receive incident updates for this connection.', pushDisabledBody: 'Enable notifications to receive incident updates on this device.',
  pushUnconfiguredBody: 'Your server administrator needs to configure push delivery.', pushDeniedBody: 'Allow notifications in your device settings, then try again.',
  pushUnavailableBody: 'Push delivery requires a supported device and a configured app build.', pushPendingBody: 'The device still needs to be removed from the server. Retry while online.',
  disableShort: 'Disable', enableShort: 'Enable', enablePush: 'Enable notifications', disablePush: 'Disable notifications', retryRemoval: 'Retry removal', pushError: 'Could not update notifications. Check your connection and try again.',
  signOut: 'Sign out', signOutTitle: 'Sign out of this account?', signOutBody: 'You will need to sign in again to respond to incidents.',
  switchServer: 'Switch server', switchServerTitle: 'Switch to another server?', switchServerBody: 'This signs out of the current server and removes this connection from the device.',
  accountError: 'Could not finish. Check your connection and try again.', browserSecurity: 'Your password stays in the browser on your server.',
  unavailable: 'Unavailable', noIncident: 'Incident unavailable', noIncidentBody: 'It may have been removed, or your organization may no longer have access.',
};
export type MessageKey = keyof typeof en;
type Messages = Record<MessageKey, string>;
const pt: Messages = {
  incidents: 'Incidentes', settings: 'Ajustes', connect: 'Conectar', incident: 'Incidente',
  signIn: 'Entrar', backendUrl: 'URL do backend', savedServer: 'Salvo neste dispositivo. Use o endereço da sua instalação do i7y.', language: 'Idioma', toggleTheme: 'Alternar tema', unsupportedServer: 'Este servidor ainda não oferece suporte ao app. Atualize o servidor para habilitar o acesso.',
  connectTitle: 'Sua resposta começa aqui', connectBody: 'Conecte seu servidor i7y para acompanhar incidentes e assumir a resposta quando precisar.',
  server: 'Servidor', serverUrl: 'URL do servidor', serverPlaceholder: 'https://inventory.example.com', verifyServer: 'Verificar servidor',
  verified: 'Servidor verificado', browserLogin: 'Entrar pelo navegador', browserLoginBody: 'Entre com segurança no seu servidor. Volte aqui ao terminar.',
  compareCode: 'Compare este código com o do navegador antes de aprovar.', waitingLogin: 'Aguardando entrada pelo navegador…',
  working: 'Aguarde…', cancel: 'Cancelar', retry: 'Tentar novamente', refresh: 'Atualizar', loading: 'Carregando…',
  connectionError: 'Não foi possível conectar. Confira o endereço do servidor e tente novamente.', signInError: 'A entrada não foi concluída. Tente novamente.',
  requestError: 'Não foi possível carregar. Confira sua conexão e tente novamente.', refreshError: 'Não foi possível atualizar. Os dados anteriores continuam visíveis.',
  actionError: 'Não foi possível concluir a ação. Suas escolhas foram mantidas.', conflict: 'Este incidente mudou. Revise o estado atualizado antes de tentar novamente.',
  uncertain: 'O resultado ainda não foi confirmado. Atualize para conferir o incidente antes de outra ação.', confirmed: 'Estado atualizado confirmado. Revise o incidente antes de outra ação.',
  organization: 'Organização', noOrganizations: 'Nenhuma organização disponível', noOrganizationsBody: 'Peça ao administrador do servidor acesso a uma organização.',
  search: 'Buscar incidentes', status: 'Estado', severity: 'Severidade', open: 'Abertos', resolved: 'Resolvidos', all: 'Todos',
  info: 'Informação', warning: 'Atenção', critical: 'Crítico', inProgress: 'Em andamento', overdue: 'Prazo vencido', mine: 'Atribuído a você',
  empty: 'Tudo em ordem', emptyBody: 'Nenhum incidente corresponde aos filtros. Altere os filtros ou puxe para atualizar.', clearFilters: 'Limpar filtros',
  more: 'Carregar mais', resource: 'Recurso', origin: 'Origem', opened: 'Abertura', deadline: 'Prazo da responsabilidade', assignee: 'Responsável', unassigned: 'Sem responsável',
  details: 'Detalhes', response: 'Resposta', claim: 'Assumir incidente', extend: 'Estender prazo', resolve: 'Resolver incidente',
  claimBody: 'Escolha quanto tempo precisa. O prazo aparece no seu horário local.', minutes: '{count} min', customMinutes: 'Minutos personalizados',
  custom: 'Personalizado', invalidMinutes: 'Informe um número inteiro de 1 a 10.080 minutos.', deadlinePreview: 'Novo prazo: {date}',
  reader: 'Seu papel na organização permite apenas visualizar.', otherOwner: 'Outro responsável assumiu este incidente até o prazo indicado.',
  resolveTitle: 'Resolver este incidente?', resolveBody: 'O incidente será marcado como resolvido manualmente para toda a organização.',
  resolveRuleBody: 'Esta ocorrência será resolvida. A regra continua ativa e pode abrir outro incidente se o problema persistir.',
  resolvedAt: 'Resolução em', resolutionReason: 'Resolução', evidence: 'Evidências', timeline: 'Histórico', noEvidence: 'Nenhuma evidência informada.', noEvents: 'Nenhum evento informado.',
  eventOpened: 'Incidente aberto', eventClaimed: 'Responsabilidade assumida', eventExtended: 'Prazo estendido', eventResolved: 'Incidente resolvido', eventUpdated: 'Incidente atualizado',
  account: 'Conta', role: 'Papel', readerRole: 'Leitor', editorRole: 'Editor', adminRole: 'Administrador',
  notifications: 'Notificações', pushEnabled: 'Notificações ativadas', pushDisabled: 'Notificações desativadas', pushUnconfigured: 'Servidor sem notificações configuradas',
  pushDenied: 'Permissão de notificações negada', pushRegistering: 'Ativando notificações…', pushUnavailable: 'Notificações indisponíveis', pushPending: 'Remoção de notificações pendente',
  pushEnabledBody: 'Receba atualizações de incidentes desta conexão.', pushDisabledBody: 'Ative para receber atualizações de incidentes neste dispositivo.',
  pushUnconfiguredBody: 'O administrador do servidor precisa configurar o envio de notificações.', pushDeniedBody: 'Permita notificações nos ajustes do dispositivo e tente novamente.',
  pushUnavailableBody: 'As notificações exigem um dispositivo compatível e uma versão configurada do aplicativo.', pushPendingBody: 'O dispositivo ainda precisa ser removido do servidor. Tente novamente com conexão.',
  disableShort: 'Desativar', enableShort: 'Ativar', enablePush: 'Ativar notificações', disablePush: 'Desativar notificações', retryRemoval: 'Tentar remover novamente', pushError: 'Não foi possível alterar as notificações. Confira sua conexão e tente novamente.',
  signOut: 'Sair da conta', signOutTitle: 'Sair desta conta?', signOutBody: 'Você precisará entrar novamente para responder a incidentes.',
  switchServer: 'Trocar servidor', switchServerTitle: 'Trocar de servidor?', switchServerBody: 'Você sairá do servidor atual e esta conexão será removida do dispositivo.',
  accountError: 'Não foi possível concluir. Confira sua conexão e tente novamente.', browserSecurity: 'Sua senha fica no navegador, no seu servidor.',
  unavailable: 'Indisponível', noIncident: 'Incidente indisponível', noIncidentBody: 'Ele pode ter sido removido ou sua organização pode não ter mais acesso.',
};
const uk: Messages = {
  incidents: 'Інциденти', settings: 'Налаштування', connect: 'Підключити', incident: 'Інцидент',
  signIn: 'Увійти', backendUrl: 'Адреса сервера', savedServer: 'Збережено на цьому пристрої. Використовуйте адресу вашої інсталяції i7y.', language: 'Мова', toggleTheme: 'Змінити тему', unsupportedServer: 'Цей сервер ще не підтримує мобільний застосунок. Оновіть сервер, щоб увімкнути доступ.',
  connectTitle: 'Реагування починається тут', connectBody: 'Підключіть свій сервер i7y, щоб стежити за інцидентами та брати відповідальність.',
  server: 'Сервер', serverUrl: 'Адреса сервера', serverPlaceholder: 'https://inventory.example.com', verifyServer: 'Перевірити сервер',
  verified: 'Сервер перевірено', browserLogin: 'Увійти через браузер', browserLoginBody: 'Безпечно увійдіть на своєму сервері. Потім поверніться сюди.',
  compareCode: 'Порівняйте цей код із кодом у браузері перед підтвердженням.', waitingLogin: 'Очікуємо входу через браузер…',
  working: 'Зачекайте…', cancel: 'Скасувати', retry: 'Спробувати знову', refresh: 'Оновити', loading: 'Завантаження…',
  connectionError: 'Не вдалося підключитися. Перевірте адресу сервера та повторіть спробу.', signInError: 'Вхід не завершено. Спробуйте знову.',
  requestError: 'Не вдалося завантажити. Перевірте з’єднання та повторіть спробу.', refreshError: 'Не вдалося оновити. Показано попередні дані.',
  actionError: 'Не вдалося виконати дію. Ваш вибір збережено.', conflict: 'Інцидент змінився. Перегляньте актуальний стан перед повторною спробою.',
  uncertain: 'Результат ще не підтверджено. Оновіть інцидент перед наступною дією.', confirmed: 'Актуальний стан підтверджено. Перегляньте інцидент перед наступною дією.',
  organization: 'Організація', noOrganizations: 'Немає доступних організацій', noOrganizationsBody: 'Попросіть адміністратора сервера надати доступ до організації.',
  search: 'Пошук інцидентів', status: 'Стан', severity: 'Серйозність', open: 'Відкриті', resolved: 'Вирішені', all: 'Усі',
  info: 'Інформація', warning: 'Попередження', critical: 'Критичний', inProgress: 'У роботі', overdue: 'Прострочений', mine: 'Призначено вам',
  empty: 'Усе гаразд', emptyBody: 'Жоден інцидент не відповідає фільтрам. Змініть фільтри або потягніть для оновлення.', clearFilters: 'Скинути фільтри',
  more: 'Завантажити ще', resource: 'Ресурс', origin: 'Джерело', opened: 'Відкрито', deadline: 'Термін відповідальності', assignee: 'Відповідальний', unassigned: 'Не призначено',
  details: 'Деталі', response: 'Реагування', claim: 'Взяти інцидент', extend: 'Продовжити термін', resolve: 'Вирішити інцидент',
  claimBody: 'Виберіть потрібний час. Термін відображається за вашим місцевим часом.', minutes: '{count} хв', customMinutes: 'Власна кількість хвилин',
  custom: 'Інший', invalidMinutes: 'Введіть ціле число від 1 до 10 080 хвилин.', deadlinePreview: 'Новий термін: {date}',
  reader: 'Ваша роль в організації дозволяє лише перегляд.', otherOwner: 'Інший учасник відповідає за цей інцидент до вказаного терміну.',
  resolveTitle: 'Вирішити цей інцидент?', resolveBody: 'Інцидент буде позначено як вирішений вручну для всієї організації.',
  resolveRuleBody: 'Поточний інцидент буде вирішено. Правило залишається активним і може відкрити новий інцидент, якщо проблема триває.',
  resolvedAt: 'Вирішено', resolutionReason: 'Рішення', evidence: 'Докази', timeline: 'Історія', noEvidence: 'Доказів не надано.', noEvents: 'Подій не надано.',
  eventOpened: 'Інцидент відкрито', eventClaimed: 'Інцидент взято в роботу', eventExtended: 'Термін продовжено', eventResolved: 'Інцидент вирішено', eventUpdated: 'Інцидент оновлено',
  account: 'Обліковий запис', role: 'Роль', readerRole: 'Читач', editorRole: 'Редактор', adminRole: 'Адміністратор',
  notifications: 'Сповіщення', pushEnabled: 'Сповіщення ввімкнено', pushDisabled: 'Сповіщення вимкнено', pushUnconfigured: 'Сервер не налаштовано для сповіщень',
  pushDenied: 'Дозвіл на сповіщення відхилено', pushRegistering: 'Увімкнення сповіщень…', pushUnavailable: 'Сповіщення недоступні', pushPending: 'Видалення сповіщень очікує завершення',
  pushEnabledBody: 'Отримуйте оновлення інцидентів для цього підключення.', pushDisabledBody: 'Увімкніть сповіщення про інциденти на цьому пристрої.',
  pushUnconfiguredBody: 'Адміністратор сервера має налаштувати надсилання сповіщень.', pushDeniedBody: 'Дозвольте сповіщення в налаштуваннях пристрою та спробуйте знову.',
  pushUnavailableBody: 'Потрібні сумісний пристрій і налаштована збірка застосунку.', pushPendingBody: 'Пристрій ще потрібно видалити із сервера. Повторіть спробу онлайн.',
  disableShort: 'Вимкнути', enableShort: 'Увімкнути', enablePush: 'Увімкнути сповіщення', disablePush: 'Вимкнути сповіщення', retryRemoval: 'Повторити видалення', pushError: 'Не вдалося змінити сповіщення. Перевірте з’єднання.',
  signOut: 'Вийти', signOutTitle: 'Вийти з облікового запису?', signOutBody: 'Щоб реагувати на інциденти, потрібно буде увійти знову.',
  switchServer: 'Змінити сервер', switchServerTitle: 'Змінити сервер?', switchServerBody: 'Ви вийдете з поточного сервера, і це підключення буде видалено з пристрою.',
  accountError: 'Не вдалося завершити. Перевірте з’єднання та повторіть спробу.', browserSecurity: 'Ваш пароль залишається у браузері на вашому сервері.',
  unavailable: 'Недоступно', noIncident: 'Інцидент недоступний', noIncidentBody: 'Його могли видалити або ваша організація втратила доступ.',
};
export const messages = { en, 'pt-BR': pt, uk };
function systemLocale(): keyof typeof messages {
  for (const item of getLocales()) {
    if (item.languageCode === 'pt') return 'pt-BR';
    if (item.languageCode === 'uk') return 'uk';
    if (item.languageCode === 'en') return 'en';
  }
  return 'en';
}
export type Locale = keyof typeof messages;
let selectedLocale = systemLocale();
const listeners = new Set<() => void>();
export const locale = () => selectedLocale;
export function selectLocale(value: Locale) {
  if (selectedLocale === value) return;
  selectedLocale = value;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useLocale() { return useSyncExternalStore(subscribe, locale, locale); }
export function t(key: MessageKey, values: Record<string, string | number> = {}): string {
  return messages[locale()][key].replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match));
}
