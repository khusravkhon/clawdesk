# Этап 0 — спайк против живого OpenClaw 2026.8.1

Цель: до рисования экранов проверить, что всё, что панель обещает пользователю, делается через RPC Gateway.
Следующий этап не начинается, пока чек-лист ниже не закрыт.

## Чек-лист

- [x] Поднять `openclaw@2026.8.1` в Docker, онбординг один раз — `deploy/scripts/init.sh --dev`
- [x] Минимальный BFF: `connect` → парование устройства → `deviceToken` сохранён → `agents.list` — `pnpm --filter @clawdesk/bff rpc-inventory`
- [~] Цепочка `agents.create` → `agents.files.set` → `config.patch` → `cron.add` → `chat.send` с откатом — без модели пройдена (`spike --no-chat`), `chat.send` ждёт ключ модели
- [x] Есть ли RPC для логина модели и OAuth плагинов — `rpc-inventory --wizard`, `wizard-walk --more` (модель — да; OAuth плагинов — проверить на этапе «Источники»)
- [x] Cron срабатывает после рестарта Gateway без сообщений — `cron-test --create` / `--check`
- [x] Агент с sandbox видит и пишет только свою папку, чужую — нет (доп. папки-источники через `docker.binds` — на экране «Источники»)

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
- **Проверено вживую (2026-10-12):** первый ответ Gemini — поток `status → delta → final`, ~37 с (запрос ≈10 тыс. токенов).
  События `chat`: `status` с `phase` (`preparing_workspace|preparing_context|starting_model`), затем `delta`. Инструменты —
  события `agent` со `stream: "tool"`. **Если все модели упали до ответа, закрывающего события `chat` нет** — панель
  сверяется с `chat.history` (`inFlightRun`) раз в 4 с. В истории вместо причины — заглушка
  `The agent run failed before producing a reply.` (`stopReason: error`); причина есть только в событии `error`.
- История: `chat.history { sessionKey, agentId, limit }` → `messages` (`role: user|assistant|toolResult`, `content` —
  строка или части `text|thinking|toolCall`, `stopReason: stop|toolUse|error|aborted`), `inFlightRun`.
- **Gemini 3 Flash + 2026.8.1:** если первого ответа нет 45 с, OpenClaw повторяет запрос с thinking `MINIMAL`, а
  `gemini-3.7-flash` его не поддерживает (`400`) → ход падает. Лечится `OPENCLAW_GOOGLE_GEMINI_FIRST_RESPONSE_RETRY_MS=0`
  (в compose). Бесплатный Flash часто `503 high demand` и быстро `429 quota` → запасные модели
  `agents.entries.main.model { primary, fallbacks }` (сужение массива — `replacePaths`); `gemini-flash-latest` /
  `gemini-flash-lite-latest` — псевдонимы Google. `models.list { view: "all" }` — весь каталог OpenClaw.
- Главный агент выполнял `exec` в контейнере Gateway **без одобрения** (`security: full, ask: off` по умолчанию).
  **Одобрения (сделано 2026-10-12):** действует более строгая из `tools.exec.*` и документа хоста
  (`exec.approvals.get/set`, `agents.main { security: allowlist, ask: on-miss, askFallback: deny }` — панель ставит
  один раз при старте). Очередь: `exec.approval.list` / `plugin.approval.list` (`approval.list` в 2026.8.1 нет),
  решение `exec.approval.resolve { id, decision: allow-once|allow-always|deny }`, журнал `approval.history`, события
  `exec.approval.requested|resolved`. **Клиент должен объявить `caps: ["approvals", "exec-approvals"]`**, иначе
  получателя нет и запрос сразу отклоняется (`terminalReason: no-route`). `caps: ["tool-events"]` — события
  инструментов в `agent`. Проверка без модели: `pnpm --filter @clawdesk/bff approval-probe --wait`.
- Память главного (`memory-core`) ищет ключ OpenAI для эмбеддингов (`sync failed … provider "openai"`) — настроить
  на провайдера пользователя.

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

