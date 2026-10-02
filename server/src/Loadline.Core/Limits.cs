namespace Loadline.Core;

/// <summary>Лимиты MVP. Меняются здесь и в spec/loadline.schema.json синхронно.</summary>
public static class Limits
{
    /// <summary>Максимальный размер тела запроса со схемой, байт.</summary>
    public const int MaxDocumentBytes = 256 * 1024;

    /// <summary>Длина slug в короткой ссылке.</summary>
    public const int SlugLength = 10;

    /// <summary>Записей в минуту с одного IP.</summary>
    public const int WritesPerMinutePerIp = 30;
}
