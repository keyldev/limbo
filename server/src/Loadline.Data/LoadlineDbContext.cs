using Microsoft.EntityFrameworkCore;

namespace Loadline.Data;

public sealed class LoadlineDbContext(DbContextOptions<LoadlineDbContext> options) : DbContext(options)
{
    public DbSet<Diagram> Diagrams => Set<Diagram>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var d = modelBuilder.Entity<Diagram>();
        d.ToTable("diagrams");
        d.HasKey(x => x.Id);
        d.Property(x => x.Id).HasColumnName("id");
        d.Property(x => x.Slug).HasColumnName("slug").HasMaxLength(32).IsRequired();
        d.HasIndex(x => x.Slug).IsUnique();
        d.Property(x => x.Doc).HasColumnName("doc").HasColumnType("jsonb").IsRequired();
        d.Property(x => x.EditTokenHash).HasColumnName("edit_token_hash").IsRequired();
        d.Property(x => x.Version).HasColumnName("version").IsConcurrencyToken();
        d.Property(x => x.SizeBytes).HasColumnName("size_bytes");
        d.Property(x => x.CreatedAt).HasColumnName("created_at");
        d.Property(x => x.UpdatedAt).HasColumnName("updated_at");
        d.Property(x => x.LastViewedAt).HasColumnName("last_viewed_at");
        d.HasIndex(x => x.LastViewedAt);
    }
}
