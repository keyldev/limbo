using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Loadline.Data.Migrations
{
    /// <inheritdoc />
    public partial class Initial : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "diagrams",
                columns: table => new
                {
                    id = table.Column<Guid>(type: "uuid", nullable: false),
                    slug = table.Column<string>(type: "character varying(32)", maxLength: 32, nullable: false),
                    doc = table.Column<string>(type: "jsonb", nullable: false),
                    edit_token_hash = table.Column<byte[]>(type: "bytea", nullable: false),
                    version = table.Column<int>(type: "integer", nullable: false),
                    size_bytes = table.Column<int>(type: "integer", nullable: false),
                    created_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    updated_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false),
                    last_viewed_at = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_diagrams", x => x.id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_diagrams_last_viewed_at",
                table: "diagrams",
                column: "last_viewed_at");

            migrationBuilder.CreateIndex(
                name: "IX_diagrams_slug",
                table: "diagrams",
                column: "slug",
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "diagrams");
        }
    }
}
