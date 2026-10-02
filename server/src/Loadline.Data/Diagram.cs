namespace Loadline.Data;

/// <summary>Сохранённая анонимная схема. Сам документ лежит целиком в jsonb.</summary>
public sealed class Diagram
{
    public Guid Id { get; set; }

    /// <summary>10 символов base62, часть короткой ссылки.</summary>
    public required string Slug { get; set; }

    /// <summary>Документ .loadline.json как есть.</summary>
    public required string Doc { get; set; }

    /// <summary>SHA-256 от токена редактирования. Сам токен не храним.</summary>
    public required byte[] EditTokenHash { get; set; }

    /// <summary>Растёт на каждое обновление: ETag и оптимистичная блокировка.</summary>
    public int Version { get; set; } = 1;

    public int SizeBytes { get; set; }

    public DateTimeOffset CreatedAt { get; set; }

    public DateTimeOffset UpdatedAt { get; set; }

    public DateTimeOffset LastViewedAt { get; set; }
}
