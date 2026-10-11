# Этап 0 — спайк против живого OpenClaw 2026.8.1

Цель: до рисования экранов проверить, что всё, что панель обещает пользователю, делается через RPC Gateway.
Следующий этап не начинается, пока чек-лист ниже не закрыт.

## Чек-лист

- [x] Поднять `openclaw@2026.8.1` в Docker, онбординг один раз — `deploy/scripts/init.sh --dev`
- [x] Минимальный BFF: `connect` → парование устройства → `deviceToken` сохранён → `agents.list` — `pnpm --filter @clawdesk/bff rpc-inventory`
- [~] Цепочка `agents.create` → `agents.files.set` → `config.patch` → `cron.add` → `chat.send` с откатом — без модели пройдена (`spike --no-chat`), `chat.send` ждёт ключ модели
- [x] Есть ли RPC для логина модели и OAuth плагинов — `rpc-inventory --wizard`, `wizard-walk --more` (модель — да; OAuth плагинов — проверить на этапе «Источники»)
- [x] Cron срабатывает после рестарта Gateway без сообщений — `cron-test --create` / `--check`
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
| Workspace в `~/.openclaw` внутри контейнера | Gateway в контейнере создаёт песочницы-«соседей» через сокет хоста (DooD): пути workspace в конфиге должны быть **абсолютными путями хоста**, а Gateway должен видеть их по тому же пути | для sandbox заменить named volume на bind mount с одинаковым путём, например `/var/lib/clawdesk/openclaw:/var/lib/clawdesk/openclaw`; проверить на шаге sandbox |

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

## Результаты живого запуска (2026-10-11, Windows 11 + Docker Desktop 4.94, образ `ghcr.io/openclaw/openclaw:2026.8.1`)

**Онбординг.** `onboard --non-interactive --auth-choice skip --gateway-auth token --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN`
проходит без модели. Модель по умолчанию после онбординга — `openai/gpt-5.6-sol` (без ключа запуски падают с 401).

**Подключение и парование.** BFF на хосте → Gateway через мост Docker: `PAIRING_REQUIRED` с `requestId`, после
`devices approve` — `hello-ok`, протокол 4, scopes `operator.admin/read/write/approvals/pairing`, device token сохранён,
повторные подключения идут по нему. В заявке видно `client: gateway-client`, `mode: backend`, `role: operator`.

**Инвентаризация.** Gateway объявляет 371 метод и 55 событий. Для экранов 1–14 объявлено всё, кроме
`sessions.usage` (есть в схеме, но не в discovery — проверить вызовом на этапе «Расход»).

**Риск №1 — логин модели через RPC: закрыт.** `wizard.start { flow: "setup" }` → шаги через `wizard.next`:
note «OpenClaw setup» → дисклеймер → confirm риска → телеметрия (select) → режим (QuickStart / Manual / Import) →
**select «Model/auth provider»**: OpenAI, OpenRouter, xAI, Google, Anthropic, «More…» (45 провайдеров, в т.ч.
DeepSeek, Qwen Cloud, Moonshot/Kimi, Z.AI/GLM, MiniMax, Volcano Engine, Qianfan, Tencent, StepFun, Xiaomi,
Ollama, LM Studio, vLLM, Custom OpenAI/Anthropic-совместимый) и «Skip». Все шаги `executor: "client"` — их рисует
панель. Значит экран «Подключить модель» = универсальный рендерер шагов мастера, без своей логики провайдеров.
Осторожно: одновременно открыт только один мастер (`setup is already in progress`), `wizard.status` требует
`sessionId` — BFF должен хранить id своей сессии и отменять её при уходе пользователя.

**Цепочка создания агента — работает** (`spike --no-chat`, ~730 мс):
`agents.create` 243 мс → `agents.files.set` ×3 с проверкой чтения 80 мс → `config.patch` 341 мс → `cron.add` 62 мс.
Откат проверен вживую: при сбое шага файлов агент удалён (`agents.delete`).
- `agents.files.get` возвращает `{ agentId, workspace, file: { name, path, missing, content } }`.
- Workspace нового агента по умолчанию — **внутри workspace главного** (`~/.openclaw/workspace/<id>`). Для «главный
  видит всё» удобно, но для sandbox младшего проверить, что он не видит соседей.
- `agents.create` сам меняет `agents.ownership`, `agents.defaults.systemAgent`, `agents.defaults.heartbeat`
  (видно в логе hot-reload) — BFF не должен перетирать эти ключи.

**`tools.agentToAgent` — глобальный** `{ enabled, allow: [ids] }`, не per-agent `send`. Правило «младший пишет
только главному» придётся собирать из глобального allow + per-agent `tools.allow/deny` — разобрать на этапе
конструктора агентов (`config.schema.lookup agents.entries` → `tools`).

**Риск «cron не стартует без пробуждения сессии» — не подтвердился.** Задача `at` на +3 мин, рестарт Gateway в
14:12:52Z, никаких сообщений → запуск в 14:15:41Z (срок 14:15:39Z). Прогон упал с 401 (модели нет), что и ожидалось:
планировщик проснулся сам. Heartbeat по умолчанию включать не нужно.

**Сеть.** Pull 2 ГБ образа с ghcr.io рвался (`TLS handshake timeout`, `unexpected EOF`) — в `init.sh` добавлены
ретраи и `OPENCLAW_IMAGE=openclaw/openclaw` (официальное зеркало Docker Hub) как запасной путь.