**Подключение модели к конкретному агенту (главному и каждому младшему) — работает через RPC.**
Продуктовое правило: ключи только через интерфейс — первое окно подключает ИИ главному агенту, конструктор
младшего агента подключает ИИ этому агенту (свой ключ / подписка, либо «как у главного»).
- `openclaw.setup.detect { agentId }` (~4 с, read-only): `candidates` (уже готовые), `manualProviders` — способы
  по ключу для **установленных** провайдер-плагинов (`openai-api-key`, `apiKey`/`setup-token` Anthropic,
  `gemini-api-key`, `minimax-*`…, с `groupLabel`, `hint`, иконкой и сайтом), `authOptions` — вход по подписке
  (`oauth` / `device-code`: ChatGPT, OpenRouter, xAI, Copilot, MiniMax), `prepareOptions` — локальные (LM Studio, Ollama).
- `openclaw.setup.activate { agentId, kind: "api-key", authChoice, apiKey }` **сначала проверяет ключ живым запросом
  к провайдеру и только потом сохраняет**: с неверным ключом — `{ ok: false, status: "auth" }`, у агента не появилось
  ни профиля, ни модели, главный не затронут. Gateway сам маскирует ключ в ошибке (`****0000`).
- Ключ агента хранится в его собственном хранилище (`agents/<id>/agent/openclaw-agent.sqlite`). Агент без своего
  профиля читает общий (read-through) — это и есть вариант «использовать доступ главного».
- **DeepSeek, Qwen, Kimi/Moonshot, GLM (zai), Volcengine, Qianfan, Tencent, StepFun, Xiaomi — отдельные
  официальные плагины, по умолчанию не установлены** (`activate` → `That key-based provider is not available`).
  Встроены: anthropic, openai, xai, minimax, ollama и др.
- `plugins.install { source: "official", pluginId }` ставит **последнюю** версию → `incompatible_plugin_api`
  (нужен 2026.10.1). Рабочий путь: `{ source: "clawhub", packageName: "@openclaw/<id>-provider", version: "2026.8.1" }`
  → ответ `PLUGIN_CAPABILITY_CONSENT_REQUIRED` с `reviewToken` → повтор с `acknowledgeCapabilities: { reviewToken }`
  → установлено, `restartRequired: true` → `gateway.restart.request` → переподключение ~3 с → провайдер появляется в
  `detect` (`deepseek-api-key`). **Версия плагина всегда = версия OpenClaw.**
- Скрипты: `setup-probe`, `activate-probe`, `plugins-probe`, `provider-install-probe` (только фальшивые ключи).

**Вход по подписке (без ключа) — работает через RPC.** `openclaw.setup.auth.start { sessionId (наш uuid), agentId,
authChoice }` → шаги забираются `wizard.next { sessionId, answer? }`:
- device code (`openai-device-code`, `github-copilot`, `xai-oauth`, `minimax-*-oauth`): progress → note с
  `deviceCode.code`, `externalUrl`, сроком 15 мин и предупреждением о фишинге → progress «Waiting for device
  authorization…» — **`wizard.next` висит, пока человек не подтвердит** (нужен запрос без таймаута);
- OAuth в браузере (`openai` = ChatGPT Login): note «remote/VPS» → URL входа с `redirect_uri=http://localhost:1455/...`
  → text «Paste the authorization code (or full redirect URL)». Gateway в Docker колбэк не получит, поэтому
  человек вставляет адрес из адресной строки.
- BFF держит «водителя» сессии (`SignInSessionManager`): сам подтверждает progress/note, браузер опрашивает
  состояние и отвечает только на text/confirm/select.

**Конструктор младших агентов — работает** (создание через UI проверено вживую):
- `agents.create` принимает только ASCII-имя (`"Диетолог"` → `no valid id characters`): создаём со slug
  (id шаблона, `-2`, `-3`… при совпадении), затем `agents.update { name: "Диетолог" }`.
- Новый агент наследует модель по умолчанию; «как у главного» = копия `model.primary` главного, «свой доступ» =
  после создания тот же экран подключения ИИ с `agentId` нового агента.
- Связь агентов: `tools.agentToAgent.allow` — **глобальный список целей**, разрешить «младший → только главный» по
  источнику нельзя. Делаем: `canAskMain` → добавляем `main` и агента в `allow`; без права — у агента
  `tools.deny: [agent_to_agent, sessions_send, sessions_spawn, conversations_send, conversations_turn]`.
  Общение младших между собой пока ограничено только инструкцией в `AGENTS.md`.
- У каждого агента OpenClaw держит **системные cron-задачи** (`skill-collection-review-<id>`), удалить их
  клиентом нельзя (`system-owned monitor jobs cannot be removed`) — при удалении агента убираем только свои
  задачи, системные уходят вместе с `agents.delete`. Сужение массива `allow` — только с `replacePaths`.
