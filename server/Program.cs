using System.IO.Compression;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.AspNetCore.StaticFiles;

var builder = WebApplication.CreateBuilder(args);

// App Service on Linux runs the app in a container and tells it which port to
// answer on. Without this the app listens on 5000 and the platform's health
// check never gets a reply, which shows up as "Application Error" with nothing
// in the log to explain it.
var port = Environment.GetEnvironmentVariable("PORT");
if (!string.IsNullOrWhiteSpace(port))
{
    builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
}

// App Service does not compress for you. The three.js build alone is 3.7 MB of
// JavaScript, so this is the difference between a fast first load and a slow
// one. The models (.glb) are already compact binary and compress badly, but
// they cost nothing to include.
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
    options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(
    [
        "application/javascript",
        "text/javascript",
        "application/json",
        "application/wasm",
        "image/svg+xml",
    ]);
});
// Fastest, not best: on the free plan CPU is the scarce thing, and the
// difference in size on this content is a few per cent.
builder.Services.Configure<BrotliCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);
builder.Services.Configure<GzipCompressionProviderOptions>(o => o.Level = CompressionLevel.Fastest);

var app = builder.Build();
app.UseResponseCompression();

// Types the browser refuses to run if they arrive as something else. A module
// served as text/plain is a blank screen and a console error, and Rapier's
// WebAssembly needs application/wasm for the streaming compile.
var contentTypes = new FileExtensionContentTypeProvider();
contentTypes.Mappings[".js"] = "text/javascript";
contentTypes.Mappings[".mjs"] = "text/javascript";
contentTypes.Mappings[".wasm"] = "application/wasm";
contentTypes.Mappings[".glb"] = "model/gltf-binary";
contentTypes.Mappings[".gltf"] = "model/gltf+json";
contentTypes.Mappings[".map"] = "application/json";

app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    ContentTypeProvider = contentTypes,
    OnPrepareResponse = ctx =>
    {
        var path = ctx.Context.Request.Path;
        var headers = ctx.Context.Response.Headers;
        if (path.StartsWithSegments("/vendor") || path.StartsWithSegments("/resources"))
        {
            // three.js, Rapier and the car models change when a version does,
            // which is roughly never; and they are most of the download.
            headers.CacheControl = "public, max-age=604800";
        }
        else
        {
            // The game's own code and page change on every deploy. Cached, but
            // revalidated, so a deploy is live immediately and an unchanged
            // file still costs only a 304.
            headers.CacheControl = "no-cache";
        }
    },
});

// For the deploy script to poll: the platform's own warm-up request goes to /,
// but this is cheap and says something specific.
app.MapGet("/healthz", () => Results.Text("ok", "text/plain"));

app.Run();
