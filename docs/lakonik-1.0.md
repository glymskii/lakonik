# Lakonik 1.0 — ТЗ: из внутреннего приложения ADV в публичный продукт

Документ для агента-разработчика. Решения ниже согласованы с владельцем продукта 21.09.2026 и не обсуждаются заново; открытые вопросы вынесены в раздел 16. Контекст текущей системы — `README.md` (структура, пайплайн, релиз, деплой) и `docs/PLAN.md` (исходный план). Всё, что здесь не описано, работает как сейчас.

## 0. Как работать с этим документом

- Репозиторий — монорепо `apps/server` (Node 22, Hono + zod-openapi, Drizzle, pg-boss, Better Auth 1.7) и `apps/ios` (SwiftUI, iOS 17+, xcodegen). Прод — Railway (api, worker, Postgres, bucket), сборки — TestFlight через ASC API key (см. README «Релиз в TestFlight»).
- Порядок фаз — раздел 14; каждая фаза заканчивается зелёными `pnpm --filter @adv/server test`, `tsc --noEmit`, сборкой iOS для симулятора и коммитом на `main` (сообщения на русском, как в истории git).
- Схема БД меняется только через drizzle-kit миграции (`apps/server/drizzle`), сид — `src/db/seed.ts`.
- UI и письма — на русском, все строки через String Catalog (`String(localized:)`), ни одного упоминания ADV/холдинга/агентств в пользовательских текстах.
- Ничего не удалять из пайплайна записи/расшифровки/отчётов: он не меняется, меняется скоуп данных (организации) и обвязка (вход, квоты, оплата).
- Проверка на реальных провайдерах — `scripts/e2e-pipeline.ts` (центы за прогон); без ключей — `FAKE_PROVIDERS=true`.

## 1. Цель и границы

**Было**: закрытое приложение «ADV Meetings» для сотрудников восьми агентств холдинга (вход только с корпоративных доменов, плоская модель `agencies` → `user.agencyId`), запись встречи → ElevenLabs Scribe v2 → проверка спикеров → отчёт Claude по шаблонам ADV → задачи.

**Станет**: публичное приложение **Lakonik** в App Store для всех: личное использование без организации, свои организации с приглашениями, подписки через In-App Purchase, ADV — первая организация на плане enterprise.

**В 1.0 не входит** (следующие этапы, раздел 17): веб-интерфейс, self-hosted режим для организаций (ADV просили свой сервер — делаем после 1.0, когда дадут доступы), бот-участник для онлайн-встреч, Android, редактор шаблонов организации в приложении, оплата организаций по IAP (командные ступени), английский интерфейс.

## 2. Принятые решения

| № | Решение |
|---|---|
| 1 | Одно приложение, тот же аккаунт Apple Developer (личный, команда JWL983DY46), та же запись ASC 6812003830, bundle `kz.adv.meetings` не меняется. Название **Lakonik**, домен **lakonik.app** |
| 2 | Интерфейс только русский, String Catalog с первого дня; App Store — все страны; базовые цены в USD, для сторфронта Казахстана — своя цена в ₸ |
| 3 | Организации одноуровневые (без команд внутри). Пространства: у каждого пользователя личное (создаётся автоматически) + организации; пользователь может состоять в нескольких; **все данные скоупятся `organizationId`**, личное пространство — организация `kind = personal` |
| 4 | Данные организационного пространства принадлежат организации. Внутри организации встречу видят **только автор и те, с кем он поделился**; админ содержимого не видит. При удалении участника админ передаёт его встречи/задачи другому участнику или удаляет; конфиденциальные встречи (`restricted`) при передаче удаляются |
| 5 | Вступление: ссылка-приглашение (главный способ), приглашение по email, автовступление по подтверждённому домену — тумблер организации, по умолчанию выключен; публичные почтовые домены не подтверждаются |
| 6 | Шаблоны: встроенный каталог, написанный заново (без текстов ADV) + приватные шаблоны организации (`templates.organizationId`). Двенадцать шаблонов ADV становятся приватными шаблонами организации ADV |
| 7 | Вход: код на почту (есть), Sign in with Apple (есть), Google (добавить в iOS; сервер настроен). Удаление аккаунта из приложения — обязательно (App Review 5.1.1 v) |
| 8 | Подписки — только личные, через IAP (StoreKit 2), квота считается по пользователю. Организации — план `enterprise`, включается вручную по счёту; карточка «Enterprise — напишите нам» только с email, без цены и внешних ссылок на оплату |
| 9 | Сетка тарифов — раздел 8 (Free 5 мин × 5 записей в день; Starter $4.99; Pro $9.99; Безлимит $24.99 с fair use 40 ч; годовые −20 %; 7-дневный триал на Pro) |
| 10 | Self-hosted режим (одно приложение, сервер организации) — после 1.0; ADV до этого остаётся на сервере владельца |
| 11 | Миграция ADV: организация «ADV Kazakhstan», owner — владелец продукта, план enterprise 100 мест до 31.12.2026, автовступление по восьми доменам агентств |
| 12 | Аналитика Amplitude (события с сервера, без содержимого встреч), ошибки Sentry (api, worker, iOS); поддержка и Enterprise-контакт — `support@lakonik.app` |
| 13 | Порядок: Lakonik 1.0 → self-hosted для ADV → веб |
| 14 | Онлайн-встречи: в 1.0 — интеграции со штатными записями Google Meet и Zoom (без бота, без платы за час); свой бот-участник на базе открытого Attendee/Vexa — 1.x; Recall.ai — только как аварийная замена. Запись с того же iPhone во время звонка — только собеседники (ограничение iOS), режим остаётся с честным текстом |