- Sandbox к агентам применяется только при `CLAWDESK_SANDBOX=on` (после настройки образа Gateway с Docker);
  до этого интерфейс прямо предупреждает, что младшие работают без изоляции.

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

**Sandbox — подготовка (проверка ждёт модель).**
- Файловые и exec-инструменты (`read`, `write`, `exec`…) есть в `tools.effective`, но `tools.invoke` отвечает
  `Tool not available: read`: они работают только внутри хода агента. Поэтому «агент читает свою папку, а чужую нет»
  проверяется только с подключённой моделью.
- В официальном образе нет Docker CLI → нужен свой образ Gateway: `FROM ghcr.io/openclaw/openclaw:2026.8.1` +
  `COPY --from=docker:cli /usr/local/bin/docker`.
- Docker Desktop: сокет внутри контейнера `root:root 660` → `group_add: ["0"]`; на Linux — GID группы docker.
  `init.sh` будет определять GID пробным контейнером.
- Bind-пути внутри VM Docker Desktop (`/var/lib/...`) работают, создаются от root → нужен `chown 1000:1000`.
- Песочница для образа `openclaw-sandbox:bookworm-slim` собирается из `debian:bookworm-slim` (Dockerfile в доке
  sandboxing), OpenClaw не подставляет образ сам.
- Безопасность: сокет Docker в контейнере Gateway = права root на хосте у Gateway. Это штатный путь OpenClaw
  (`OPENCLAW_SANDBOX=1` в их `setup.sh`), но в документации установки об этом надо сказать прямо.

**Песочница — включена и проверена вживую.**
- Свой образ Gateway: `deploy/gateway.Dockerfile` = `ghcr.io/openclaw/openclaw:2026.8.1` + Docker CLI из `docker:29-cli`;
  сокет хоста смонтирован в Gateway, `group_add: DOCKER_GID` (на Docker Desktop это 0, `init.sh` определяет сам).
- Состояние OpenClaw перенесено из named volume в `/var/lib/clawdesk/openclaw`, смонтировано **по тому же пути**
  в Gateway (требование DooD: пути workspace в конфиге должны резолвиться и в Gateway, и в демоне Docker).
- Образ песочницы `openclaw-sandbox:bookworm-slim` собирается из `deploy/sandbox.Dockerfile` (uid 1000 = node).
- Панель при `CLAWDESK_SANDBOX=on` пишет младшему `sandbox: { mode: "all", scope: "agent", workspaceAccess: "rw" }`.
- `openclaw sandbox explain --agent dietitian`: `runtime: sandboxed`, смонтирован только
  `/var/lib/clawdesk/openclaw/workspace/dietitian -> /workspace rw`.
- Контейнер создаётся при первом же ходе агента (даже до вызова модели). Изнутри: пользователь `sandbox`,
  видна и доступна на запись только своя папка, папок главного/других агентов нет, сокета Docker нет,
  `NetworkMode=none`, корень read-only, `CapDrop=ALL`, не privileged.
- Безопасность: сокет Docker у Gateway = права root на хосте. Это штатный путь OpenClaw; песочницам сокет не даётся.
- Docker Desktop (Windows/macOS): `/var/lib/clawdesk` живёт внутри VM Docker Desktop — сброс Docker Desktop
  к заводским настройкам удалит данные. На сервере Linux это обычная папка хоста (её и бэкапим).

**Telegram (экран 6, v1) — сделан, проверено без настоящего бота.**
- Токен проверяется у Telegram (`getMe`) прямо из BFF, затем `secrets.store.set { kind: "secret", allowedHosts:
  ["api.telegram.org"] }` — защищённый, только на запись. В конфиге лишь ссылка
  `botToken: { source: "store", provider: "default", id: "CLAWDESK_TELEGRAM_BOT_TOKEN" }`.
- `channels.telegram = { enabled, botToken, dmPolicy: "pairing", groupPolicy: "disabled" }` и маршрут
  `bindings: [{ agentId: "main", match: { channel: "telegram" } }]` (при `agents.ownership: "explicit"` без маршрута
  канал никому не принадлежит).
- Плагин `telegram` встроен, но выключен; `plugins.setEnabled` включает без согласия на права и без рестарта.
- Владелец: `channels.pairing.list/approve { channel: "telegram", notify: true, bootstrapCommandOwner: true }`;
  до настройки бота `channels.pairing.list` отвечает `unknown pairing channel: telegram`.
