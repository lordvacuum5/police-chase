using System.IO.Compression;
using System.Net.WebSockets;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.AspNetCore.StaticFiles;
using PoliceChase.Server;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddSingleton<Rooms>();

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

// ------------------------------------------------------------- multiplayer

app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });

// What is being played right now. Only ever used to look at.
app.MapGet("/api/games", (Rooms rooms) => Results.Json(rooms.List()));

/*
 * One socket per player. The query string is the whole handshake -- which game,
 * who, and whether they are creating it -- so there is no state machine here
 * beyond "in the room" and "not in the room".
 */
app.Map("/ws", async (HttpContext http, Rooms rooms, ILogger<Program> log) =>
{
    if (!http.WebSockets.IsWebSocketRequest)
    {
        http.Response.StatusCode = StatusCodes.Status400BadRequest;
        await http.Response.WriteAsync("WebSocket endpoint.");
        return;
    }

    var q = http.Request.Query;
    var room = (q["room"].ToString() ?? string.Empty).Trim();
    var id = (q["id"].ToString() ?? string.Empty).Trim();
    var name = (q["name"].ToString() ?? "Player").Trim();
    var map = (q["map"].ToString() ?? string.Empty).Trim();
    var create = q["create"].ToString() == "1";

    using var socket = await http.WebSockets.AcceptWebSocketAsync();
    var token = http.RequestAborted;

    if (room.Length is 0 or > 40 || id.Length is 0 or > 40)
    {
        await SendRaw(socket, new { t = "error", message = "Give the game a name." }, token);
        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bad request", CancellationToken.None);
        return;
    }

    // Refusals are sent down the socket rather than refused at the handshake,
    // because a browser cannot read the status code of a failed WebSocket
    // upgrade -- and "there is already a game called that" is worth reading.
    var (found, _, error) = rooms.Enter(room, id, name, map, create);
    if (error is not null || found is null)
    {
        await SendRaw(socket, new { t = "error", message = error ?? "Could not join." }, token);
        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "refused", CancellationToken.None);
        return;
    }

    var player = rooms.Add(found, id, name, socket, create);
    log.LogInformation("join {Room} as {Role} ({Desc})", room, player.Role, Rooms.Describe(found));

    await Rooms.SendAsync(player, new
    {
        t = "joined",
        id = player.Id,
        role = player.Role,
        map = found.Map,
        escapee = found.EscapeeId,
        players = Rooms.Roster(found),
    }, token);
    await Broadcast(found, new { t = "players", players = Rooms.Roster(found) }, token);

    // Packets are relayed as they arrived: the server never looks inside one.
    var buffer = new byte[64 * 1024];
    try
    {
        while (socket.State == WebSocketState.Open && !token.IsCancellationRequested)
        {
            var offset = 0;
            WebSocketReceiveResult result;
            do
            {
                var free = buffer.Length - offset;
                if (free <= 0) { offset = 0; free = buffer.Length; }   // oversized: drop it
                result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer, offset, free), token);
                if (result.MessageType == WebSocketMessageType.Close) break;
                offset += result.Count;
            }
            while (!result.EndOfMessage);

            if (result.MessageType == WebSocketMessageType.Close) break;
            if (offset == 0) continue;
            await Rooms.RelayAsync(found, player.Id, new ArraySegment<byte>(buffer, 0, offset), token);
        }
    }
    catch (OperationCanceledException) { /* the tab went away */ }
    catch (WebSocketException) { /* likewise, less politely */ }
    finally
    {
        rooms.Remove(found, player.Id);
        await Broadcast(found, new { t = "bye", from = player.Id }, CancellationToken.None);
        await Broadcast(found, new { t = "players", players = Rooms.Roster(found) }, CancellationToken.None);
        log.LogInformation("left {Room} ({Desc})", room, Rooms.Describe(found));
    }
});

static async Task SendRaw(WebSocket socket, object message, CancellationToken token)
{
    var bytes = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(message);
    if (socket.State == WebSocketState.Open)
    {
        await socket.SendAsync(bytes, WebSocketMessageType.Text, true, token);
    }
}

static async Task Broadcast(Rooms.Room room, object message, CancellationToken token)
{
    foreach (var other in room.Players.Values)
    {
        await Rooms.SendAsync(other, message, token);
    }
}

app.Run();