## 3. Бренд и переименование (фаза 0)

Не меняются: bundle id `kz.adv.meetings`, `kz.adv.meetings.widgets`, `kz.adv.meetings.broadcast`, App Group `group.kz.adv.meetings` (идентификаторы Apple не переименовываются; пользователю не видны), команда и запись ASC.

Меняются:
- Имя в ASC и `CFBundleDisplayName` → **Lakonik**; подзаголовок в App Store — «Протокол встречи из записи» (рабочий вариант).
- Репозиторий GitHub `adv-meetings` → `lakonik`; папка `apps/ios/ADVMeetings` → `apps/ios/Lakonik`, таргеты/схема/модуль `ADVMeetings*` → `Lakonik*` в `project.yml` и `project-lite.yml` (проверить `BroadcastStore.isAvailable` — имя `.appex`, principal class расширения `$(PRODUCT_MODULE_NAME).SampleHandler`, `subsystem` логгеров). Одним коммитом, до остальных работ.
- Пакет сервера `@adv/server` → `@lakonik/server`, `appName` Better Auth, `EMAIL_FROM` → `Lakonik <noreply@lakonik.app>` (домен подтвердить в Resend), тексты писем.
- Пользовательские тексты: `SettingsView` («о приложении»), `SignInView` (убрать «только сотрудникам холдинга»), `PeoplePickerView`/`SpeakerPickerView` («аккаунты холдинга» → «участники организации»), `MeetingTypeFlow` (footer), `ReportView` («по регламенту холдинга» → «срок отчёта: N ч, настраивается в организации»), `DeadlineSettingsView`, `RecordingCoordinator` (текст про Настройки → Lakonik), APNs-тексты в `push/apns.ts`.
- Домены: `api.lakonik.app` — кастомный домен сервиса `api` на Railway (`BASE_URL`, `API_BASE_URL` в сборке); `lakonik.app` — статический сайт на Vercel (раздел 11).

## 4. Модель данных

Better Auth: подключить плагин `organization` (таблицы `organization`, `member`, `invitation`, поле `activeOrganizationId` в сессии не используем — активное пространство выбирает клиент, раздел 6). Дополнительные поля организации — через `schema.organization.additionalFields` плагина; если версия плагина их не поддерживает — боковая таблица `organization_profiles` 1:1.

```
organization            id, name, slug, logo, createdAt, metadata
  + kind                'personal' | 'team'
  + plan                'free' | 'enterprise'          -- у personal всегда free (подписка живёт у пользователя)
  + planSeats           int null                        -- enterprise
  + planUntil           timestamptz null                -- enterprise; после даты план считается free
  + inviteToken         text unique                     -- ссылка-приглашение; перевыпускается
  + allowDomainJoin     bool default false
  + settings jsonb      { deadlines: DeadlineSettings, keyterms: string[] }
member                  id, organizationId, userId, role ('owner'|'admin'|'member'), createdAt
invitation              id, organizationId, email, role, status, expiresAt, inviterId   -- email-приглашения (плагин)
organization_domains    organizationId, domain (lower), verified bool, createdAt        -- PK (organizationId, domain)

user                    − agencyId, − role;  + isSuperadmin bool default false           -- для CLI/HTTP-админки владельца
meetings                + organizationId text not null → organization.id (index (organizationId, createdAt));  − agencyId
                        + orphanedFrom text null   -- прежний владелец, если участник удалён/удалил аккаунт (раздел 5); админ видит такие встречи в «Без владельца»
people                  + organizationId not null; уникальность normalized_name → (organizationId, normalized_name)
tasks                   + organizationId not null (денормализация из meeting)
meeting_templates       + organizationId text null (null = встроенный); unique (organizationId, code)
usage_events            + organizationId
settings                удалить (deadlines переезжают в organization.settings)
agencies                удалить после миграции (раздел 13)

subscriptions           id, userId, productId, tier ('starter'|'pro'|'unlimited'), originalTransactionId unique,
                        status ('active'|'grace'|'expired'|'revoked'), expiresAt, autoRenew bool, environment ('Sandbox'|'Production'),
                        lastTransactionId, lastNotificationType, updatedAt
```

Права доступа (`api/authz.ts`, `routes/tasks.ts:accessibleMeetingsWhere`) — без изменений по сути: владелец + явные `shares`. Добавляется проверка членства: любой запрос к данным пространства требует `member(organizationId, userId)`; `isSuperadmin` даёт только админ-эндпоинты (план организации, статистика), **не** доступ к содержимому встреч.

Регистрация (`auth/auth.ts`, хук `user.create`): allowlist доменов и привязка к агентству удаляются; после создания пользователя (`after`) создаётся личная организация `kind = personal`, `name = имя пользователя`, участник `owner`.

## 5. Вход и аккаунт

