using System.Text;
using System.Text.Json;
using Loadline.Api.Contracts;
using Loadline.Core;
using Loadline.Data;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Loadline.Api.Endpoints;

public static class DiagramEndpoints
{
    public const string WritePolicy = "writes";
    private const string TokenHeader = "X-Edit-Token";

    public static IEndpointRouteBuilder MapDiagramEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/v1/diagrams").WithTags("Diagrams");

        group.MapPost("/", Create)
            .WithName("CreateDiagram")
            .WithSummary("Сохранить схему и получить короткую ссылку")
            .RequireRateLimiting(WritePolicy);

        group.MapGet("/{slug}", Get)
            .WithName("GetDiagram")
            .WithSummary("Получить схему по slug");

        group.MapPut("/{slug}", Update)
            .WithName("UpdateDiagram")
            .WithSummary("Обновить схему (нужны X-Edit-Token и If-Match)")
            .RequireRateLimiting(WritePolicy);

        group.MapDelete("/{slug}", Delete)
            .WithName("DeleteDiagram")
            .WithSummary("Удалить схему (нужен X-Edit-Token)")
            .RequireRateLimiting(WritePolicy);

        group.MapPost("/{slug}/fork", Fork)
            .WithName("ForkDiagram")
            .WithSummary("Скопировать схему под новым slug")
            .RequireRateLimiting(WritePolicy);