- После подтверждения владельца все расписания панели получают `delivery: { mode: "announce", channel: "telegram",
  to: <ownerId>, bestEffort: true }`; новые агенты — по галочке в конструкторе. Тест — RPC `send`.
- Не проверено вживую (нужен настоящий бот): применение конфига канала, приход заявки на парование, доставка.
- Следующий шаг: группа с темами — тема на агента (`channels.telegram.groups.<chat>.topics.<topic>.agentId`).

**Бесплатные модели (FreeLLMAPI) — только для младших агентов в личном режиме.**
- Сервис `ghcr.io/tashfeenahmed/freellmapi:v0.13.7` (закреплён) живёт в сетевом namespace Gateway и слушает только
  loopback. Пользователь ничего не ставит: приложения FreeLLMAPI для телефона/ПК не нужны, агенты работают на сервере.
- Панель сама создаёт единственную учётку FreeLLMAPI (`POST /api/auth/setup`, со случайным паролем в
  `data/freellmapi/account.json` 0600; с loopback код настройки не нужен), добавляет ключи (`POST /api/keys`),
  берёт общий ключ (`GET /api/settings/api-key`) → защищённый секрет Gateway → `models.providers.freellmapi`
  (`baseUrl http://127.0.0.1:3001/v1`, `api: openai-completions`, модель `auto`). Агент получает `freellmapi/auto`.
- Проверено вживую: агент → OpenClaw → FreeLLMAPI → Groq (фальшивый ключ → 401, ключ помечен невалидным).
- **Ограничение:** запрос агента OpenClaw ≈10 тыс. токенов (инструкции + инструменты); бесплатные модели с лимитом
  8 тыс. токенов/мин FreeLLMAPI пропускает. Нужны провайдеры с запасом (Google AI Studio, Cerebras, Mistral).
- Не показывается для главного агента (первое окно) и для шаблонов режима «Проекты компании»; BFF это проверяет.

**Google (Gemini) на бесплатном ключе.** `openclaw.setup.activate` проверяет ключ **всегда** на модели провайдера
по умолчанию (`google/gemini-3.1-pro-preview`), `modelRef` и заранее заданная модель агента игнорируются. У Pro на
бесплатном тарифе квота 0 → 429 `RESOURCE_EXHAUSTED`, хотя ключ рабочий. Решение (главный агент): по списку моделей
Google для этого ключа выбираем Flash, сохраняем ключ+модель через мастер `setup` (он пишет оба на шаге модели —
даже если потом падает), отменяем мастер и проверяем `openclaw.setup.verify` (он пробует **настроенную** модель).
Ключ в `models.providers.google.apiKey` OpenClaw не использует — нужен профиль в хранилище агента.

**Опасно: удаление агента + рестарт.** `agents.delete` дочищает асинхронно; пока не дочистил, id занят
(`deletion cleanup is still pending`), а **рестарт Gateway в этот момент валит запуск**
(`agent database is unavailable while agent <id> is deleted`, `doctor --fix` не лечит). Ручной выход: перенести
`agents/<id>` и `workspace/<id>` из каталога состояния. Панель: при занятом id берёт следующий (`-2`); не
перезапускать Gateway сразу после удаления агентов (TODO: ждать завершения очистки перед установкой плагинов).
- **Первопричина (найдена 2026-10-12):** песочница монтирует навыки *внутрь* workspace
  (`…/skills-workspaces/<x>/…/skills → /workspace/.openclaw/sandbox-skills/skills:ro`). Точки монтирования нет —
  демон Docker создаёт `workspace/<id>/.openclaw/sandbox-skills/skills` **от root**; Gateway (`node`) потом не может
  удалить workspace, очистка обрывается, `agents/<id>` остаётся, и следующий старт падает. Случай: `dietitian`
  (папки перенесены в `tmp/clawdesk-recovered/`).
- **Исправление:** в образе Gateway `docker` — обёртка `deploy/docker-mountpoints.sh`: перед `create|run` создаёт
  вложенные точки монтирования внутри rw-биндов от `node`, настоящий CLI — `/usr/local/libexec/docker`.
  Проверено на временных папках; полный цикл «песочница → удаление → рестарт» проверить на этапе чата.