- Провайдеры: emailOTP (есть), Apple (есть, ID token), Google — добавить в iOS `GoogleSignIn-iOS` (SPM), кнопка на `SignInView`, ID token → существующий `signIn.social` с `idToken`; `GOOGLE_CLIENT_IDS` — iOS client id. Порядок кнопок: Apple, Google, «Код на почту».
- `DELETE /me` — удаление аккаунта. Правила: личная организация и всё в ней удаляются; из командных организаций пользователь удаляется как участник, его встречи остаются в организации без владельца (`ownerId = null` запрещён схемой → перед удалением встречи переводятся на владельца организации с пометкой `orphanedFrom`, админ видит их в разделе «Без владельца» и передаёт/удаляет); если пользователь — **единственный owner** организации, где есть другие участники, — 409 `account.sole_owner` с именем организации: сначала передать владение или удалить организацию; если он один в организации — организация удаляется. Для аккаунтов Apple — отзыв токена (`https://appleid.apple.com/auth/revoke`, client_secret по ключу `APPLE_*`). Активная подписка не отменяется — экран показывает «отмените подписку в Настройках Apple ID».
- iOS: Настройки → Аккаунт → «Удалить аккаунт» с подтверждением (ввести «УДАЛИТЬ»), затем выход и очистка LocalStore/Keychain.

## 6. Организации и пространства

**Активное пространство** выбирает клиент и передаёт в каждом запросе к данным заголовком `X-Organization-Id`; middleware `requireMembership` проверяет членство и кладёт `org` в контекст. Без заголовка — 400. `GET /me` отдаёт список пространств пользователя (личное первым) с ролью, `kind`, планом и правами, а также его entitlement (раздел 8). Клиент хранит выбранное пространство в UserDefaults и переключает его в меню списка встреч; запись, импорт и онлайн-встреча создаются в активном пространстве. SSE `/meetings/{id}/events` и push не зависят от пространства (идентификатор встречи глобален).

Роли: `owner` (всё + передача владения, удаление организации, план), `admin` (участники, приглашения, домены, настройки, шаблоны, передача осиротевших встреч), `member`. В личной организации только owner.

API (все под `/api`, bearer):

```
POST   /organizations                      {name}                       → организация (создатель — owner); домен почты создателя,
                                                                          если не публичный, добавляется в organization_domains как verified
GET    /organizations/{id}                                              → карточка: участники (id, name, email, role), домены, allowDomainJoin, план, inviteToken (owner/admin)
PATCH  /organizations/{id}                 {name?, allowDomainJoin?, settings?}   (admin)
POST   /organizations/{id}/invite-link     → новый inviteToken (admin; старая ссылка перестаёт работать)
POST   /organizations/{id}/invitations     {email, role?}               (admin) → письмо со ссылкой lakonik.app/join/<token>?e=<invitationId>
GET    /organizations/{id}/members
PATCH  /organizations/{id}/members/{userId} {role}                      (owner: любые; admin: member↔admin)
DELETE /organizations/{id}/members/{userId} {transferTo?: userId}       (admin) — встречи/задачи/люди уходят transferTo или удаляются; restricted — всегда удаляются
POST   /organizations/{id}/transfer        {toUserId}                   (owner)
POST   /organizations/{id}/leave                                        (не owner)
DELETE /organizations/{id}                                              (owner; удаляет все данные пространства)
GET    /organizations/suggested                                         → организации с verified-доменом почты пользователя и allowDomainJoin = true
POST   /organizations/{id}/join                                         → вступление по домену
GET    /join/{token}                       (без авторизации)            → {organizationName, membersCount, kind} — для экрана «Вас приглашают»
POST   /join/{token}                                                    → вступить по ссылке (проверка лимита мест enterprise: 409 plan.seats)
```

Стоп-лист публичных доменов (`auth/public-domains.ts`): gmail.com, googlemail.com, icloud.com, me.com, mac.com, outlook.com, hotmail.com, live.com, yahoo.com, mail.ru, bk.ru, list.ru, inbox.ru, yandex.ru, yandex.kz, yandex.com, ya.ru, proton.me, protonmail.com, privaterelay.appleid.com, plus всё, что оканчивается на `.appleid.com`.

Скоуп существующих маршрутов: `meetings`, `tasks`, `people`, `templates` (`GET /templates` → встроенные + шаблоны организации), `settings/deadlines` → `PATCH /organizations/{id}` (settings.deadlines), `me/users` → `GET /organizations/{id}/members` (пикеры «Коллеги»). Пайплайн: `keyterms` берутся из `organization.settings.keyterms`, задачи/люди создаются в `meeting.organizationId`.

iOS — новые экраны (папка `Organizations/`):
- **Онбординг после входа** (только если у пользователя нет ни одной командной организации и нет предложений по домену): «Как будете пользоваться?» — *Личное* (по умолчанию, просто закрывает экран), *Создать организацию* (название → ссылка-приглашение с кнопкой «Поделиться»), *Присоединиться* (вставить ссылку/код). Если по домену найдены организации — карточка «Вас ждут в …» с кнопкой «Присоединиться».
- **Переключатель пространств** — меню в заголовке списка встреч (иконка/название текущего пространства), внизу «Создать организацию», «Присоединиться».
- **Организация** (Настройки → название организации): участники с ролями (admin: изменить роль, удалить с передачей), ссылка-приглашение (поделиться, перевыпустить), приглашение по email, домены + тумблер автовступления, план (Free / Enterprise N мест до даты), сроки отчётов (перенос `DeadlineSettingsView`), «Покинуть организацию», для owner — «Удалить организацию», «Передать владение».
- **Приём приглашения** — Universal Link `https://lakonik.app/join/<token>`: приложение открыто → экран «Вас приглашают в …» → «Вступить»; не установлено → страница на сайте ведёт в App Store, токен сохраняется в clipboard-fallback (при первом запуске проверяем буфер обмена на ссылку `lakonik.app/join/`).
- Пикеры людей и спикеров, шаринг — источник «участники организации» вместо «аккаунты холдинга»; в личном пространстве раздел скрыт.

