# ClawDesk

Open-source self-hosted панель для [OpenClaw](https://github.com/openclaw/openclaw): обычный человек без терминала
поднимает главного ИИ-агента, подключает свои сервисы и Telegram, а потом создаёт младших агентов —
диетолога, тренера, YouTube-помощника или команду проекта.

> Статус: MVP в работе. Есть вход в панель по паролю владельца и установка на сервер с HTTPS;
> на настоящем сервере установка ещё не прогонялась.

## Как устроено

```
браузер / десктоп ──HTTP──▶ panel (Fastify BFF + Vue) ──WS loopback──▶ OpenClaw Gateway ──▶ модели, Telegram, сервисы
```

- Браузер говорит только с BFF. BFF — единственный клиент Gateway; device-токен и секреты живут на сервере.
- OpenClaw — зависимость, а не форк. Версия зафиксирована: `2026.8.1`.
- Модель — любая: Claude, OpenAI, DeepSeek, Qwen, Kimi, GLM, MiniMax, локальные или подписка. Каждый пользователь
  подключает свой ключ; модель младших агентов выбирается в интерфейсе.

Подробно: [docs/architecture.md](docs/architecture.md). Ход этапа 0: [docs/stage-0.md](docs/stage-0.md).

## Структура

```
apps/
  bff/          Fastify + @openclaw/gateway-client: подключение, парование, RPC-цепочки с откатом, SQLite (Drizzle)
  web/          Vue 3 + Naive UI + Pinia + vue-i18n (ru / en / tg)
packages/
  shared/       zod-схемы и типы, общие для web и bff
  templates/    шаблоны агентов: template.json + SOUL.md / AGENTS.md / USER.md
deploy/
  docker-compose.yml       gateway + panel (+ Caddy для HTTPS, профиль https)
  docker-compose.dev.yml   gateway для разработки на хосте
  install.sh               установка на сервер Ubuntu / Debian: Docker, код, HTTPS, первый запуск
  scripts/init.sh          первый запуск: .env, онбординг OpenClaw, старт
```

## Разработка

Нужно: Node ≥ 22.19 (лучше 24 LTS), pnpm 10, Docker.

```bash
pnpm install
bash deploy/scripts/init.sh --dev        # Gateway в Docker на 127.0.0.1:18789, создаёт apps/bff/.env
pnpm dev:bff                             # BFF на :8787
pnpm dev:web                             # админка на :5173 (проксирует /api на BFF)
```

Проверки: `pnpm typecheck`, `pnpm test`, `pnpm build` (то же делает CI на каждый пуш в `main`).

Релиз: тег `v0.1.0` → GitHub Actions публикует образы `clawdesk-panel`, `clawdesk-gateway`, `clawdesk-sandbox` в ghcr.io.
На сервере `CLAWDESK_VERSION=0.1.0` в `deploy/.env` — установка скачает их вместо сборки (для приватных пакетов
нужен `docker login ghcr.io`, иначе соберёт сама).

## Установка на сервер

Сервер: Ubuntu 22.04 / 24.04 или Debian 12, x86-64, от 2 ГБ памяти (лучше 4 ГБ), 20 ГБ диска, открытые порты 80 и 443.
Домен по желанию: его A-запись должна смотреть на IP сервера. Без домена панель получит адрес `<ip>.sslip.io`.

```bash
# пока репозиторий приватный: скопировать код на сервер (git clone с токеном GitHub или scp), затем
sudo bash clawdesk/deploy/install.sh --domain panel.example.com
```

Установщик ставит Docker, собирает образы, поднимает gateway + panel + Caddy (сертификат Let's Encrypt) и печатает
ссылку `https://<домен>/setup?code=…` — по ней задаётся пароль владельца. Повторный запуск того же
`install.sh` обновляет код и перезапускает, данные (`/var/lib/clawdesk`) и `deploy/.env` сохраняются.

Бэкапы: каждую ночь в `/var/lib/clawdesk/backups` (последние 7), в панели — «Система»: сделать сейчас, скачать
копию (шифруется паролем), сбросить всё. Восстановление: `sudo bash deploy/scripts/restore.sh <файл>`.

Наружу смотрят только 80/443 (Caddy). Панель — на `127.0.0.1:8080` (доступна через SSH-туннель), Gateway — только
внутри контейнера.

## Десктоп-приложение

`apps/desktop` — Tauri 2 (Windows, macOS, Linux). Агенты на компьютере не работают: приложение — лаунчер.

- **Серверы:** список, вход по SSH-ключу приложения (хранится в Windows Credential Manager / Keychain / Secret Service),
  ключ сервера запоминается при первом подключении и потом сверяется.
- **Установить на сервер:** IP + root-пароль → приложение ставит на сервер свой ключ (пароль не сохраняется),
  заливает по SFTP вшитый в него код этой же версии и запускает `deploy/install.sh` с журналом по шагам.
- **Панель** открывается в отдельном окне: по HTTPS-домену или через SSH-туннель на `127.0.0.1:8080` сервера — домен
  не нужен. Окну панели разрешены только уведомления (одобрения агентов приходят системным уведомлением).
- **Трей** и **автообновление** из релизов GitHub (подпись ключом обновлений).

```bash
pnpm --filter @clawdesk/desktop tauri dev      # нужно: Rust, на Windows — Visual Studio Build Tools (C++)
pnpm --filter @clawdesk/desktop tauri build    # установщики в apps/desktop/src-tauri/target/release/bundle
```

## Шаблоны агентов

Шаблон — папка `packages/templates/agents/<mode>/<id>/` с `template.json` и заготовками `SOUL.md`, `AGENTS.md`,
`USER.md` с `{{плейсхолдерами}}`. Свой шаблон можно прислать пулл-реквестом.

## Лицензия

MIT. OpenClaw распространяется под своей лицензией MIT, её файл остаётся в зависимостях.