        return app;
    }

    private static async Task<Results<Created<CreateDiagramResponse>, ValidationProblem>> Create(
        [FromBody] JsonElement doc,
        DiagramValidator validator,
        LoadlineDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        var errors = validator.Validate(doc);
        if (errors.Count > 0)
        {
            return TypedResults.ValidationProblem(errors, title: "Схема не прошла проверку");
        }

        var (diagram, token) = await InsertAsync(doc.GetRawText(), db, clock, ct);
        return TypedResults.Created($"/api/v1/diagrams/{diagram.Slug}", new CreateDiagramResponse(diagram.Slug, token, diagram.Version));
    }

    private static async Task<Results<Ok<DiagramResponse>, NotFound>> Get(
        string slug,
        LoadlineDbContext db,
        TimeProvider clock,
        HttpContext http,
        CancellationToken ct)
    {
        if (!Slug.IsValid(slug))
        {
            return TypedResults.NotFound();
        }

        var diagram = await db.Diagrams.AsNoTracking().FirstOrDefaultAsync(x => x.Slug == slug, ct);
        if (diagram is null)
        {
            return TypedResults.NotFound();
        }

        // Отметка просмотра нужна для очистки давно не открытых схем.
        var now = clock.GetUtcNow();
        await db.Diagrams.Where(x => x.Id == diagram.Id)
            .ExecuteUpdateAsync(s => s.SetProperty(x => x.LastViewedAt, now), ct);

        http.Response.Headers.ETag = $"\"{diagram.Version}\"";
        return TypedResults.Ok(ToResponse(diagram));
    }

    private static async Task<Results<Ok<DiagramResponse>, NotFound, ProblemHttpResult, ValidationProblem>> Update(
        string slug,
        [FromBody] JsonElement doc,
        [FromHeader(Name = TokenHeader)] string? editToken,
        [FromHeader(Name = "If-Match")] string? ifMatch,
        DiagramValidator validator,
        LoadlineDbContext db,
        TimeProvider clock,
        HttpContext http,
        CancellationToken ct)
    {
        var diagram = Slug.IsValid(slug) ? await db.Diagrams.FirstOrDefaultAsync(x => x.Slug == slug, ct) : null;
        if (diagram is null)
        {
            return TypedResults.NotFound();
        }

        if (!EditToken.Verify(editToken, diagram.EditTokenHash))
        {
            return InvalidToken();
        }

        if (string.IsNullOrEmpty(ifMatch))
        {
            return TypedResults.Problem("Нужен заголовок If-Match с версией схемы", statusCode: StatusCodes.Status428PreconditionRequired);
        }

        if (ifMatch.Trim('"') != diagram.Version.ToString(System.Globalization.CultureInfo.InvariantCulture))
        {
            return TypedResults.Problem("Схему уже изменили. Обновите её и повторите", statusCode: StatusCodes.Status412PreconditionFailed);
        }

        var errors = validator.Validate(doc);
        if (errors.Count > 0)
        {
            return TypedResults.ValidationProblem(errors, title: "Схема не прошла проверку");
        }

        var raw = doc.GetRawText();
        diagram.Doc = raw;
        diagram.SizeBytes = Encoding.UTF8.GetByteCount(raw);
        diagram.Version += 1;
        diagram.UpdatedAt = clock.GetUtcNow();

        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateConcurrencyException)
        {
            return TypedResults.Problem("Схему уже изменили. Обновите её и повторите", statusCode: StatusCodes.Status412PreconditionFailed);
        }

        http.Response.Headers.ETag = $"\"{diagram.Version}\"";
        return TypedResults.Ok(ToResponse(diagram));
    }

    private static async Task<Results<NoContent, NotFound, ProblemHttpResult>> Delete(
        string slug,
        [FromHeader(Name = TokenHeader)] string? editToken,
        LoadlineDbContext db,
        CancellationToken ct)
    {
        var diagram = Slug.IsValid(slug) ? await db.Diagrams.FirstOrDefaultAsync(x => x.Slug == slug, ct) : null;
        if (diagram is null)
        {
            return TypedResults.NotFound();
        }

        if (!EditToken.Verify(editToken, diagram.EditTokenHash))
        {
            return InvalidToken();
        }

        db.Diagrams.Remove(diagram);
        await db.SaveChangesAsync(ct);
        return TypedResults.NoContent();
    }

    private static async Task<Results<Created<CreateDiagramResponse>, NotFound>> Fork(
        string slug,
        LoadlineDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        var source = Slug.IsValid(slug)
            ? await db.Diagrams.AsNoTracking().FirstOrDefaultAsync(x => x.Slug == slug, ct)
            : null;
        if (source is null)
        {
            return TypedResults.NotFound();
        }

        var (diagram, token) = await InsertAsync(source.Doc, db, clock, ct);
        return TypedResults.Created($"/api/v1/diagrams/{diagram.Slug}", new CreateDiagramResponse(diagram.Slug, token, diagram.Version));
    }

    private static async Task<(Diagram Diagram, string Token)> InsertAsync(
        string raw,
        LoadlineDbContext db,
        TimeProvider clock,
        CancellationToken ct)
    {
        var now = clock.GetUtcNow();
        var (token, hash) = EditToken.Create();

        // Коллизия slug почти невозможна, но уникальный индекс всё равно страхует: пробуем ещё раз.
        for (var attempt = 0; ; attempt++)
        {
            var diagram = new Diagram
            {
                Id = Guid.CreateVersion7(),
                Slug = Slug.New(),
                Doc = raw,
                EditTokenHash = hash,
                SizeBytes = Encoding.UTF8.GetByteCount(raw),
                CreatedAt = now,
                UpdatedAt = now,
                LastViewedAt = now,
            };
            db.Diagrams.Add(diagram);
            try
            {
                await db.SaveChangesAsync(ct);
                return (diagram, token);
            }
            catch (DbUpdateException) when (attempt < 3)
            {
                db.Entry(diagram).State = EntityState.Detached;
            }
        }
    }

    // Без схемы аутентификации Forbid() бросает исключение, поэтому 403 отдаём как ProblemDetails.
    private static ProblemHttpResult InvalidToken() =>
        TypedResults.Problem("Неверный или отсутствующий токен редактирования", statusCode: StatusCodes.Status403Forbidden);

    private static DiagramResponse ToResponse(Diagram d)
    {
        using var json = JsonDocument.Parse(d.Doc);
        return new DiagramResponse(d.Slug, d.Version, json.RootElement.Clone(), d.CreatedAt, d.UpdatedAt);
    }
}
