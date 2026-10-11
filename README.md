# ClawDesk

Open-source self-hosted панель для [OpenClaw](https://github.com/openclaw/openclaw): обычный человек без терминала
поднимает главного ИИ-агента, подключает свои сервисы и Telegram, а потом создаёт младших агентов —
диетолога, тренера, YouTube-помощника или команду проекта.

> Статус: **этап 0** — каркас и проверка RPC против живого OpenClaw 2026.8.1. Пока не для продакшена:
> вход в панель появится на этапе 1, до этого панель слушает только `127.0.0.1`.

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
  docker-compose.yml       gateway + panel
  docker-compose.dev.yml   gateway для разработки на хосте
  scripts/init.sh          первый запуск: .env, онбординг OpenClaw, старт
```

## Разработка

Нужно: Node ≥ 22.19 (лучше 24 LTS), pnpm 10, Docker.

```bash
pnpm install
bash deploy/scripts/init.sh --dev        # Gateway в Docker на 127.0.0.1:18789, создаёт apps/bff/.env
pnpm dev:bff                             # BFF на :8080
pnpm dev:web                             # админка на :5173 (проксирует /api на BFF)
```

Проверки: `pnpm typecheck`, `pnpm test`, `pnpm build`.

## Установка на сервер (предварительно)

```bash
bash deploy/scripts/init.sh              # gateway + panel, панель на 127.0.0.1:8080
```

HTTPS наружу — через Caddy или Cloudflare Tunnel перед панелью. Порт Gateway (18789) наружу не открывается.

## Шаблоны агентов

Шаблон — папка `packages/templates/agents/<mode>/<id>/` с `template.json` и заготовками `SOUL.md`, `AGENTS.md`,
`USER.md` с `{{плейсхолдерами}}`. Свой шаблон можно прислать пулл-реквестом.

## Лицензия

MIT. OpenClaw распространяется под своей лицензией MIT, её файл остаётся в зависимостях.
