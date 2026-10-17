# Этап 5: сквозная проверка личного режима и восстановления

Дата: 17 октября 2026. Изменения находятся в рабочем дереве; личная установка не обновлялась.

Этот этап закрывает часть интеграционных ограничений этапа 4. Добавлен повторяемый изолированный сценарий с настоящим Gateway, текущим BFF, реальным HTTP, авторизацией и SQLite. Сценарий создаёт резервную копию штатным `createBackup`, изменяет данные и выполняет полный `restore.sh` с остановкой и запуском собственного compose-проекта.

## Найденная и исправленная ошибка

Настоящий архив OpenClaw 2026.8.1 при длинном пути состояния содержит PAX metadata `mtime`, `path`, `size`. Строгий валидатор восстановления отвергал `size`, поэтому архив, созданный текущим ClawDesk, не проходил предварительную проверку. Ошибка возникала до остановки выбранного экземпляра.

В `restore-safe.mjs` разрешён только обычный неотрицательный десятичный `size` в существующих пределах архива. Он обязан совпадать с размером следующего файлового tar header; переопределения размера нет. Запрет traversal, ссылок, специальных файлов, sparse/неизвестных свойств, цепочек metadata и повреждённых архивов сохранён. Добавлены положительный сценарий и отрицательные проверки формата, диапазона, несовпадения размера и опасных PAX свойств.

Все локальные Docker helpers в `restore.sh` теперь запускаются с `--network none`.

## Что проверяет сквозной сценарий

`deploy/scripts/personal-lifecycle.mjs` сначала собирает shared, templates, BFF и Web. Кэшированные образы предоставляют Linux зависимости; текущие dist, миграции, templates/agents и bridge-модули подключаются из рабочего дерева read-only. Их SHA-256 проверяются внутри контейнеров и после сценария: старый код из образа не подменяет проверяемую сборку.

Последовательность проверки:

1. Новый случайный compose-проект и volumes с собственной меткой. Gateway работает без сети, BFF разделяет его изолированное сетевое пространство. Docker socket и личные volumes не подключаются.
2. HTTP без авторизации получает 401. Затем выполняются настоящая настройка владельца и создание личного пространства.
3. Повтор одинакового создания напоминания и snooze не создаёт дублей; тихие часы сохраняются.
4. Gateway останавливается. BFF продолжает сохранять локальные заметки и читать напоминания; неизвестное состояние связи/поиска не выдаётся за успешное.
5. Gateway запускается, BFF перезапускается. Сохранённые заметки, напоминания и настройки читаются из SQLite, ожидается реальное соединение BFF ↔ Gateway, заметка синхронизируется в USER.md.
6. Штатный `createBackup` создаёт `.tar`. После него изменяются заметки и действия напоминаний, тихие часы, USER.md через синхронизацию, Telegram token отключённого fixture-бота, cron jobs, fake secret, shared file, fixture-модель и три разрешённых env secrets.
7. Полный `restore.sh --yes --target … --target-data …` восстанавливает только этот случайный экземпляр. После запуска проверяются HTTP вход с сохранённым паролем, возврат данных и отсутствие изменений после backup. Дополнительно ожидается `/api/health.gateway.state = connected`.
8. Cleanup проверяет метки перед удалением только собственного проекта/volumes. Временный каталог также удаляется.

Проверка восстановления читает содержимое данных и HTTP ответы после намеренных изменений, а не только наличие архива или неизменённых файлов. Telegram остаётся отключённым; отключённое cron-задание не выполняется.

## Результаты независимой проверки

После авторского успешного прогона отдельный verifier повторил финальную версию без изменений исходников во время сценария.

| Проверка | Результат |
| --- | --- |
| Полный `personal-lifecycle.mjs`, текущая сборка + настоящий Gateway + HTTP + SQLite + полный restore shell | **Прошёл**, exit 0 |
| Gateway восстановил соединение с BFF после полного restore | **Подтверждено** |
| Linux deploy `node --test *.test.mjs` | **122 теста: 121 прошёл, 1 пропущен, 0 ошибок** |
| Отдельный `restore-safe.test.mjs` с `CLAWDESK_RECOVERY_FIXTURE=1` и настоящим SDK | **26/26 прошли**, без пропусков |
| Остаточные контейнеры/volumes по метке независимого fixture | **Нет** |
| Временный каталог независимого fixture | **Удалён** |
| Четыре исходных контейнера local/verify: полные ID и StartedAt до/после | **Совпадают с baseline** |
| `git diff --check` | **Прошёл**, только прежние предупреждения CRLF |

