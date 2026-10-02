using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Loadline.Data;

/// <summary>
/// Нужна инструменту dotnet ef и бандлу миграций (efbundle в образе API):
///   dotnet ef migrations add &lt;Имя&gt; -p src/Loadline.Data -s src/Loadline.Data -o Migrations
/// Строку подключения бандл берёт из ConnectionStrings__loadline.
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