## 7. Каталог типов встреч

Встроенные шаблоны (`organizationId = null`) — написать заново по текущей схеме `MeetingTemplate` (`specificFields` с `askBeforeRecording`, `reportSections`, `tips`, `allowConfidentialityChoice`), без терминологии агентств и без списков рассылки. Состав 1.0:

| code | Название | Группа | Особенности |
|---|---|---|---|
| `client_intro` | Знакомство с клиентом | client | цитаты клиента дословно, «вопросы к клиенту» |
| `client_brief` | Бриф от клиента | client | поля брифа, «не озвучено — уточнить» |
| `client_status` | Статус с клиентом | client | план/факт, риски, следующие шаги |
| `client_review` | Разбор результатов | client | блок «внутренние выводы — не для клиента» |
| `internal_status` | Внутренний статус | internal | светофор по направлениям |
| `internal_brief` | Постановка задачи команде | internal | дедлайны, ответственные |
| `internal_management` | Совещание руководства | internal | решения, ответственные, allowConfidentialityChoice |
| `partner_negotiation` | Переговоры с партнёром | partner | позиции сторон, условия, уступки |
| `one_on_one` | 1:1 и HR-встречи | people | `restricted` |
| `interview` | Собеседование | people | `restricted`, оценка по критериям |
| `lecture` | Лекция, выступление, заметки | notes | конспект, тезисы, вопросы |
| `unclassified` | Без типа | system | как сейчас: саммари + задачи, скрыт из выбора |

Группы (`TemplateGroup`): client 🔵, internal 🟢, partner 🟡, people 🟣, notes ⚪. `seed.ts` сидит встроенные по `code` (upsert с версией); шаблоны ADV сидятся отдельным скриптом миграции как `organizationId = ADV` (раздел 13). Редактор шаблонов организации в приложении — не в 1.0; админ добавляет шаблоны через CLI `scripts/admin.ts templates import <orgId> <file.json>`.

## 8. Тарифы, квоты, StoreKit

| Тариф | Product ID (мес / год) | Цена мес / год | Часов в месяц | Макс. длительность записи | Записей в день | Модель отчёта | Онлайн-встречи |
|---|---|---|---|---|---|---|---|
| Free | — | 0 | — | **5 мин** | **5** | Sonnet | нет |
| Starter | `lakonik.starter.monthly` / `.yearly` | $4.99 / $47.99 | 5 ч | 60 мин | ∞ | Sonnet | нет |
| Pro | `lakonik.pro.monthly` / `.yearly` | $9.99 / $95.99 | 15 ч | 3 ч | ∞ | Opus | да |
| Безлимит | `lakonik.unlimited.monthly` / `.yearly` | $24.99 / $239.99 | fair use 40 ч | 5 ч | ∞ | Opus, приоритет очереди | да |
| Enterprise | вручную (`organization.plan`) | по счёту | пул 20 ч × места | 5 ч | ∞ | Opus | да |

App Store Connect: одна группа подписок `Lakonik Plans`, уровни: Безлимит (1) > Pro (2) > Starter (3) — апгрейд/даунгрейд считает Apple. Intro offer: 7 дней бесплатно на `lakonik.pro.*` для новых подписчиков. Годовые — ровно −20 % от 12 месячных (ближайшая ценовая точка Apple). Базовая цена — USD, для сторфронта KZ задать цену в ₸ вручную. Подать заявку в Small Business Program (15 %).

**Entitlement пользователя** = максимальный уровень среди активных `subscriptions` (`status in active|grace`), иначе Free. Внутри организации с планом `enterprise` (не истёк) все участники получают уровень Enterprise, и их часы идут в пул организации; личное пространство того же пользователя живёт по его личной подписке.

**Правила квот** (сервер — источник истины; коды ошибок HTTP 402 `{code, limit, used, resetsAt}`; клиент показывает paywall):
- `quota.daily` — Free: 6-я запись/импорт за календарный день (день по часовому поясу устройства: заголовок `X-Timezone`, IANA).
- `quota.duration` — лимит длительности: клиент останавливает запись на границе с сообщением и предложением апгрейда (запись сохраняется и обрабатывается), для импорта — файл длиннее лимита отклоняется до загрузки (длительность считает клиент, сервер перепроверяет после merge: превышение более чем на 10 % → `failed` с понятным текстом).
- `quota.monthly` — часы: сумма `durationSec` обработанных встреч владельца (или пула организации) за календарный месяц в поясе устройства; при исчерпании новая запись/импорт не создаются, **текущая запись дописывается** (мягкий перерасход в пределах лимита длительности).
- `feature.online_meetings` — запись онлайн-встречи только Pro и выше (Free/Starter видят пункт меню с замком).
- Модель отчёта — по уровню (`ANTHROPIC_MODEL` для Opus, `ANTHROPIC_MODEL_DRAFT` для Sonnet); регенерация отчёта квоту не тратит.
- Безлимит: 40 ч/мес — мягкий потолок, после него `quota.monthly` с текстом про fair use (в условиях использования).

