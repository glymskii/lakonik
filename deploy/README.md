# Lakonik на сервере заказчика — установка

Всё приложение (API, обработка, база, хранилище) работает в контуре компании. Наружу открыт только HTTPS-порт.
Инструкция рассчитана на системного администратора; нужен доступ по SSH с правом `sudo`.

## 1. Требования к серверу

| Параметр | Минимум | Рекомендуется |
|---|---|---|
| ОС | Ubuntu 22.04/24.04 LTS (подойдёт любой Linux с Docker) | Ubuntu 24.04 LTS |
| CPU | 2 vCPU | 4 vCPU |
| RAM | 4 ГБ | 8 ГБ |
| Диск | 50 ГБ SSD | 100 ГБ SSD |
| Сеть | публичный IP или доступ из корпоративной сети, DNS-имя, открытые 80 и 443 | то же |

Диск расходуется в основном на базу (транскрипты и отчёты — килобайты на встречу) и бэкапы; аудио живёт на сервере
минуты — его удаляют сразу после расшифровки (≈20 МБ на час записи в пике).

Исходящий HTTPS нужен к: `api.elevenlabs.io`, `api.anthropic.com`, `appleid.apple.com`, `oauth2.googleapis.com`,
`api.resend.com` (или ваш SMTP), `ghcr.io` (обновления образа). Входящий — 80/443 с устройств сотрудников.

## 2. Установка

Проверено: комплект разворачивается «как есть» — миграции применяются, 12 шаблонов отчётов засеиваются,
API отвечает через HTTPS, обработчик и хранилище стартуют (прогон 22.09.2026).

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && newgrp docker

sudo mkdir -p /opt/lakonik && sudo chown $USER /opt/lakonik && cd /opt/lakonik
# файлы из этой папки: docker-compose.yml, Caddyfile, .env.example
cp .env.example .env
```

Заполните `.env`:

```bash
openssl rand -hex 32   # POSTGRES_PASSWORD
openssl rand -hex 32   # MINIO_ROOT_PASSWORD
openssl rand -hex 32   # BETTER_AUTH_SECRET
```

Ключи `ANTHROPIC_API_KEY` и `ELEVENLABS_API_KEY` заводятся на юрлицо ADV (биллинг ваш), `RESEND_API_KEY` —
для писем с кодом входа (или укажите корпоративный SMTP — скажите, и соберём сборку под него).

Доступ к приватному образу выдаётся разработчиком (логин и read-only токен GitHub Container Registry) — запросите до начала установки:

```bash
echo "<токен>" | docker login ghcr.io -u <логин> --password-stdin
docker compose --env-file .env up -d
docker compose logs -f api      # ждём «Миграции применены», «Шаблоны засеяны», «API запущен»
curl https://meetings.advgroup.kz/health
```

DNS-запись `meetings.advgroup.kz` → IP сервера должна существовать **до** первого запуска: Caddy по ней выпускает
сертификат Let's Encrypt. Свой сертификат — см. комментарий в `Caddyfile`.

## 3. Подключение мобильного приложения

В приложении: «Войти» → **Корпоративный вход** → код организации `ADV` → дальше обычный вход по коду с почты
`@advgroup.kz`. Код организации сопоставляется с адресом вашего сервера; чтобы это заработало, сообщите
разработчику итоговый домен. Личные аккаунты сотрудников (вкладка «Личный») к вашему серверу не обращаются.

## 4. Эксплуатация

```bash
docker compose ps                                  # состояние
docker compose logs -f api worker                  # логи (в них нет текста встреч)
docker compose pull && docker compose up -d        # обновление версии
docker compose down                                # остановка
```

Бэкап базы (транскрипты, отчёты, задачи, пользователи) — раз в сутки в `cron`:

```bash
0 3 * * * cd /opt/lakonik && docker compose exec -T postgres pg_dump -U lakonik lakonik | gzip > backups/lakonik-$(date +\%F).sql.gz && find backups -name '*.sql.gz' -mtime +30 -delete
```

Восстановление: `gunzip -c backups/lakonik-2026-09-22.sql.gz | docker compose exec -T postgres psql -U lakonik lakonik`.

## 5. Что уходит наружу

| Куда | Что | Зачем | Хранение на их стороне |
|---|---|---|---|
| ElevenLabs | аудиозапись встречи | расшифровка с разделением говорящих | не хранится, на моделях не обучаются |
| Anthropic | текст расшифровки | составление отчёта и подсказок по спикерам | не хранится, на моделях не обучаются |
| Resend / ваш SMTP | адрес почты и код входа | вход в приложение | письмо |
| Apple / Google | проверка токена входа | вход через Apple/Google | — |

Всё остальное — записи, расшифровки, отчёты, задачи, аккаунты — остаётся в вашей базе. Доступ к серверу и базе
только у ваших администраторов; у разработчика доступа нет, если вы его не выдадите.

Полностью без внешних API (локальные модели распознавания и генерации) — отдельный проект: нужен сервер с GPU,
качество казахского и разделения говорящих заметно падает.
