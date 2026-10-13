import { createI18n } from "vue-i18n";

// Launcher texts. The panel itself has its own translations on the server.

const ru = {
  title: "ClawDesk",
  servers: "Серверы",
  empty: "Серверов пока нет. Установите ClawDesk на новый сервер или добавьте уже установленный.",
  install: "Установить на сервер",
  add: "Добавить сервер",
  open: "Открыть панель",
  remove: "Удалить из списка",
  removeConfirm: "Убрать сервер из приложения? На самом сервере ничего не изменится.",
  viaTunnel: "через SSH-туннель",
  hostKey: "Ключ сервера",
  back: "Назад",
  name: "Название",
  host: "IP-адрес или имя сервера",
  port: "SSH-порт",
  user: "Пользователь",
  password: "Пароль сервера",
  passwordHint: "Нужен один раз: приложение поставит на сервер свой ключ и дальше входит по нему. Пароль не сохраняется.",
  privateKey: "Или приватный SSH-ключ (OpenSSH)",
  panelUrl: "Адрес панели с HTTPS (если есть)",
  panelUrlHint: "Пусто — панель откроется через защищённый SSH-туннель, домен не нужен.",
  save: "Добавить",
  https: "Как открывать панель",
  httpsDomain: "Свой домен (HTTPS)",
  httpsSslip: "Без домена: адрес <ip>.sslip.io (HTTPS)",
  httpsTunnel: "Только из этого приложения (SSH-туннель, без HTTPS)",
  domain: "Домен (A-запись уже указывает на сервер)",
  installLead: "Нужен свежий сервер Ubuntu 22.04/24.04 или Debian 12 (x86-64, от 2 ГБ памяти) и его root-пароль от провайдера.",
  installStart: "Установить",
  installing: "Устанавливаю…",
  installDone: "Готово. Задайте пароль владельца панели.",
  installFailed: "Установка не удалась",
  openSetup: "Открыть панель и задать пароль",
  log: "Журнал установки",
  updateAvailable: "Доступна новая версия {v}",
  updateInstall: "Обновить",
};

const en: typeof ru = {
  title: "ClawDesk",
  servers: "Servers",
  empty: "No servers yet. Install ClawDesk on a new server or add one that has it.",
  install: "Install on a server",
  add: "Add a server",
  open: "Open the panel",
  remove: "Remove from the list",
  removeConfirm: "Remove the server from the app? Nothing changes on the server itself.",
  viaTunnel: "through an SSH tunnel",
  hostKey: "Server key",
  back: "Back",
  name: "Name",
  host: "Server IP or name",
  port: "SSH port",
  user: "User",
  password: "Server password",
  passwordHint: "Used once: the app puts its own key on the server and signs in with it afterwards. The password is not kept.",
  privateKey: "Or a private SSH key (OpenSSH)",
  panelUrl: "Panel address with HTTPS (if any)",
  panelUrlHint: "Empty — the panel opens through a secure SSH tunnel, no domain needed.",
  save: "Add",
  https: "How to open the panel",
  httpsDomain: "My own domain (HTTPS)",
  httpsSslip: "No domain: <ip>.sslip.io (HTTPS)",
  httpsTunnel: "Only from this app (SSH tunnel, no HTTPS)",
  domain: "Domain (its A record already points at the server)",
  installLead: "A fresh Ubuntu 22.04/24.04 or Debian 12 server (x86-64, 2 GB+ memory) and its root password from the provider.",
  installStart: "Install",
  installing: "Installing…",
  installDone: "Done. Set the panel owner's password.",
  installFailed: "Installation failed",
  openSetup: "Open the panel and set the password",
  log: "Installation log",
  updateAvailable: "Version {v} is available",
  updateInstall: "Update",
};

const tg: typeof ru = {
  ...ru,
  servers: "Серверҳо",
  empty: "Ҳоло сервер нест. ClawDesk-ро ба сервери нав насб кунед ё сервери насбшударо илова кунед.",
  install: "Насб кардан ба сервер",
  add: "Илова кардани сервер",
  open: "Кушодани панел",
  back: "Бозгашт",
  installStart: "Насб кардан",
  installing: "Насб мекунам…",
  installDone: "Тайёр. Пароли соҳиби панелро гузоред.",
  installFailed: "Насб нашуд",
  openSetup: "Кушодани панел ва гузоштани парол",
};

const saved = (() => {
  try {
    return localStorage.getItem("clawdesk.locale");
  } catch {
    return null;
  }
})();

export const i18n = createI18n({
  legacy: false,
  locale: saved === "en" || saved === "tg" ? saved : "ru",
  fallbackLocale: "ru",
  messages: { ru, en, tg },
});
