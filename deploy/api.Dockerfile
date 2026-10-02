# syntax=docker/dockerfile:1
# Образ API. Собирается из корня репозитория: docker build -f deploy/api.Dockerfile .
# Контекст — корень, потому что сборке нужна spec/loadline.schema.json.
# В образе два входа: API (по умолчанию) и ./efbundle — миграции базы (сервис migrate в compose.yaml).

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY spec/ spec/
COPY server/ server/
RUN dotnet restore server/src/Loadline.Api/Loadline.Api.csproj
RUN dotnet publish server/src/Loadline.Api/Loadline.Api.csproj -c Release -o /app --no-restore \
    -p:OpenApiGenerateDocumentsOnBuild=false

WORKDIR /src/server
RUN dotnet tool restore
RUN dotnet tool run dotnet-ef migrations bundle -p src/Loadline.Data -s src/Loadline.Data \
    --configuration Release -o /migrations/efbundle

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app .
COPY --from=build /migrations/efbundle ./efbundle
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "Loadline.Api.dll"]
