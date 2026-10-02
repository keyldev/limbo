using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace Loadline.Api.Tests;

public sealed class DiagramApiTests(ApiFactory factory) : IClassFixture<ApiFactory>
{
    private static readonly string Scenario =
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "scenarios", "url-shortener.loadline.json"));

    private sealed record Created(string Slug, string EditToken, int Version);

    private static StringContent Json(string body) => new(body, Encoding.UTF8, "application/json");

    private async Task<Created> CreateAsync(HttpClient client)
    {
        var res = await client.PostAsync("/api/v1/diagrams", Json(Scenario), TestContext.Current.CancellationToken);
        Assert.Equal(HttpStatusCode.Created, res.StatusCode);
        return (await res.Content.ReadFromJsonAsync<Created>(TestContext.Current.CancellationToken))!;
    }

    [Fact]
    public async Task Create_ThenGet_ReturnsSameDocumentWithEtag()
    {
        var client = factory.CreateClient();
        var created = await CreateAsync(client);

        var res = await client.GetAsync($"/api/v1/diagrams/{created.Slug}", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal("\"1\"", res.Headers.ETag?.Tag);
        using var body = JsonDocument.Parse(await res.Content.ReadAsStringAsync(TestContext.Current.CancellationToken));
        Assert.Equal("Сокращатель ссылок", body.RootElement.GetProperty("doc").GetProperty("meta").GetProperty("title").GetString());
    }

    [Fact]
    public async Task Create_InvalidDocument_Returns400()
    {
        var client = factory.CreateClient();

        var res = await client.PostAsync("/api/v1/diagrams", Json("""{ "format": "loadline", "version": 1 }"""), TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    [Fact]
    public async Task Update_RequiresTokenAndCurrentVersion()
    {
        var client = factory.CreateClient();
        var created = await CreateAsync(client);
        var url = $"/api/v1/diagrams/{created.Slug}";

        HttpRequestMessage Put(string? token, string? ifMatch)
        {
            var req = new HttpRequestMessage(HttpMethod.Put, url) { Content = Json(Scenario) };
            if (token is not null) req.Headers.Add("X-Edit-Token", token);
            if (ifMatch is not null) req.Headers.TryAddWithoutValidation("If-Match", ifMatch);
            return req;
        }

        var ct = TestContext.Current.CancellationToken;
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(Put("wrong", "\"1\""), ct)).StatusCode);
        Assert.Equal(HttpStatusCode.PreconditionRequired, (await client.SendAsync(Put(created.EditToken, null), ct)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(Put(created.EditToken, "\"1\""), ct)).StatusCode);
        Assert.Equal(HttpStatusCode.PreconditionFailed, (await client.SendAsync(Put(created.EditToken, "\"1\""), ct)).StatusCode);
    }

    [Fact]
    public async Task Fork_CreatesIndependentCopy_Delete_RemovesOriginal()
    {
        var client = factory.CreateClient();
        var ct = TestContext.Current.CancellationToken;
        var created = await CreateAsync(client);

        var forkRes = await client.PostAsync($"/api/v1/diagrams/{created.Slug}/fork", null, ct);
        Assert.Equal(HttpStatusCode.Created, forkRes.StatusCode);
        var fork = (await forkRes.Content.ReadFromJsonAsync<Created>(ct))!;
        Assert.NotEqual(created.Slug, fork.Slug);

        var del = new HttpRequestMessage(HttpMethod.Delete, $"/api/v1/diagrams/{created.Slug}");
        del.Headers.Add("X-Edit-Token", created.EditToken);
        Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(del, ct)).StatusCode);

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/v1/diagrams/{created.Slug}", ct)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"/api/v1/diagrams/{fork.Slug}", ct)).StatusCode);
    }

    [Fact]
    public async Task Health_IsUp()
    {
        var client = factory.CreateClient();
        var ct = TestContext.Current.CancellationToken;

        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health/live", ct)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health/ready", ct)).StatusCode);
    }
}
