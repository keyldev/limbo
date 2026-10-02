# Loadline

Доска, на которой архитектуру рисуют и сразу прогоняют под нагрузкой: draw.io, который умеет считать.

Стек: Angular 22 на клиенте, .NET 10 на сервере. Движок симуляции работает в браузере, сервер хранит схемы и раздаёт короткие ссылки. Подробности — в плане развития v2 и в `docs/`.

## Структура

```
loadline/
├─ spec/                     общий источник правды: JSON Schema, пресеты, эталонные сценарии
├─ web/                      pnpm workspace
│  ├─ packages/engine/       движок симуляции, чистый TS
│  ├─ packages/model/        типы, сгенерированные из JSON Schema
│  ├─ packages/api-client/   клиент API
│  └─ app/                   Angular 22
├─ server/                   решение .NET 10 (Loadline.slnx)
│  ├─ src/Loadline.Api/      Minimal API
│  ├─ src/Loadline.Core/     валидация схем, slug, токены
│  ├─ src/Loadline.Data/     EF Core 10 + PostgreSQL
│  ├─ src/Loadline.AppHost/  Aspire: Postgres + API одной командой
│  └─ tests/                 xUnit v3, Testcontainers
├─ docs/                     «Как считаем», ADR
├─ deploy/                   Dockerfile, compose, Caddy, бэкапы
└─ .github/workflows/        CI
```

## Что нужно

- Node.js 24.15+ и pnpm 10 (`corepack enable`)
- .NET SDK 10
- Docker (для Postgres через Aspire и для интеграционных тестов)

## Запуск

```powershell
# 1. Фронт и движок
cd web
pnpm install
pnpm build          # model → engine → api-client → app
pnpm test           # тесты движка (golden + свойства) и приложения
pnpm start          # http://localhost:4200

# 2. Сервер (в другом терминале)
cd server
dotnet run --project src/Loadline.AppHost   # Postgres в Docker + API на :5080
```

Фронт работает и без сервера: симуляция идёт в браузере. Запросы `/api` dev-сервер Angular проксирует на `localhost:5080`.

Без Aspire: поднимите Postgres сами (`loadline/loadline`, база `loadline`) и запустите `dotnet run --project src/Loadline.Api`.

## Первая миграция

Пока миграций нет, API в режиме Development создаёт таблицы через `EnsureCreated`. Перед первым деплоем:

```powershell
dotnet tool install --global dotnet-ef
cd server
dotnet ef migrations add Initial -p src/Loadline.Data -s src/Loadline.Data
```

После этого API в Development применяет миграции сам, а в проде их нужно применять отдельным шагом деплоя.

## Генерация кода

| Команда | Что делает |
| --- | --- |
| `pnpm gen:model` | Типы TS из `spec/loadline.schema.json` |
| `dotnet build` в `server/` | OpenAPI 3.1 в `server/src/Loadline.Api/openapi/` |
| `pnpm gen:api` | Типы клиента из OpenAPI (после первой сборки сервера) |

Сгенерированное не правится руками, CI сверяет его с исходниками.

## Состояние скелета

Проверено при сборке скелета:

- `pnpm build` и `pnpm test`: движок собран, 13 тестов движка и тест приложения зелёные.

Не проверено, потому что в среде сборки не было .NET SDK и доступа к NuGet:

- Сервер не компилировался. Версии пакетов в `server/Directory.Packages.props` плавающие в пределах мажорной; после первого `dotnet restore` зафиксируйте точные.
- Первая сборка может потребовать мелких правок. Самые вероятные места: API `JsonSchema.Net` в `DiagramValidator`, SDK Aspire в `Loadline.AppHost.csproj`.

## Лицензия

MIT. Выбор между MIT и Apache-2.0 — открытый вопрос плана; смена лицензии сейчас — замена одного файла.
