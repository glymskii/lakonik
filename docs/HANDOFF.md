# Состояние проекта на 22.09.2026 (пауза)

Точка входа в проект: что готово, где лежит, что делать дальше. Подробности — в документах по ссылкам.

## Что это

iOS-приложение **Lakonik** (ранее «ADV Meetings»): запись встречи → расшифровка с разделением говорящих
(ElevenLabs Scribe v2) → контакт-репорт по шаблону типа встречи (Claude) → задачи, экспорт, шаринг.
Работает в TestFlight у холдинга ADV Kazakhstan; готовится выход в App Store как самостоятельный продукт.

- Репозиторий: `github.com/glymskii/lakonik` (папка проекта — эта).
- Сервер: Railway, проект `adv-meetings` — сервисы `api` и `worker`, Postgres, bucket `audio-temp`;
  API: `https://api.lakonik.app`.
- Сайт: `https://lakonik.app` (Vercel, проект `lakonik-site`, исходники — `apps/site`).
- App Store Connect: приложение **Lakonik**, ID 6812003830, bundle `kz.adv.meetings`, команда JWL983DY46.
  Последняя сборка TestFlight — **27** (VALID).

## Документы

| Файл | О чём |
|---|---|
| `README.md` | архитектура, локальный запуск, тесты, релиз в TestFlight, деплой |
| `docs/lakonik-1.0.md` | ТЗ публичного продукта: 14 решений, модель данных, API, тарифы, фазы, чек-лист App Store |
| `docs/self-hosted.md` | корпоративный контур: сервер заказчика, вход по коду организации |
| `docs/adv-server-answers.md` | готовые ответы ADV на вопросы по серверу и переносу |
| `docs/guide/` | памятка сотрудника (HTML → PDF) и скрипт пересборки |
| `docs/PLAN.md` | исходный план разработки (история решений) |
| `deploy/` | комплект развёртывания у заказчика: compose, Caddyfile, .env.example, инструкция админу |

## Что сделано (обновлено 23.09.2026)

- **Продукт**: запись в фоне и с заблокированным экраном, расшифровка, проверка спикеров с подсказками ИИ и объединением дублей,
  отчёты по шаблонам, правка отчёта текстом и через ИИ, задачи с ответственными и сроками, экспорт DOCX/PDF/MD, шаринг,
  импорт файлов, запись онлайн-встреч через расширение трансляции (только собеседники — ограничение iOS).
- **Фаза 0**: бренд Lakonik, домены, сайт, String Catalog, Sentry/Amplitude, экспорт починен.
- **Фаза 1 — организации и пространства**: схема и идемпотентный перенос данных, скоуп API по `X-Organization-Id`,
  полный API организаций, удаление аккаунта; iOS — переключатель, онбординг, карточка организации, Universal Link `/join`.
- **Фаза 2 — подписки и квоты**: тарифы Free/Starter/Pro/Безлимит/Enterprise, 402 с причинами, StoreKit 2 и paywall,
  CLI администратора (`scripts/admin.ts`).
- **Каталог**: 11 встроенных нейтральных шаблонов; шаблоны ADV — приватные в их организации.
- **Корпоративный вход**: код организации → сервер компании (`/api/org-servers`), комплект развёртывания в `deploy/`.
- **Интеграции Meet/Zoom**: iOS-экран готов, серверная часть — см. статус в `docs/lakonik-1.0.md`.

## Что дальше

1. **Прод-деплой с переносом ADV в организацию** — только после подтверждения владельца (почта владельца организации,
   переменные `LEGACY_ORG_*` на Railway), затем TestFlight-сборка с организациями.
2. Продукты подписок в App Store Connect, Sandbox-проверка покупок в TestFlight.
3. Ключи Google/Zoom для интеграций; OAuth client для Google-входа.
4. ADV, свой сервер — по `deploy/README.md`, когда их админ будет готов.
5. Фаза 5 — релиз в App Store (`docs/lakonik-1.0.md`, раздел 15).

## Что нужно от владельца (вне кода)

DSN Sentry и ключ Amplitude; OAuth client Google для iOS; проект Google Cloud (Meet API) и заявка на верификацию;
приложение Zoom Marketplace; переадресация `support@lakonik.app`; Paid Apps Agreement и Small Business Program в
App Store Connect; решение по правам на код в договоре с ADV и по локализации данных РК.

## Как вернуться к работе

```bash
docker compose -f infra/docker-compose.yml up -d          # Postgres + MinIO
cd apps/server && ./node_modules/.bin/tsx --env-file=.env src/api/index.ts     # API
cd apps/server && ./node_modules/.bin/tsx --env-file=.env src/worker/index.ts  # обработчик
cd apps/ios && xcodegen generate && open Lakonik.xcodeproj
```

Демо-данные для скриншотов: `scripts/seed-showcase.ts` + `scripts/seed-guide.ts` (пользователь
`asel.nurlanova@orbita.kz`). Проверка TestFlight и крэшей: `scripts/asc.ts builds | testers | crashes`.
