using System.Text.Json;

namespace Loadline.Core.Tests;

public sealed class SlugTests
{
    [Fact]
    public void New_GeneratesValidUniqueSlugs()
    {
        var slugs = Enumerable.Range(0, 1000).Select(_ => Slug.New()).ToList();

        Assert.All(slugs, s => Assert.True(Slug.IsValid(s)));
        Assert.Equal(slugs.Count, slugs.Distinct().Count());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("short")]
    [InlineData("abc-def-gh")]
    [InlineData("../../etc/")]
    public void IsValid_RejectsMalformed(string? value) => Assert.False(Slug.IsValid(value));
}

public sealed class EditTokenTests
{
    [Fact]
    public void Verify_AcceptsOwnToken_RejectsOthers()
    {
        var (token, hash) = EditToken.Create();
        var (other, _) = EditToken.Create();

        Assert.True(EditToken.Verify(token, hash));
        Assert.False(EditToken.Verify(other, hash));
        Assert.False(EditToken.Verify(null, hash));
        Assert.False(EditToken.Verify(new string('a', 500), hash));
    }

    [Fact]
    public void Token_IsUrlSafe() =>
        Assert.Matches("^[A-Za-z0-9_-]{43}$", EditToken.Create().Token);
}

public sealed class DiagramValidatorTests
{
    private static readonly DiagramValidator Validator = new();

    public static TheoryData<string> Scenarios()
    {
        var data = new TheoryData<string>();
        foreach (var file in Directory.GetFiles(Path.Combine(AppContext.BaseDirectory, "scenarios"), "*.loadline.json"))
        {
            data.Add(Path.GetFileName(file));
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(Scenarios))]
    public void ReferenceScenarios_AreValid(string file)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "scenarios", file)));

        Assert.Empty(Validator.Validate(doc.RootElement));
    }

    [Theory]
    [InlineData("""{ "format": "drawio" }""")]
    [InlineData("""{ "format": "loadline", "version": 2, "traffic": { "rps": 1 }, "nodes": [], "edges": [] }""")]
    [InlineData("""{ "format": "loadline", "version": 1, "traffic": { "rps": -5 }, "nodes": [], "edges": [] }""")]
    [InlineData("""{ "format": "loadline", "version": 1, "traffic": { "rps": 1 }, "nodes": [ { "id": "a", "kind": "toaster", "pos": { "x": 0, "y": 0 } } ], "edges": [] }""")]
    [InlineData("""{ "format": "loadline", "version": 1, "traffic": { "rps": 1 }, "nodes": [], "edges": [], "extra": true }""")]
    public void InvalidDocuments_AreRejected(string json)
    {
        using var doc = JsonDocument.Parse(json);

        Assert.NotEmpty(Validator.Validate(doc.RootElement));
    }
}
