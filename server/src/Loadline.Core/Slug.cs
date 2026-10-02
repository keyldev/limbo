using System.Security.Cryptography;

namespace Loadline.Core;

/// <summary>Короткие идентификаторы для ссылок вида /d/{slug}.</summary>
public static class Slug
{
    private const string Alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    /// <summary>Случайный slug из base62. 62^10 ≈ 8·10^17 вариантов.</summary>
    public static string New(int length = Limits.SlugLength)
    {
        ArgumentOutOfRangeException.ThrowIfLessThan(length, 6);
        return RandomNumberGenerator.GetString(Alphabet, length);
    }

    public static bool IsValid(string? value) =>
        value is { Length: Limits.SlugLength } && value.All(c => Alphabet.Contains(c, StringComparison.Ordinal));
}
