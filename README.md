# Lakonik

iOS-приложение: запись встречи на телефон → транскрибация с разделением спикеров (ElevenLabs Scribe v2) → протокол/контакт-репорт по шаблону типа встречи (Claude) → задачи, экспорт, шаринг. Выросло из внутреннего приложения ADV Kazakhstan («ADV Meetings»); план превращения в публичный продукт — `docs/lakonik-1.0.md`.

Аудио живёт на сервере только на время обработки и удаляется сразу после расшифровки. Хранятся транскрипт, отчёт и задачи.

## Что умеет

**Запись.** Одно нажатие — запись пошла: тип встречи (внутренняя / с клиентом / с вендором → 12 подтипов по маршрутизатору контакт-репортов ADV) и контекст можно выбрать прямо во время записи или уже после расшифровки. Запись в фоне и при заблокированном экране (сегменты по 5 минут, AAC 16 кГц), Live Activity с кнопками пауза/стоп на экране блокировки и в Dynamic Island, отметки важных моментов, обработка звонков, фоновая загрузка сегментов, восстановление после сбоя, импорт готовых аудио/видео файлов. Экран записи: лента-волна, реагирующая на голос, прокручиваемая осциллограмма с линейкой времени и отметками, таймер с сотыми — всё по единым часам записи (медиа-время без пауз, окна уровня по 50 мс прямо с аудиопотока).

**После расшифровки — проверка спикеров.** ИИ (быстрая модель) оценивает, сколько людей говорило на самом деле, предлагает имена, должности и сторону (коллега / клиент / вендор) только по тому, что прозвучало, и находит дубли автоматического разделения говорящих. Пользователь подтверждает или правит, объединяет дубли (реплики переходят к основному спикеру), отмечает «Это я», затем выбирает тип встречи — и отчёт строится с подтверждёнными именами. Если тип был выбран во время записи, отчёт строится сразу, подсказки по спикерам всё равно сохраняются. Запись и транскрипт живут отдельно от отчёта: его можно не строить вовсе.

**Онлайн-встречи (Google Meet, Zoom, Teams).** Запись через системную трансляцию экрана: расширение ReplayKit получает звук приложения встречи (участники) и микрофон (ваш голос, в том числе через AirPods), пишет два трека в контейнер App Group, приложение сводит их в один файл и отправляет как импорт. Экран не сохраняется — только звук. Обычные звонки и FaceTime так записать нельзя (iOS не отдаёт их звук). Требует зарегистрированного App Group `group.kz.adv.meetings` (см. «Релиз»).

**Отчёт.** Структура и правила из шаблона ADV, разделы, action plan с ответственными и сроками, решения, открытые вопросы, блок «не озвучено, уточнить», внутренние блоки «не для клиента». Ручное редактирование текста перед экспортом. ИИ-правка по текстовым инструкциям («Спикер 2 — это Данияр», «убери пункт про наружку») с подсказками из контекста записи и историей версий. Пересборка по другому шаблону, быстрый черновик на Sonnet. Экспорт DOCX / PDF / Markdown / TXT через share sheet.

**Транскрипт.** Быстрый фильтр по спикерам, «Это я» (имя владельца аккаунта), роли коллега / клиент / вендор с отдельной нумерацией «Клиент 1, Клиент 2», имя вручную, из аккаунтов холдинга или из справочника ответственных.

**Задачи.** Отдельная вкладка со всеми action items по всем встречам: группы по срокам, фильтры, поиск, чек-лист, редактор (текст, ответственный, срок), ручные задачи, push-напоминания о дедлайнах. Общий справочник ответственных холдинга: автоматически из отчётов, вручную или из аккаунтов; доступен со всех устройств.

**Настройки сроков** (общие для холдинга): срок по умолчанию для задач без дедлайна (по рабочим дням), напоминания, SLA отправки отчёта после встречи (внутренние 24 ч, внешние 48 ч).

**Доступ.** Вход по одноразовому коду на почту или через Sign in with Apple, allowlist корпоративных доменов, шаринг встречи с коллегой из аккаунтов холдинга (отчёт или отчёт + транскрипт). Содержимое встречи (транскрипт, отчёт, задачи) видят только владелец и те, с кем ею явно поделились; роли agency_admin / holding_admin неявного доступа к чужим встречам не дают. Получатель шаринга может отмечать задачи выполненными. Конфиденциальные встречи (HR, совещания руководства).

Состояние проекта и ссылки на все документы — `docs/HANDOFF.md`. Корпоративный контур (сервер заказчика,
вход по коду организации) — `docs/self-hosted.md` и комплект развёртывания в `deploy/`.

## Структура

```
apps/server/      Node 22 + TypeScript: API (Hono, Better Auth, Drizzle) и воркер пайплайна (pg-boss, ffmpeg)
apps/ios/         iOS-приложение (Swift, SwiftUI, iOS 17+), проект генерируется xcodegen
packages/shared/  templates.json — 12 курируемых шаблонов контакт-репортов ADV
infra/            docker-compose (Postgres + MinIO) для локальной разработки
docs/             PLAN.md — план и статус проекта
scripts/          extract-templates.ts — извлечение сырых шаблонов из Excel заказчика
```