Пропуск общего Linux gate — opt-in SDK roundtrip, поскольку обычный Node image не содержит OpenClaw. Отдельный прогон в cached Gateway image выполнил его успешно. Полные 333 BFF unit tests уже прошли на этапе 4; здесь production BFF не менялся, поэтому они повторно не запускались. Сквозной сценарий заново собирает BFF и проверяет реальные endpoint.

Независимый run ID: `clawdesk-lifecycle-fd9071af1021442aa440f53af13ce83d`. Его финальный результат: `realHttpAuthPersonalIdempotency`, `gatewayOfflineAndProcessRestart`, `nativeGatewayConnected`, `restoredGatewayConnected`, `environmentSecretsRestored`, `realBackupFullRestoreShellAndApi`, `fixtureRemoved` — все `true`.

Использованные cached image IDs:

- Gateway: `sha256:1733c0d46d867f4aa51f4997836db28b6b34f2c7def3d2b1737590ddfecb59d8`.
- Panel: `sha256:b387ecd1adc8a1d041b6edcbd000e07dc62c357eb5abd9b477c1f6f42b27c0d2`.

Проверенные tree SHA-256 текущих артефактов:

| Каталог | SHA-256 |
| --- | --- |
| `apps/bff/dist` | `ae89de62bc784407f92aa48ff0e9e48427799d84e3754f8fe4e5eac7cfde8836` |
| `apps/bff/drizzle` | `97cdcb6c49909d827bb84c14d62cf3fa581618ed0ba3c7ccf1f0c799c851076b` |
| `apps/web/dist` | `8e061d4d1a881fddfc7b3ed8517c7caa8bd7ad067be4d9866a83e270b5f46a80` |
| `packages/shared/dist` | `b36af9c2f37e98ab6c8b3e689488b924b933d6a56fc905836514505a5f5f3c8a` |
| `packages/templates/dist` | `aa4c1d59b28dd21724c414d550f66d3262026bca8d625e2c535a5a8450d15024` |
| `packages/templates/agents` | `12eb78268e9421248c326fdf84eb3fd3b326663d64d844391d02b2159f051496` |
| `deploy/scripts` | `3f1cbd3f411b1ecae4ee2625608e8a8f2dd4961f5760041253c7d4a193fd3931` |

Gateway start SHA-256: `5609d1f0c9314fad9d8eb94236f0da0bd2a7c0c3b3b8c10ad71c6993de7c52e9`. Все подключённые bridge-модули также сравнивались по SHA-256 внутри Gateway, включая `clawdesk-backup.mjs`: `de3531d8039a6c1a9cecda76cc446ba5374f112884a1b4c3f1a6c29579abbe7b`.

## Повторение проверки

Из корня репозитория, при наличии установленных зависимостей и указанных cached images:

```powershell
node deploy/scripts/personal-lifecycle.mjs

docker run --rm --network none --read-only --tmpfs /tmp:rw,noexec,nosuid,size=768m --mount type=bind,source=E:/my_project/clawdesk/deploy,target=/work,readonly --workdir /work node:22-alpine sh -c 'node --test *.test.mjs'

docker run --rm --network none --entrypoint node -e CLAWDESK_RECOVERY_FIXTURE=1 --mount type=bind,source=E:/my_project/clawdesk/deploy/scripts,target=/fixture,readonly ghcr.io/khusravkhon/clawdesk-gateway:local --test /fixture/restore-safe.test.mjs
```

Сценарий требует Docker и Git Bash на Windows. Он не строит и не скачивает Docker images. На время проверки нельзя изменять проверяемые исходники и каталоги сборки: изменение hash завершает gate ошибкой. Сценарий восстановления намеренно заменяет данные, но только созданного им fixture. Его не следует переписывать для использования личного проекта или личных volumes.

## Практические границы

- Полный shell/compose restore выполнен для `.tar`, а не для зашифрованного `.tar.enc` экспорта.
- Это настоящие HTTP/BFF/Gateway/SQLite и production restore shell в изоляции. Установленный desktop binary и его настоящий Tauri вызов в этом этапе не проверялись.
- Fake GGUF доказывает возврат файла модели, а не embeddings inference, качество поиска или скачивание модели. Реальных модельных запросов не было.
- Telegram-конфигурация проверена как данные отключённого fixture-бота. Сообщения не отправлялись, внешние OAuth/AI/Telegram подключения не проверялись. При отключённом канале Today вправе показывать неизвестное состояние; это не заменялось искусственным успехом.
- Сеть fixture отключена средствами Docker; это не проверка обрыва внешнего Wi-Fi у установленного desktop-приложения.
- Нет гарантии атомарности нескольких volumes при выключении питания. Ранее реализованные rollback и отказ запуска смешанного состояния сохраняются.
- Личная и проверочная установки не обновлялись и не использовались как fixture. Commit, push, deploy, сборка installer/release и очистка пользовательских данных не выполнялись.
