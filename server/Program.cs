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

// --------------------------------------------------------- daily challenge
//
// The day's table of times (src/game/daily.js). The challenge itself is worked out from the date on each
// player's machine; only the times come here. Kept as one small JSON file a day under HOME, which on App
// Service is the site's own persistent storage -- no database, nothing to pay for.

var dailyDir = Path.Combine(
    Environment.GetEnvironmentVariable("HOME") is { Length: > 0 } home && Directory.Exists(home) ? home : AppContext.BaseDirectory,
    "data", "daily");
Directory.CreateDirectory(dailyDir);
var dailyLock = new object();
// How many lines of a day's table are kept, and how many are sent back.
const int DailyKeep = 200;
const int DailyShow = 20;

app.MapGet("/api/daily", (string? day) =>
{
    if (!DailyDayOk(day)) return Results.BadRequest();
    lock (dailyLock)
    {
        return Results.Json(DailyRead(dailyDir, day!).Take(DailyShow).ToList());
    }
});

app.MapPost("/api/daily", async (HttpContext http) =>
{
    DailyPost? post;
    try { post = await http.Request.ReadFromJsonAsync<DailyPost>(); }
    catch { return Results.BadRequest(); }
    if (post is null || !DailyDayOk(post.Day)) return Results.BadRequest();
    // Only today's run, or yesterday's for one finished just after midnight.
    var today = DateTime.UtcNow.Date;
    var day = DateTime.ParseExact(post.Day!, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
    if (day != today && day != today.AddDays(-1)) return Results.BadRequest();
    var name = new string((post.Name ?? string.Empty).Trim().ToUpperInvariant()
        .Where(c => char.IsAsciiLetterOrDigit(c) || c == ' ' || c == '_' || c == '-').ToArray());
    if (name.Length is 0 or > 16) return Results.BadRequest();
    if (double.IsNaN(post.Time) || post.Time < 15 || post.Time > 900) return Results.BadRequest();
    var car = post.Car is "runner" or "supercar" or "offroad" ? post.Car : "runner";
    // A name belongs, for the day, to the device that first posted with it: "How would you know it's you?
    // ... We don't want to have accounts." Each device makes a random key once and keeps it
    // (src/game/daily.js); the first time a name is used that day, the key's hash is kept against it, and
    // after that only that key may post under that name that day. Only the hash is stored.
    var key = post.Key ?? string.Empty;
    if (key.Length is < 16 or > 64 || !key.All(c => char.IsAsciiLetterOrDigit(c) || c == '-')) return Results.BadRequest();
    var keyHash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(key)));
    // Claimed for that day only, in a file of its own: "it's a new day, so it's still me." A name used on
    // one day is free again the next, like the table.
    var namesPath = Path.Combine(dailyDir, post.Day + ".names.json");
    lock (dailyLock)
    {
        var names = NamesRead(namesPath);
        if (names.TryGetValue(name, out var owner))
        {
            if (owner != keyHash) return Results.Conflict(new { error = "taken" });
        }
        else
        {
            names[name] = keyHash;
            File.WriteAllText(namesPath, System.Text.Json.JsonSerializer.Serialize(names));
        }
        var rows = DailyRead(dailyDir, post.Day!);
        // One line a name: their best.
        var mine = rows.FindIndex(r => r.Name == name);
        if (mine >= 0 && rows[mine].Time <= post.Time) return Results.Json(rows.Take(DailyShow).ToList());
        if (mine >= 0) rows.RemoveAt(mine);
        rows.Add(new DailyEntry(name, Math.Round(post.Time, 2), car));
        rows = rows.OrderBy(r => r.Time).Take(DailyKeep).ToList();
        File.WriteAllText(Path.Combine(dailyDir, post.Day + ".json"), System.Text.Json.JsonSerializer.Serialize(rows));
        return Results.Json(rows.Take(DailyShow).ToList());
    }
});

static bool DailyDayOk(string? day) =>
    day is { Length: 10 }
    && DateTime.TryParseExact(day, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture,
        System.Globalization.DateTimeStyles.None, out _);

static Dictionary<string, string> NamesRead(string path)
{
    if (!File.Exists(path)) return new Dictionary<string, string>();
    try
    {
        return System.Text.Json.JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(path))
            ?? new Dictionary<string, string>();
    }
    catch
    {
        return new Dictionary<string, string>();
    }
}

static List<DailyEntry> DailyRead(string dir, string day)
{
    var path = Path.Combine(dir, day + ".json");
    if (!File.Exists(path)) return new List<DailyEntry>();
    try
    {
        return System.Text.Json.JsonSerializer.Deserialize<List<DailyEntry>>(File.ReadAllText(path)) ?? new List<DailyEntry>();
    }
    catch
    {
        return new List<DailyEntry>();
    }
}

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
    var night = q["night"].ToString() == "1";
    var rain = q["rain"].ToString() == "1";
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
    var (found, _, error) = rooms.Enter(room, id, name, map, night, rain, create);
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
        conditions = new { night = found.Night, rain = found.Rain },
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
        // A connection that a reconnect has already replaced is not a player
        // leaving, and must not be announced as one -- see Rooms.Remove.
        if (rooms.Remove(found, player))
        {
            await Broadcast(found, new { t = "bye", from = player.Id }, CancellationToken.None);
        }
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

/// <summary>A time sent in: the day, a name, seconds, and the day's car.</summary>
record DailyPost(string? Day, string? Name, double Time, string? Car, string? Key);

/// <summary>One line of a day's table.</summary>
record DailyEntry(string Name, double Time, string Car);