Исходные Excel-документы заказчика (`docs/source/`) и их сырой дамп в репозиторий не входят.

## Архитектура

```
iPhone ──segments (presigned PUT)──▶ Railway Bucket (временное аудио)
   │                                        │
   └──POST /finalize──▶ API (Hono) ──job──▶ Worker: ffmpeg concat → ElevenLabs Scribe v2
                          │                          → удаление аудио → Claude (structured output)
                          │                          → отчёт + задачи → APNs push
                          └──SSE /events──▶ iPhone (статус обработки)
```

- **STT**: ElevenLabs Scribe v2, диаризация, keyterms из контекста встречи и справочника агентства. Провайдер за интерфейсом `SttProvider` (второй адаптер можно добавить без изменений пайплайна).
- **Пайплайн**: merge → STT → удаление аудио → анализ спикеров (Sonnet, structured output: число людей, имена/роли/сторона, дубли диаризации) → если тип встречи выбран — отчёт, иначе статус `transcribed` и push «Расшифровка готова».
- **LLM**: Claude (`claude-opus-5`, черновики на `claude-sonnet-5`), structured outputs по zod-схеме отчёта, кеширование системного промпта, дедлайны датами, роли спикеров и владелец записи в промпте, режим правки с предыдущей версией отчёта.
- **Очередь**: pg-boss поверх Postgres; ретраи, dead-letter, cron (подчистка аудио старше 48 ч, перепостановка зависших встреч, напоминания о дедлайнах).
- **Auth**: Better Auth (email OTP, Sign in with Apple по ID-токену, bearer-токены для мобильного клиента).

## Локальный запуск сервера

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d        # Postgres :5439, MinIO :9000/:9001
cp apps/server/.env.example apps/server/.env             # заполнить ключи (или FAKE_PROVIDERS=true)
pnpm --filter @lakonik/server dev:bucket                     # bucket audio-temp в MinIO
pnpm db:migrate && pnpm db:seed                          # схема + 12 шаблонов + 8 агентств
pnpm dev                                                 # API на :3000
pnpm worker                                              # воркер пайплайна
```

Проверка: `curl localhost:3000/health`, OpenAPI — `localhost:3000/api/openapi.json`. Без `RESEND_API_KEY` коды входа печатаются в лог API. `FAKE_PROVIDERS=true` подменяет ElevenLabs и Anthropic заглушками — пайплайн проходит целиком без ключей. С локальным MinIO аудио отправляется в ElevenLabs байтами (`STT_UPLOAD_MODE=auto`), в проде — по presigned-ссылке.

Демо-данные для показа и скриншотов (вымышленные агентство, клиент и сотрудники; бриф с эталонным транскриптом на 4 спикера, отчётом и задачами; вход под `asel.nurlanova@orbita.kz` по коду из лога API):

```bash
pnpm --filter @lakonik/server exec tsx --env-file=.env scripts/seed-showcase.ts
```

Сквозной прогон на реальном аудио без телефона:

```bash
pnpm --filter @lakonik/server e2e:pipeline -- путь/к/записи.m4a client_brief auto 4
```

Проверка только LLM-шага на тестовом транскрипте:

```bash
pnpm --filter @lakonik/server exec tsx --env-file=.env scripts/e2e-summarize.ts client_brief high
```

## iOS-приложение

```bash
cd apps/ios && xcodegen generate      # Lakonik.xcodeproj не хранится в git
open Lakonik.xcodeproj
```

Debug-сборка ходит на `http://localhost:3000` (симулятор видит localhost Mac), Release — на Railway (`API_BASE_URL` в `project.yml`). URL можно переопределить в Настройках приложения. Bundle ID `kz.adv.meetings`, iOS 17+. Запись в симуляторе требует доступа Simulator к микрофону macOS; фоновая запись при блокировке, звонки, push и Live Activity проверяются на реальном устройстве.

Сборка на устройство без входа в Xcode-аккаунт (подписание через App Store Connect API key):

```bash
xcodebuild -project Lakonik.xcodeproj -scheme Lakonik -configuration Debug \
  -destination "platform=iOS,id=<UDID>" -allowProvisioningUpdates \
  -authenticationKeyPath <AuthKey.p8> -authenticationKeyID <KEY_ID> -authenticationKeyIssuerID <ISSUER_ID> \
  API_BASE_URL=https://<api-domain> build
```

Строки интерфейса — в String Catalog `Lakonik/Resources/Localizable.xcstrings` (базовый язык ru; `SWIFT_EMIT_LOC_STRINGS`). Xcode обновляет каталог сам при сборке, xcodebuild — нет: после сборки в `/tmp/adv-sim` выполните `apps/ios/scripts/sync-strings.sh /tmp/adv-sim`. Новые строки в коде вне SwiftUI-литералов — через `String(localized:)`. Sentry (`sentry-cocoa`) запускается только при непустом `SENTRY_DSN` в настройках сборки.

