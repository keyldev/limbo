using System.Threading.RateLimiting;
using Loadline.Api.Endpoints;
using Loadline.Core;
using Loadline.Data;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// Тело любого запроса не больше лимита документа: других больших запросов у API нет.
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = Limits.MaxDocumentBytes);

// Строка подключения: ConnectionStrings:loadline (Aspire подставляет её сам).
// Читается лениво, чтобы тесты могли подменить конфигурацию.
builder.Services.AddDbContext<LoadlineDbContext>((sp, o) => o.UseNpgsql(
    sp.GetRequiredService<IConfiguration>().GetConnectionString("loadline")
    ?? throw new InvalidOperationException("Не задана строка подключения ConnectionStrings:loadline")));
builder.Services.AddSingleton<DiagramValidator>();
builder.Services.AddSingleton(TimeProvider.System);

builder.Services.AddProblemDetails();
builder.Services.AddValidation();
builder.Services.AddOpenApi();

builder.Services.AddHealthChecks()
    .AddDbContextCheck<LoadlineDbContext>("database", tags: ["ready"]);

builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.AddPolicy(DiagramEndpoints.WritePolicy, http =>
        RateLimitPartition.GetFixedWindowLimiter(
            http.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = Limits.WritesPerMinutePerIp,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0,
            }));
});

// CORS только для своего фронта. Список — в Cors:Origins.
var origins = builder.Configuration.GetSection("Cors:Origins").Get<string[]>() ?? [];
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .WithOrigins(origins)
    .WithMethods("GET", "POST", "PUT", "DELETE")
    .WithHeaders("Content-Type", "X-Edit-Token", "If-Match")
    .WithExposedHeaders("ETag", "Location")));

builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    // За обратным прокси (Caddy) реальный IP клиента приходит в X-Forwarded-For.
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    o.KnownIPNetworks.Clear();
    o.KnownProxies.Clear();
});

var app = builder.Build();

app.UseForwardedHeaders();
app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseCors();
app.UseRateLimiter();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();

    // В разработке применяем миграции при старте. В проде — отдельным шагом деплоя:
    // сервис migrate в deploy/compose.yaml запускает EF bundle до старта API.
    await using var scope = app.Services.CreateAsyncScope();
    await scope.ServiceProvider.GetRequiredService<LoadlineDbContext>().Database.MigrateAsync();
}

app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false });
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = c => c.Tags.Contains("ready") });

app.MapDiagramEndpoints();

await app.RunAsync();
