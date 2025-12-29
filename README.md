# Keenetic Geosite Sync

[![GitHub Release](https://img.shields.io/github/release/yangirov/keenetic-geosite-sync?style=flat&color=green)](https://github.com/yangirov/keenetic-geosite-sync/releases)

> [!IMPORTANT]
> Материал носит исключительно информационный и учебный характер.
> Любое иное использование выходит за рамки ознакомления и может противоречить действующему законодательству.
> Автор не отвечает за последствия применения описанных подходов.

> [!WARNING]
> **Все действия вы выполняете на свой страх и риск.**
>
> Автор не несет ответственности за возможный ущерб оборудованию, программному обеспечению,
> ограничения доступа, а также иные побочные эффекты.
> Предполагается, что вы осознаёте возможные риски и понимаете, что делаете.

Скрипт для Keenetic OS 5, который обновляет списки доменов и правила маршрутизации из "Маршруты DNS" по базе [v2fly/domain-list-community](https://github.com/v2fly/domain-list-community).

## Что делает
- читает текущую конфигурацию и ищет группы доменов с нужным префиксом
- превращает описание группы в имя файла из v2fly (`Facebook [1/2]` → `facebook`, `Google Play` → `google-play`)
- тянет `data/<name>`, раскрывает `include:`, игнорирует пустые/`keyword:`/`regexp:` правила
- пересобирает группы доменов; при превышении лимита режет на части `<name>`, `<name>-2`, `<name>-3` и т.д.
- сохраняет состояние маршрутов (`auto`/`reject`/`disable`) и переносит его на новые части сплита

## Конфиг `config.json`

Ключи:
- `baseUrl` — источник доменных листов.
- `prefix` — префикс для поиска групп доменов в конфиге (`domain-list` по умолчанию).
- `timeoutMs`, `retries` — таймаут в миллисекундах и количество попыток загрузки.
- `maxEntriesPerGroup` — максимум доменов в группе; при превышении создаются `<name>-2`, `<name>-3` и т.д. По умолчанию 300.
- `routeInterface` — интерфейс, через который будут идти маршруты. Например, `Wireguard0` (можно узнать через команду `show interface` в CLI `http://<router_id>/a`).
- `initialDomains` — если групп с нужным префиксом нет, создадутся новые группы с описанием из списка и маршрутом (если задан интерфейс).
- `dryRun` — только логирует команды `ndmc`, без применения.

Пример:
```json
{
  "baseUrl": "https://raw.githubusercontent.com/v2fly/domain-list-community/master/data/",
  "prefix": "domain-list",
  "timeoutMs": 20000,
  "retries": 3,
  "maxEntriesPerGroup": 300,
  "routeInterface": "Wireguard0",
  "initialDomains": [
    "Facebook",
    "Google Play",
    "Instagram",
    "JetBrains",
    "Linkedin",
    "OpenAI",
    "SoundCloud",
    "Spotify",
    "Telegram",
    "Twitter",
    "WhatsApp",
    "YouTube"
  ],
  "dryRun": false
}
```

## Быстрый старт

### Шаг 1. Создайте в разделе "Маршруты DNS" список доменов которые нужно синхронизировать

Раздел: `http://192.168.1.1/staticRoutes/dns`

![](./assets/initial.png)

### Шаг 2. Установка на роутере

Ниже два варианта: автоматический (рекомендуемый) через OPKG-репозиторий и ручной (если хотите поставить zip вручную).

#### Автоматическая установка через публичный OPKG-репозиторий (Entware)

Репозиторий: `https://yangirov.github.io/keenetic-geosite-sync/all`  
Поддерживаемые архитектуры: mipsel, mips, mips64, aarch64, armv7, x86, x86_64, lexra.

```bash
# Подключение к роутеру
ssh root@192.168.1.1 -p 222

# Зависимости для HTTPS-загрузки
opkg update
opkg install ca-certificates wget-ssl
opkg remove wget-nossl 2>/dev/null || true

# Подключаем репозиторий
mkdir -p /opt/etc/opkg
echo "src/gz kgs https://yangirov.github.io/keenetic-geosite-sync/all" > /opt/etc/opkg/kgs.conf

# Установка пакета
opkg update
opkg install keenetic-geosite-sync
```

После установки файлы окажутся в `/opt/keenetic-geosite-sync`, конфиг — `/opt/keenetic-geosite-sync/config.json`.

<details>
<summary>Ручная установка</summary>

```bash
# Подключение к роутеру по SSH
ssh root@192.168.1.1 -p 222

# Установка зависимостей
opkg update
opkg install curl unzip node cron

# Скачивание и установка релиза
cd /opt && curl -L https://github.com/yangirov/keenetic-geosite-sync/releases/latest/download/keenetic-geosite-sync-dist.zip -o /tmp/kgs.zip && mkdir -p /opt/keenetic-geosite-sync && unzip -o /tmp/kgs.zip -d /opt/keenetic-geosite-sync && rm /tmp/kgs.zip
```

Далее создайте сервисы вручную:

```bash
# Создание загрузочного скрипта
mkdir -p /opt/scripts
cp /opt/keenetic-geosite-sync/scripts/geosite-sync.sh /opt/scripts/geosite-sync.sh
chmod +x /opt/scripts/geosite-sync.sh

# Создание сервиса Entware
cp /opt/keenetic-geosite-sync/scripts/S99geosite-sync /opt/etc/init.d/S99geosite-sync
chmod +x /opt/etc/init.d/S99geosite-sync

# Запуск сервиса
/opt/etc/init.d/S99geosite-sync start

# Остановка сервиса
/opt/etc/init.d/S99geosite-sync stop

# Перезапуск сервиса
/opt/etc/init.d/S99geosite-sync restart

# Логи сервиса
/opt/etc/init.d/S99geosite-sync logs
```

Для проверки без изменений поставьте в конфиге `"dryRun": true`.

Конфиг находится в `/opt/keenetic-geosite-sync/config.json` — отредактируйте его перед запуском.
</details>

![](./assets/rules.png)

### API сервиса (порт 3939)

HTTP-сервер поднимается автоматически при старте приложения и слушает порт `3939`.
Автосинхронизации при старте нет — дерните `/sync` вручную или настройте cron.

- `/sync` — GET/POST. Запускает синхронизацию. `429`, если уже выполняется; `500` при ошибке.
- `/clean` — GET/POST. Удаляет все группы/маршруты с префиксом из `config.json`.
- `/health` — GET. Просто отвечает `200 OK`.

Примеры:

```bash
curl http://192.168.1.1:3939/health
curl http://192.168.1.1:3939/sync
curl http://192.168.1.1:3939/clean
```

## Автокомплит доменов в веб-интерфейсе Keenetic OS

Для удобного заполнения списков доменов можно поставить юзерскрипт Tampermonkey `scripts/tampermonkey.js`.

1. Установите расширение [Tampermonkey](https://www.tampermonkey.net/).
2. Создайте новый скрипт и вставьте содержимое `scripts/tampermonkey.js`.
3. Откройте страницу `http://192.168.1.1/staticRoutes/dns` — появится автодополнение по именам из `v2fly/domain-list-community`.

![](./assets/autocomplete.gif)

## Синхронизация по расписанию

Пример настройки раз в неделю, по субботам в 04:00:

```bash
opkg update
opkg install cron

echo '0 4 * * 6 curl -s http://127.0.0.1:3939/sync' >> /opt/etc/crontab

/opt/etc/init.d/S10cron restart 2>/dev/null || true
```

## Сборка OPKG пакета

Сборка пакета выполняется в GitHub Actions (`.github/workflows/publish.yml`) при пуше тега. Итоговые ipk публикуются в `https://yangirov.github.io/keenetic-geosite-sync/all` вместе с `Packages/Packages.gz`.

Также можно собрать через Docker (для тестирования):

```bash
docker run --rm -it -v "$PWD":/src -w /src node:20-bookworm bash -lc "apt-get update && apt-get install -y ca-certificates && chmod +x opkg/build.sh && ./opkg/build.sh"
```
