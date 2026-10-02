using System.Text.Json;
using System.Text.Json.Nodes;
using Json.Schema;

namespace Loadline.Core;

/// <summary>
/// Проверяет документ схемы по spec/loadline.schema.json.
/// Сервер не разбирает граф: схема валидна — значит, её можно хранить.
/// </summary>
public sealed class DiagramValidator
{
    private readonly JsonSchema _schema;

    public DiagramValidator()
    {
        using var stream = typeof(DiagramValidator).Assembly.GetManifestResourceStream("Loadline.Core.loadline.schema.json")
            ?? throw new InvalidOperationException("Не найден встроенный ресурс loadline.schema.json");
        using var reader = new StreamReader(stream);
        _schema = JsonSchema.FromText(reader.ReadToEnd());
    }

    /// <summary>Пустой словарь — документ валиден. Иначе путь в документе → ошибки.</summary>
    public IReadOnlyDictionary<string, string[]> Validate(JsonElement document)
    {
        var node = JsonNode.Parse(document.GetRawText());
        var result = _schema.Evaluate(node, new EvaluationOptions { OutputFormat = OutputFormat.List });
        if (result.IsValid)
        {
            return new Dictionary<string, string[]>();
        }

        return (result.Details ?? [])
            .Where(d => d.Errors is { Count: > 0 })
            .GroupBy(d => string.IsNullOrEmpty(d.InstanceLocation.ToString()) ? "/" : d.InstanceLocation.ToString())
            .ToDictionary(g => g.Key, g => g.SelectMany(d => d.Errors!.Values).Distinct().ToArray());
    }
}