**Серверная часть** (`src/billing/`): `@apple/app-store-server-library` (проверка JWS подписей по корневым сертификатам Apple, окружения Sandbox/Production). `POST /billing/apple/transactions {jws}` — клиент присылает `Transaction.jwsRepresentation` после покупки/восстановления; сервер проверяет подпись, `bundleId`, `appAccountToken` (= userId, задаётся при покупке, чтобы привязать чужой Apple ID нельзя было к чужому аккаунту) и upsert'ит `subscriptions`. `POST /billing/apple/notifications` — App Store Server Notifications v2 (подписной JWS; типы `SUBSCRIBED`, `DID_RENEW`, `DID_CHANGE_RENEWAL_STATUS`, `EXPIRED`, `GRACE_PERIOD_EXPIRED`, `REFUND`, `REVOKE`, `DID_FAIL_TO_RENEW`) → статус. `GET /billing/entitlement` → `{tier, source: 'subscription'|'enterprise'|'free', usage: {monthlySec, monthlyLimitSec, dailyCount, dailyLimit, resetsAt}}`. Периодическая сверка (cron pg-boss раз в сутки) через App Store Server API `Get All Subscription Statuses` для подписок без уведомлений > 24 ч.

**iOS** (`Billing/`): `StoreKit 2` — `Product.products(for:)`, `purchase(options: [.appAccountToken(userId)])`, `Transaction.updates` слушатель с первого запуска, `AppStore.sync()` для «Восстановить покупки». Экран **Тариф** (Настройки и paywall): текущий уровень и использование (полоска часов, счётчик записей на Free), карточки Starter / Pro / Безлимит с переключателем «в месяц / в год (−20 %)», кнопка триала на Pro, «Восстановить покупки», ссылка «Управление подпиской» (`showManageSubscriptions`), внизу карточка **Enterprise для организаций** — текст «Общий пул часов, приглашения, приватные шаблоны, оплата по счёту» и кнопка «Написать нам» → `mailto:support@lakonik.app` с темой «Enterprise: <название организации>»; никаких цен и ссылок на сайт с оплатой. Paywall открывается из ошибок 402, из замка на онлайн-встречах и из Настроек. Обязательные ссылки на условия использования и политику конфиденциальности на paywall (требование ревью для подписок).

**Enterprise вручную**: `scripts/admin.ts org plan <orgId> enterprise --seats 100 --until 2026-12-31` (и `org plan <orgId> free`), `scripts/admin.ts org stats <orgId>` — участники, часы за месяц. Скрипт ходит в БД напрямую (как `seed-showcase.ts`), для прод — через `railway run`.

## 9. Экраны и изменения iOS (сводка)

| Область | Что сделать |
|---|---|
| `Auth/SignInView` | кнопка Google, тексты без ограничения доменов, ссылки на условия/политику |
| `Onboarding` | экран «Как будете пользоваться?» (раздел 6), показ один раз |
| `Meetings/MeetingsListView` | переключатель пространств в заголовке, состояние пустого пространства («Запишите первую встречу»), замок на онлайн-встречах для Free/Starter, обработка 402 → paywall |
| `Recording/RecordingCoordinator` | авто-стоп на лимите длительности (по entitlement из `/me`), заголовок `X-Organization-Id` и `X-Timezone` в `APIClient` |
| `Organizations/*` | карточка организации, участники, приглашения, домены, план, приём ссылки |
| `Settings` | Аккаунт (email, провайдер, удалить аккаунт), Тариф, Организация, Интеграции (раздел 10), Поддержка (письмо с userId/версией), О приложении |
| `Billing/*` | StoreKit, paywall, entitlement-кеш |
| Universal Links | `applinks:lakonik.app` в entitlements, обработчик `/join/<token>` в `App` |
| String Catalog | `Localizable.xcstrings`, все строки через `String(localized:)`; ru — базовый |
| Тексты | без ADV/холдинга; статус `transcribed` — свой цвет/иконка в `Components/UIHelpers.swift` (давний мелкий долг) |

## 10. Онлайн-встречи: интеграции Meet/Zoom и ограничение iOS

**Ограничение iOS (проверено на устройстве 21.09.2026)**: пока в Meet/Zoom/Teams идёт звонок, микрофон другим приложениям не выдаётся — обычная запись не стартует (`insufficientPriority`), а расширение трансляции ReplayKit получает звук приложения, но не `audioMic`. Значит, с того же iPhone во время звонка записываются только собеседники. Расширение (`ADVMeetingsBroadcast`, `Recording/BroadcastSession.swift`, `BroadcastImporter.swift`, `OnlineMeetingView.swift`) остаётся как режим «собеседники/вебинары» с честным текстом на экране; доступен с Pro. Полноценная запись онлайн-встреч в 1.0 — через штатные записи платформ.

### Google Meet (Workspace)

