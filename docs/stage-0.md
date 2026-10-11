# Этап 0 — спайк против живого OpenClaw 2026.8.1

Цель: до рисования экранов проверить, что всё, что панель обещает пользователю, делается через RPC Gateway.
Следующий этап не начинается, пока чек-лист ниже не закрыт.

## Чек-лист

- [ ] Поднять `openclaw@2026.8.1` в Docker, онбординг один раз — `deploy/scripts/init.sh --dev`
- [ ] Минимальный BFF: `connect` → парование устройства → `deviceToken` сохранён → `agents.list` — `pnpm --filter @clawdesk/bff rpc-inventory`
- [ ] Цепочка `agents.create` → `agents.files.set` → `config.patch` → `cron.add` → `chat.send` с откатом — `pnpm spike` (без модели: `pnpm spike -- --no-chat`)
- [ ] Есть ли RPC для логина модели и OAuth плагинов — `rpc-inventory --wizard`
- [ ] Cron срабатывает после рестарта Gateway без сообщений — `cron-test --create` / `--check`
- [ ] Агент с sandbox и одной смонтированной папкой читает её, а чужую нет

## Что уже выяснено из пакетов 2026.8.1 (до живого запуска)

Источник: `@openclaw/gateway-protocol@2026.8.1/protocol.schema.json` (393 метода) и документация внутри пакета `openclaw`.

**Подключение.** Протокол v4. Устройство — Ed25519; `deviceId = sha256(сырой 32-байтный ключ)` hex; ключ и подпись — base64url.
Подписывается payload v3 (`buildDeviceAuthPayloadV3`) с nonce из `connect.challenge`. Реализовано в
`apps/bff/src/gateway/device-identity.ts`, проверено тестом против логики верификатора Gateway.

**Парование.** Подключения с loopback одобряются молча. Поэтому в `deploy/docker-compose.yml` панель живёт в сетевом
namespace Gateway (`network_mode: service:gateway`): Gateway слушает только loopback, порт 18789 наружу не открыт,
а панель паруется без участия человека. В dev-режиме (BFF на хосте) соединение идёт через мост Docker и требует
одного ручного `devices approve`.

**Риск «логин модели только через CLI» — скорее закрыт.** Есть `wizard.start { flow: "setup" | "channels" }` +
`wizard.next`: Gateway сам ведёт мастер, шаги типизированы (`note`, `select`, `text`, `confirm`, `multiselect`,
`progress`, `action`), у секретных полей `sensitive: true`, для OAuth есть `externalUrl` и `deviceCode`.
Значит экран «Подключить модель» и OAuth источников может рисовать шаги мастера Gateway, а не дублировать логику
провайдеров. Это же даёт любые модели (Claude, OpenAI, DeepSeek, Qwen, Kimi, GLM, MiniMax, подписки) без хардкода.
Дополнительно: `secrets.store.set`, `models.authStatus`, `models.probe`, `models.list`, `openclaw.setup.*`,
`tools.github.authorize.*`, `plugins.install`. Подтвердить на живом Gateway — `rpc-inventory --wizard`.

**Расхождения с документом архитектуры:**

| В документе | В 2026.8.1 | Что делаем |
| --- | --- | --- |
| `agents.create` принимает skills / sandbox / tools | `agents.create { name, workspace?, model?, emoji?, avatar? }` → `agentId` | skills, sandbox, tools — отдельным `config.patch` в `agents.entries.<id>` |
| `tools: { agentToAgent: { send: ["main"] } }` у агента | в документации `tools.agentToAgent { enabled, allow: [...] }` глобально | проверить `config.schema.lookup tools.agentToAgent` на живом Gateway |
| `config.patch` с объектом | `config.patch { raw, baseHash, replacePaths? }`, JSON merge patch; удаление элементов массивов только через `replacePaths` | `apps/bff/src/gateway/config-patch.ts` |
| методы approvals / pairing / usage / update «семействами» | `exec.approval.*`, `plugin.approval.*`, `approval.*`, `channels.pairing.*`, `usage.status`, `usage.cost`, `sessions.usage`, `update.status/run`, `audit.list` | взять в экраны 12–14 |
| Sandbox через Docker | официальный образ без Docker CLI; нужен сокет Docker в контейнере Gateway | отдельный образ Gateway (`FROM ghcr.io/openclaw/openclaw:2026.8.1` + docker CLI) на шаге sandbox |

**Cron.** `cron.add { name, agentId, schedule: {kind:"cron", expr, tz}, sessionTarget: "isolated", wakeMode, payload: {kind:"agentTurn", message}, delivery }`
→ возвращает `CronJob` с `id`. Доставка в Telegram — `delivery: { mode: "announce", channel, to, threadId }`.

**Чат.** `chat.send { sessionKey: "agent:<id>:main", agentId, message, idempotencyKey }`; ответ приходит событиями
`chat` (`state: delta | final | error | aborted`, `deltaText`, `replace`).

## Как запустить спайк (Windows / Linux)

```bash
# 1. Gateway в Docker (dev: порт 18789 только на 127.0.0.1)
bash deploy/scripts/init.sh --dev

# 2. Проверка подключения и инвентаризация RPC
pnpm --filter @clawdesk/bff rpc-inventory
#    первый раз: pairing_required → одобрить устройство и повторить
docker compose -f deploy/docker-compose.yml exec gateway node dist/index.js devices list
docker compose -f deploy/docker-compose.yml exec gateway node dist/index.js devices approve <requestId>

# 3. Мастер Gateway через RPC (риск №1)
pnpm --filter @clawdesk/bff rpc-inventory --wizard

# 4. Цепочка создания агента
pnpm --filter @clawdesk/bff spike --no-chat     # без модели
pnpm --filter @clawdesk/bff spike               # с подключённой моделью

# 5. Cron после рестарта
pnpm --filter @clawdesk/bff cron-test --create --minutes 3
docker compose -f deploy/docker-compose.yml restart gateway
pnpm --filter @clawdesk/bff cron-test --check <jobId>
```

## Результаты живого запуска

_Заполняется по ходу._