- `agents.delete` отвечает `{ removed, failed: [{ path, reason }], purgeFailed }` — BFF пишет предупреждение в лог.
- Контейнеры песочниц удалённых агентов (`openclaw-sbx-workspace-*`) остаются в `docker ps -a`.

**Источники данных.**
- **Notion:** официальный плагин `@openclaw/notion` 1.0.1 (ClawHub, семейство `bundle-plugin`) — обёртка над
  MCP Notion `https://mcp.notion.com/mcp`, `auth: "oauth"`, streamable-http. Ставится
  `plugins.install { source: "clawhub", packageName, version: "1.0.1" }` + согласие `reviewToken` + рестарт;
  сервер появляется как `mcp.servers.notion`. Вход: `openclaw mcp login notion` печатает URL авторизации,
  ждёт возврат на `redirectUrl` (по умолчанию `http://127.0.0.1:8989/oauth/callback`, задаётся в конфиге сервера),
  либо `openclaw mcp login notion --code <code>`. RPC для входа нет — BFF зовёт CLI в контейнере Gateway.
  Пока не вошли, `doctor --lint` ругается: `MCP server "notion" requires OAuth authorization`.
- **Сделано (2026-10-12):** `mcp login` видит только серверы из `mcp.servers` в конфиге (сервер плагина — нет),
  поэтому панель пишет `mcp.servers.notion { url, transport: streamable-http, auth: oauth, oauth.redirectUrl }`
  сама, плагин не нужен (удалён). Notion регистрирует клиент сам (DCR), `redirect_uri` = панель
  `…/api/sources/notion/callback`. Статус входа: `mcp status --json -v` → `authStatus.hasTokens`.
- **ClawDesk bridge** (`deploy/clawdesk-bridge.mjs`, стартует из `gateway-start.sh` рядом с Gateway): HTTP на
  `127.0.0.1:18790` в namespace Gateway (панель там же; dev — проброс на loopback хоста), нужен токен Gateway,
  только `mcp status / login start / login --code / logout`, аргументы — массивом без shell. `login start`
  останавливается, как только CLI напечатал URL (ожидание его loopback-колбэка не нужно — код приходит в панель).
  Панель принимает только тот `state`, который выдала сама.
- **Notion ключом интеграции** (второй путь): `GET api.notion.com/v1/users/me` проверяет ключ → секрет
  `clawdesk.notion.token` → `skills.entries.notion { enabled, apiKey: SecretRef }` (встроенный навык `notion`).
- **Папка:** `CLAWDESK_FILES_DIR` (init.sh: `~/ClawDesk`) монтируется в Gateway как `workspace/files` главного
  агента и в панель только на чтение (`/files`) — для списка файлов. Младшие в песочнице её не видят.
- **Google:** плагинов OpenClaw нет; навык `gog` (нужен бинарь `gog` + `client_secret.json`), плагины сообщества и
  официальный Workspace MCP Google (`gmailmcp|drivemcp|docsmcp….googleapis.com/mcp/v1`, developer preview с 05.2026)
  — все требуют свой OAuth-клиент Google Cloud, автоматической регистрации нет. Решение: пошаговый мастер.
- **Сделано (2026-10-12): мастер Google через `gog`** (`openclaw/gogcli` v0.42.0, в образе Gateway через
  `ADD --checksum`; в архиве файл не под именем `gog` — распаковывать в папку). Окружение: `GOG_HOME` в каталоге
  состояния, `GOG_KEYRING_BACKEND=file`, `GOG_KEYRING_PASSWORD` (init.sh). Клиент — тип **Desktop app**:
  `gog auth credentials set -` (JSON через stdin). Вход: `gog auth add <email> --services … --remote --step 1 --json`
  → `auth_url`; `--step 2 --auth-url <адрес возврата>` с теми же флагами. `--redirect-uri` переопределяет возврат —
  панель на localhost ставит свой `/api/sources/google/callback`, иначе человек вставляет адрес. `--readonly` —
  только чтение (по умолчанию). Навык: `skills.entries.gog { enabled, env: { GOG_ACCOUNT } }`.
  Не проверено с настоящим проектом Google (принимает ли Google путь в loopback-адресе Desktop-клиента).

**Сеть.** Pull 2 ГБ образа с ghcr.io рвался (`TLS handshake timeout`, `unexpected EOF`) — в `init.sh` добавлены
ретраи и `OPENCLAW_IMAGE=openclaw/openclaw` (официальное зеркало Docker Hub) как запасной путь.