## Релиз в TestFlight

Приложение в App Store Connect: **Lakonik** (ранее ADV Meetings, ID 6812003830, bundle `kz.adv.meetings` не меняется), внутренняя группа **ADV Internal** с доступом ко всем сборкам. Номер билда = число коммитов.

```bash
cd apps/ios && xcodegen generate
BUILD=$(git rev-list --count HEAD)
xcodebuild -project Lakonik.xcodeproj -scheme Lakonik -configuration Release \
  -destination "generic/platform=iOS" -archivePath /tmp/adv-archive/Lakonik.xcarchive \
  -allowProvisioningUpdates -authenticationKeyPath <AuthKey.p8> -authenticationKeyID <KEY_ID> -authenticationKeyIssuerID <ISSUER_ID> \
  CURRENT_PROJECT_VERSION=$BUILD archive
xcodebuild -exportArchive -archivePath /tmp/adv-archive/Lakonik.xcarchive -exportOptionsPlist ExportOptions.plist \
  -exportPath /tmp/adv-export -allowProvisioningUpdates \
  -authenticationKeyPath <AuthKey.p8> -authenticationKeyID <KEY_ID> -authenticationKeyIssuerID <ISSUER_ID>
```

`ExportOptions.plist` настроен на прямую загрузку в App Store Connect. Расширение трансляции (запись онлайн-встреч) использует App Group `group.kz.adv.meetings` (создана в Apple Developer 21.09.2026 и привязана к App ID `kz.adv.meetings` и `kz.adv.meetings.broadcast`; автоподпись через ключ API группы создавать не умеет, только использовать). В Info.plist расширения ключ `RPBroadcastProcessMode` должен стоять прямо под `NSExtension` — в `NSExtensionAttributes` (как в шаблоне Xcode) валидатор App Store Connect его не видит и отклоняет сборку. Статус обработки, группы и крэш-логи из TestFlight: `pnpm --filter @lakonik/server exec tsx scripts/asc.ts builds | group | testers | crashes`. Внутренних тестировщиков (участников команды) добавляют в группу в App Store Connect; если после добавления у тестера статус NOT_INVITED / «No Builds Available» — письмо-приглашение не ушло, отправить его: `asc.ts invite <email…>`. Внешних — по email через `asc.ts add`, первая внешняя сборка проходит Beta App Review.

## Деплой (Railway)

Проект `adv-meetings`: Postgres, bucket `audio-temp`, сервисы `api` и `worker` из одного образа `apps/server/Dockerfile` (контекст сборки — корень репозитория). `api` при старте применяет миграции и сид шаблонов.

```bash
railway up --service api --detach -m "…"
railway up --service worker --detach -m "…"
```

Переменные окружения — `apps/server/.env.example`. Ключи (`ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `RESEND_API_KEY`, APNs `.p8`) переносятся из локального `.env` в оба сервиса одной командой:

```bash
pnpm --filter @lakonik/server env:railway
```

Ключ ElevenLabs должен иметь разрешение Speech to Text. Ключ APNs — из Apple Developer → Keys с включённым APNs (Sandbox & Production); проверка: `scripts/apns-check.ts`.

## API (основное)

- `POST /api/auth/email-otp/send-verification-otp`, `POST /api/auth/sign-in/email-otp`, `POST /api/auth/sign-in/social` (Apple, ID-токен), `POST /api/auth/update-user`.
- `GET /api/templates`, `GET /api/me`, `POST /api/me/devices`, `GET /api/users`.
- `POST /api/meetings` (без `templateId` — быстрая запись, тип задаётся позже через `PATCH … { templateId }`), `GET /api/meetings`, `GET/PATCH/DELETE /api/meetings/:id`, `POST /api/meetings/:id/segments` → presigned PUT, `POST …/segments/:seq/complete`, `POST /api/meetings/:id/finalize`, `POST …/retry`, `GET …/events` (SSE).
- `PATCH /api/meetings/:id/speakers` (имена, роли, владелец, `merges` для слияния дублей, `confirmed`), `POST /api/meetings/:id/reports` (первый отчёт из статуса `transcribed`, пересборка / ИИ-правка с `instructions`), `PATCH /api/meetings/:id/reports/:reportId` (ручная правка текста), `GET …/export?format=docx|pdf|md|txt`, `GET/POST/DELETE …/shares`.
- `GET /api/tasks`, `PATCH/DELETE /api/tasks/:id`, `GET/POST /api/meetings/:id/tasks`, `GET/POST/PATCH/DELETE /api/people`, `GET/PUT /api/settings/deadlines`.

## Тесты

```bash
pnpm --filter @lakonik/server test        # vitest: сегментация STT, рендер отчётов, промпт, сроки задач
pnpm --filter @lakonik/server typecheck
```

## Стоимость

Часовая встреча ≈ $0.65–0.80: ElevenLabs $0.22 + Claude Opus 5 ≈ $0.45–0.60 (в режиме черновика на Sonnet 5 ≈ $0.45 за встречу). Обработка часовой записи занимает 3–5 минут.
