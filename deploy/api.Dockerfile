# syntax=docker/dockerfile:1
# Образ API. Собирается из корня репозитория: docker build -f deploy/api.Dockerfile .
# Контекст — корень, потому что сборке нужна spec/loadline.schema.json.

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY spec/ spec/
COPY server/ server/
RUN dotnet restore server/src/Loadline.Api/Loadline.Api.csproj
RUN dotnet publish server/src/Loadline.Api/Loadline.Api.csproj -c Release -o /app --no-restore \
    -p:OpenApiGenerateDocumentsOnBuild=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
USER $APP_UID
ENTRYPOINT ["dotnet", "Loadline.Api.dll"]
