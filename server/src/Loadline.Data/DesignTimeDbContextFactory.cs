using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Loadline.Data;

/// <summary>
/// Нужна только инструменту dotnet ef для миграций:
///   dotnet ef migrations add Initial -p src/Loadline.Data -s src/Loadline.Data
/// </summary>
public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<LoadlineDbContext>
{
    public LoadlineDbContext CreateDbContext(string[] args)
    {
        var connection = Environment.GetEnvironmentVariable("ConnectionStrings__loadline")
            ?? "Host=localhost;Port=5432;Database=loadline;Username=loadline;Password=loadline";
        var options = new DbContextOptionsBuilder<LoadlineDbContext>().UseNpgsql(connection).Options;
        return new LoadlineDbContext(options);
    }
}