- Пользователь подключает Google-аккаунт: Настройки → Интеграции → Google Meet (OAuth 2.0, PKCE, `ASWebAuthenticationSession`; серверный обмен кода). Скоупы: `openid email`, `https://www.googleapis.com/auth/meetings.space.readonly` (Meet REST API v2: записи конференций, участники, транскрипты), `https://www.googleapis.com/auth/drive.meet.readonly` (скачивание только файлов, созданных Meet). Refresh-токен — в таблице `integrations` (userId, organizationId, provider `google_meet`|`zoom`, accountEmail, refreshToken зашифрован ключом `INTEGRATIONS_KEY`, scopes, autoImport bool, lastSyncAt, status).
- Обнаружение записей: cron pg-boss раз в 10 минут по всем активным интеграциям — `conferenceRecords.list` (filter `start_time >= lastSyncAt − 1 день`) → `conferenceRecords.recordings.list` (состояние `FILE_GENERATED`, `driveDestination.file`). Дедупликация — `meetings.externalRef` (`google_meet:<recordingName>`, unique). Позже — Workspace Events API (Pub/Sub, событие `recording.fileGenerated`) вместо опроса.
- Импорт: Drive `files.get?alt=media` → mp4 во временный bucket → worker `ffmpeg -vn` в m4a → штатный пайплайн (`source = imported`, `platform = "Google Meet"`, название из `conferenceRecords` → `space.meetingCode` + дата, при наличии Calendar-события — его название, скоуп `calendar.events.readonly` необязателен и в 1.0 не берём).
- Участники и имена: `conferenceRecords.participants.list` → `participantsHint`; если у записи есть транскрипт Meet (`transcripts.entries.list`: участник + текст + время), он передаётся шагу анализа спикеров как подсказка соответствия «сегменты диаризации ↔ имена» (по пересечению во времени). Расшифровка остаётся нашей (Scribe): казахский и диаризация лучше, чем у Meet.
- Квота: авто-импорт тратит часы владельца интеграции (или пул enterprise); при исчерпании запись пропускается с push «Запись Meet не импортирована: закончились часы» и появляется после апгрейда (повторный проход крона).
- Верификация OAuth-приложения Google (sensitive scopes) — подать в фазе 0, занимает 2–6 недель; до верификации работает с предупреждением и лимитом 100 пользователей. Для ADV: админ Workspace добавляет client ID в доверенные (Admin console → Security → API controls → App access control).
- Требование к пользователю: план Workspace с записью встреч (Business Standard и выше); хост включает запись кнопкой или админ — авто-запись. Тексты в приложении объясняют это на экране интеграции.

### Zoom (Pro и выше)

- OAuth-приложение Zoom Marketplace (user-managed), скоупы `recording:read`, `user:read`, `meeting:read`; webhook `recording.completed` (проверка подписи `x-zm-signature`) → скачать `audio_only` (M4A) по `download_url` с токеном → пайплайн (`platform = "Zoom"`, участники — `past_meetings/{id}/participants`). Fallback-опрос `users/me/recordings` раз в 10 минут для пропущенных вебхуков.
- Для пользователей вне аккаунта владельца приложение Zoom должно пройти ревью Marketplace (недели) — подать в фазе 0; если ревью задерживает релиз, Zoom выходит в 1.1, Meet — в 1.0.

### iOS

- Настройки → **Интеграции**: карточки Google Meet и Zoom (подключить/отключить, аккаунт, тумблер «импортировать записи автоматически», подсказка про план и кнопку записи), статус последней синхронизации.
- На экране «Онлайн-встреча» — блок «Записать встречу целиком: подключите Google Meet или Zoom — записи будут появляться в списке сами», ссылка на интеграции.
- В списке встреч у импортированных — бейдж платформы.

## 11. Сайт, домены, письма

- `lakonik.app` — статический сайт на Vercel (папка `apps/site`, любой статический генератор или чистый HTML): лендинг с кнопкой App Store, `/privacy`, `/terms` (с fair use и правилами подписок), `/support` (email, FAQ), `/join/<token>` (страница «Вас приглашают в …», данные с `GET /join/{token}`; на iOS — Universal Link открывает приложение, иначе кнопка App Store и подсказка «скопируйте ссылку и откройте после установки»), `/.well-known/apple-app-site-association` (`applinks` для `/join/*`, `webcredentials`) — отдаётся с `Content-Type: application/json` без редиректов.
- `api.lakonik.app` — кастомный домен Railway для `api` (`BASE_URL` в переменных, `API_BASE_URL` в сборке iOS, `trustedOrigins`).
- Почта: домен `lakonik.app` в Resend (SPF/DKIM), `EMAIL_FROM = Lakonik <noreply@lakonik.app>`, письма: код входа, приглашение в организацию, «отчёт готов» (если включено). `support@lakonik.app` — переадресация на почту владельца (Resend не принимает входящие).
- Черновики privacy/terms готовит агент (русский + английская версия для ревью): обработчики данных — ElevenLabs (аудио, удаляется после расшифровки), Anthropic (текст, без обучения), Railway (Амстердам), Resend, Apple; хранение транскриптов и отчётов до удаления пользователем; удаление аккаунта; подписки и fair use; возраст 16+.

## 12. Аналитика и ошибки

