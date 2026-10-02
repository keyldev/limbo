using System.Security.Cryptography;
using System.Text;

namespace Loadline.Core;

/// <summary>
/// Токен редактирования анонимной схемы. Клиент получает его один раз,
/// сервер хранит только SHA-256.
/// </summary>
public static class EditToken
{
    private const int TokenBytes = 32;

    /// <summary>Новый токен (base64url, 43 символа) и его хеш для базы.</summary>
    public static (string Token, byte[] Hash) Create()
    {
        var bytes = RandomNumberGenerator.GetBytes(TokenBytes);
        var token = Base64UrlEncode(bytes);
        return (token, Hash(token));
    }

    public static byte[] Hash(string token) => SHA256.HashData(Encoding.UTF8.GetBytes(token));

    /// <summary>Сравнение за постоянное время, чтобы не подсказывать токен по задержке ответа.</summary>
    public static bool Verify(string? token, byte[] expectedHash)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 128)
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(Hash(token), expectedHash);
    }

    private static string Base64UrlEncode(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
