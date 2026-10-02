var builder = DistributedApplication.CreateBuilder(args);

var postgres = builder.AddPostgres("postgres")
    .WithDataVolume("loadline-pg")
    .WithLifetime(ContainerLifetime.Persistent);

var db = postgres.AddDatabase("loadline");

// Порт 5080 берётся из launchSettings.json API; на него смотрит прокси ng serve (web/app/proxy.conf.json).
builder.AddProject<Projects.Loadline_Api>("api")
    .WithReference(db)
    .WaitFor(db)
    .WithExternalHttpEndpoints();

await builder.Build().RunAsync();