- **Amplitude** (`src/analytics/amplitude.ts`, HTTP API v2 с сервера, `user_id` = userId, без email): `signup`, `login`, `workspace_selected {kind}`, `organization_created`, `invite_link_shared`, `invite_accepted {via: link|email|domain}`, `recording_started {source, tier}`, `recording_finished {durationSec}`, `transcript_ready`, `report_ready {template, model}`, `speakers_confirmed`, `task_done`, `paywall_shown {reason}`, `subscription_started {tier, period, trial}`, `subscription_renewed`, `subscription_cancelled`, `quota_hit {code}`, `account_deleted`. Ключ — `AMPLITUDE_API_KEY`, без ключа события только в лог.
- **Sentry**: `@sentry/node` в api и worker (`SENTRY_DSN`, теги `meetingId`, `organizationId`, `step`; тексты транскриптов и отчётов в события не попадают), `sentry-cocoa` в iOS (крэши, символикация через upload dSYM в архиве). Без DSN — выключено.

## 13. Миграция ADV (скрипт `scripts/migrate-organizations.ts`, одна транзакция, перед запуском — бэкап Postgres)

1. Создать организацию `ADV Kazakhstan` (`kind = team`, `plan = enterprise`, `planSeats = 100`, `planUntil = 2026-12-31`, `allowDomainJoin = true`, `settings.deadlines` из `settings('global')`, `settings.keyterms` = объединение `agencies.keyterms`), домены = объединение `agencies.emailDomains` (`verified = true`).
2. Участники: все пользователи → `member`; `holding_admin` и `agency_admin` → `admin`; владелец продукта (аккаунт, указанный при запуске `--owner <email>`) → `owner`.
3. Каждому пользователю — личная организация (`kind = personal`, owner).
4. `meetings`, `people`, `tasks`, `usage_events` → `organizationId = ADV`; `shares` не трогаем.
5. Двенадцать шаблонов ADV (`meeting_templates` с `group in internal|client|vendor|hr`) → `organizationId = ADV`, `unclassified` остаётся встроенным; встроенный каталог (раздел 7) сидится штатным `seed.ts`.
6. Проверки после миграции: число встреч/задач/людей совпало, у каждого пользователя ровно одна личная организация, ни одной строки с `organizationId = null` в скоупированных таблицах; затем миграция схемы удаляет `agencies`, `settings`, `user.agencyId`, `user.role`.
7. Пользователям ADV — одно сообщение: приложение теперь называется Lakonik, ваши встречи в организации «ADV Kazakhstan», новые сотрудники вступают сами с корпоративной почты.

## 14. Фазы и критерии приёмки

| Фаза | Содержание | Приёмка |
|---|---|---|
| **0. Бренд и фундамент** (2–3 дня) | переименование (раздел 3), домены и DNS, String Catalog, Sentry + Amplitude, статический сайт с privacy/terms/support/AASA | билд TestFlight с именем Lakonik; `curl https://api.lakonik.app/health`; AASA валиден (Apple CDN); в UI и письмах нет слова ADV |
| **1. Организации** (1.5–2 недели) | схема + миграции, плагин organization, скоуп `X-Organization-Id`, все маршруты раздела 6, онбординг, переключатель, карточка организации, приглашения (ссылка, email, домен), Universal Links, перенос сроков/словаря в организацию, удаление участника с передачей, `DELETE /me`, Google-вход, скрипт миграции ADV (прогнан на копии прод-базы) | vitest: членство, права, передача при удалении, домены/стоп-лист; e2e: два пользователя — создать организацию, вступить по ссылке, записать встречу в организации и в личном, поделиться, удалить участника с передачей, удалить аккаунт; миграция на копии прода без ошибок и с совпавшими счётчиками |
| **2. Подписки и квоты** (1–1.5 недели) | продукты в ASC, StoreKit 2, paywall, `billing/*`, уведомления Apple, квоты и 402, авто-стоп по лимиту, модели по уровню, Enterprise-карточка, `admin.ts` | Sandbox-тестер: покупка Pro с триалом, апгрейд до Безлимита, отмена, восстановление на втором устройстве; Free упирается в 5 мин и 6-ю запись за день; enterprise-организация не видит paywall; уведомления Apple меняют статус в БД |
| **3. Интеграции Meet/Zoom** (1 неделя; заявки на верификацию Google и ревью Zoom — в фазе 0) | таблица `integrations`, OAuth-подключение из iOS, крон обнаружения записей Meet, импорт из Drive с ffmpeg, участники/транскрипт Meet как подсказки спикерам, вебхук Zoom, экран Интеграции, квоты на авто-импорт | тестовая встреча Meet с записью в Workspace владельца → через ≤10 минут после появления файла встреча с отчётом в приложении, спикеры названы по участникам Meet; Zoom — то же по вебхуку; повторный запуск крона не создаёт дублей |
| **4. Каталог и полировка** (3–5 дней) | 11 встроенных шаблонов, прогон каждого через e2e с реальными провайдерами, экран Поддержки, статус `transcribed`, пустые состояния, тексты | у каждого встроенного шаблона отчёт со всеми разделами на тестовой записи; чек-лист раздела 15 закрыт |
| **5. Релиз** (неделя с ревью) | миграция прод-базы, App Store-запись (раздел 15), сборка с расширением трансляции (после создания App Group), отправка на ревью, ответы на вопросы ревью | приложение в App Store; ADV пользуется как организацией; Amplitude показывает воронку |

