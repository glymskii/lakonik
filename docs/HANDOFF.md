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

## Что сделано к паузе

- **Продукт**: запись в фоне и с заблокированным экраном, расшифровка, проверка спикеров с подсказками ИИ и
  объединением дублей, отчёты по 12 шаблонам, правка отчёта текстом и через ИИ, задачи с ответственными и сроками,
  экспорт DOCX/PDF/MD, шаринг, импорт файлов, запись онлайн-встреч через расширение трансляции.
- **Фаза 0 публичного продукта** (22.09.2026): переименование в Lakonik, домены `lakonik.app` и `api.lakonik.app`,
  сайт с политиками, String Catalog, Sentry и Amplitude (ключи не заданы), починен экспорт DOCX/PDF.
- **Корпоративный вход**: справочник `/api/org-servers/{code}` + режимы «Личный / Корпоративный» в приложении
  (проверено сквозняком на симуляторе), комплект развёртывания в `deploy/`.

## Что дальше

1. **ADV, свой сервер** — ждём, когда их администратор поднимет сервер по `deploy/README.md` и назовёт домен;
   затем добавить запись в `ORG_SERVERS` на Railway, перенести данные пилота, проверить и удалить их у себя.
2. **Фаза 1 публичного продукта** — организации и пространства (раздел 14 в `docs/lakonik-1.0.md`), дальше
   подписки, каталог шаблонов, интеграции Meet/Zoom, релиз.
3. **Мелкое**: push-relay для корпоративного контура; после верификации домена в Resend переключить
   `EMAIL_FROM` на `noreply@lakonik.app`.

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
