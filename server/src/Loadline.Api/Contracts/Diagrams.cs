using System.Text.Json;

namespace Loadline.Api.Contracts;

/// <summary>Ответ на создание или форк схемы. editToken показывается один раз.</summary>
public sealed record CreateDiagramResponse(string Slug, string EditToken, int Version);

/// <summary>Сохранённая схема.</summary>
public sealed record DiagramResponse(
    string Slug,
    int Version,
    JsonElement Doc,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);