## 15. Чек-лист App Store

- Запись: имя Lakonik, подзаголовок, категория Business (вторичная Productivity), возраст 4+, ключевые слова (протокол встречи, транскрипция, диктофон, саммари, задачи), скриншоты из `docs/marketing/screenshots` (обновить под новые экраны), промо-текст, URL политики и поддержки на `lakonik.app`.
- Privacy Nutrition Labels: Contact Info (email — для аккаунта), User Content (аудио, транскрипты — для функций приложения), Identifiers (user ID), Usage Data (аналитика продукта), Diagnostics (крэши); всё «linked to user», не для трекинга (ATT не нужен — SDK трекинга нет).
- Sign in with Apple при наличии Google — есть; удаление аккаунта в приложении — есть; ссылки на условия и политику на paywall; «Восстановить покупки».
- Подписки: продукты со скриншотом paywall для ревью, локализованные названия и описания, intro offer; Paid Apps Agreement, банк, налоги — заполнены владельцем.
- Заметки для ревью: демо-аккаунт (email + отключённый OTP для него на сервере через `REVIEW_ACCOUNTS`) с готовой встречей и отчётом; объяснение фоновой записи (`UIBackgroundModes audio`) и расширения трансляции (звук онлайн-встреч); Enterprise-карточка — только контакт, покупка в приложении доступна как IAP.
- Экспорт-компляенс: только HTTPS → `ITSAppUsesNonExemptEncryption = false`.
- Тексты разрешений (`NSMicrophoneUsageDescription` и др.) без упоминания ADV.

## 16. Открытые вопросы и риски

- **Права на код**: приложение писалось как проект для ADV — владельцу подтвердить по договору право выпуска как своего продукта (юрист). Шаблоны ADV остаются приватными в их организации именно поэтому.
- **Локализация данных (РК)**: закон о персональных данных требует хранить базы с данными граждан РК в Казахстане; сервер в Амстердаме. Консультация юриста; технический выход — self-hosted режим (раздел 17) или перенос Postgres/bucket в KZ-хостинг без изменения кода.
- **ADV и «свой сервер»**: уточнить у ADV, нужно ли им только хранение у себя (обработка через ElevenLabs/Anthropic по API) или отказ от внешних API вообще (on-prem STT/LLM — другой проект, хуже качество казахского и диаризации).
- **Себестоимость**: ~$0.45 за час; Безлимит окупается только с fair use 40 ч; при росте — договорной тариф ElevenLabs.
- **App Group** `group.kz.adv.meetings` — создать в Apple Developer (владелец), иначе сборка без расширения трансляции (`project-lite.yml`).
- **Аккаунт Apple**: конвертация Individual → Organization на ИП по D-U-N-S — по желанию, через Developer Support; на код не влияет.
- **Действия владельца вне кода**: Paid Apps Agreement + банк/налоги, заявка Small Business Program, OAuth client Google для iOS, проект Google Cloud с OAuth consent screen (Meet API + Drive) и заявка на верификацию, приложение Zoom Marketplace и заявка на ревью, DNS `lakonik.app` (Vercel) и `api.lakonik.app` (Railway), проекты Sentry/Amplitude (DSN/ключ в Railway), переадресация `support@lakonik.app`, домен в Resend, подтверждение текстов privacy/terms.

## 17. Следующие этапы (после 1.0)

- **Self-hosted для организаций** (первым — ADV): режим `SELF_HOSTED=true` (одна организация на сервере, без IAP, план по лицензии — подписанный JWT владельца с местами и сроком), `docker-compose` (api, worker, postgres, minio, caddy/TLS), образ в GHCR, push-relay на `api.lakonik.app` (сервер организации шлёт только device token и тип уведомления, relay — в APNs), в приложении — «Сервер организации» на входе и сессия на каждый сервер (переключатель пространств объединяет SaaS и self-hosted), экспорт организации с SaaS в их базу. Требования к серверу ADV: Ubuntu 24.04, Docker, 4 vCPU / 8 ГБ / 100 ГБ SSD, публичный DNS + TLS, исходящий HTTPS к ElevenLabs/Anthropic/Apple/Google/SMTP/relay, их ключи ElevenLabs и Anthropic, ночной `pg_dump`.
- **Бот-участник для онлайн-встреч** (1.x): сервис-пул ботов на базе открытого Attendee (Meet, Zoom через Meeting SDK, Teams) или Vexa — headless Chromium в контейнере, звук из WebRTC/виртуальной звуковой карты, активный спикер из DOM, вход гостем «Lakonik» через «попросить войти»; по контейнеру на встречу (~1 vCPU, 1–2 ГБ). Себестоимость — центы за час; риск — правки при изменении вёрстки Meet. Recall.ai — аварийная замена, если поддержка своего бота окажется дороже. Часы бота — в общей квоте, только Pro и выше.
- **Веб**: задачи и встречи в браузере, админка организации (участники, шаблоны, план, счётчики), оплата организаций по счёту/локальному шлюзу, IAP командные ступени при необходимости.
- **Английский интерфейс** (перевод String Catalog + App Store), затем казахский.
- **Android** — по решению владельца, тот же API.
