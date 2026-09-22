using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace PoliceChase.Server;

/// <summary>
/// The multiplayer relay: rooms of players, and a pipe between them.
///
/// It runs no game. Every client simulates the world for itself and the one
/// who created the room -- the escapee -- owns the chase, so all this has to
/// do is remember who is in which room, tell a newcomer which map is being
/// played, and pass packets on unread. That is deliberate: the free App
/// Service plan has a CPU quota to respect, and a relay costs almost nothing.
/// </summary>
public sealed class Rooms
{
    /// <summary>Rooms with nobody in them are forgotten after this.</summary>
    private static readonly TimeSpan EmptyFor = TimeSpan.FromMinutes(2);

    private readonly ConcurrentDictionary<string, Room> _rooms = new(StringComparer.OrdinalIgnoreCase);

    public sealed class Player
    {
        public required string Id { get; init; }
        public required string Name { get; init; }
        public required string Role { get; init; }
        public required WebSocket Socket { get; init; }
        // One send at a time per socket: WebSocket.SendAsync must not overlap,
        // and every player is sent to from every other player's receive loop.
        public SemaphoreSlim Lock { get; } = new(1, 1);
    }

    public sealed class Room
    {
        public required string Name { get; init; }
        public required string Map { get; set; }
        public string? EscapeeId { get; set; }
        public DateTimeOffset EmptySince { get; set; }
        public ConcurrentDictionary<string, Player> Players { get; } = new();
    }

    public bool Exists(string name) => _rooms.ContainsKey(name);

    /// <summary>
    /// Put a player in a room. Creating one that is already there, or joining
    /// one that is not, is refused: the name is the whole of the lobby, so
    /// getting it wrong has to say so rather than quietly opening a game with
    /// one person in it.
    /// </summary>
    public (Room? room, Player? player, string? error) Enter(
        string roomName, string id, string name, string map, bool create)
    {
        Sweep();
        if (create)
        {
            var fresh = new Room { Name = roomName, Map = string.IsNullOrWhiteSpace(map) ? "ashfield" : map };
            if (!_rooms.TryAdd(roomName, fresh))
            {
                return (null, null, $"There is already a game called \"{roomName}\".");
            }
        }
        else if (!_rooms.TryGetValue(roomName, out _))
        {
            return (null, null, $"No game called \"{roomName}\".");
        }

        if (!_rooms.TryGetValue(roomName, out var room))
        {
            return (null, null, "That game has just closed.");
        }
        return (room, null, null);
    }

    public Player Add(Room room, string id, string name, WebSocket socket, bool create)
    {
        // The creator is the escapee; so is the first person in, if the
        // escapee left and somebody is still here.
        var role = create || room.EscapeeId is null ? "escapee" : "police";
        var player = new Player { Id = id, Name = name, Role = role, Socket = socket };
        if (role == "escapee") room.EscapeeId = id;
        room.Players[id] = player;
        room.EmptySince = default;
        return player;
    }

    public void Remove(Room room, string id)
    {
        room.Players.TryRemove(id, out _);
        if (room.EscapeeId == id) room.EscapeeId = null;
        if (room.Players.IsEmpty)
        {
            room.EmptySince = DateTimeOffset.UtcNow;
            // A room whose escapee has gone has nothing left to play, but the
            // name is held briefly so the same one can be created again
            // without a confusing "already exists".
            _rooms.TryRemove(room.Name, out _);
        }
    }

    private void Sweep()
    {
        foreach (var (name, room) in _rooms)
        {
            if (room.Players.IsEmpty && room.EmptySince != default
                && DateTimeOffset.UtcNow - room.EmptySince > EmptyFor)
            {
                _rooms.TryRemove(name, out _);
            }
        }
    }

    public static object Roster(Room room) =>
        room.Players.Values.Select(p => new { id = p.Id, name = p.Name, role = p.Role }).ToArray();

    /// <summary>Send one message to one player, never overlapping a send.</summary>
    public static async Task SendAsync(Player player, object message, CancellationToken token)
    {
        if (player.Socket.State != WebSocketState.Open) return;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message);
        await player.Lock.WaitAsync(token);
        try
        {
            await player.Socket.SendAsync(bytes, WebSocketMessageType.Text, true, token);
        }
        catch (WebSocketException) { /* it went away mid-send; the loop will notice */ }
        catch (OperationCanceledException) { }
        finally { player.Lock.Release(); }
    }

    /// <summary>Pass a packet on, exactly as it arrived, to everyone else.</summary>
    public static async Task RelayAsync(Room room, string fromId, ArraySegment<byte> payload, CancellationToken token)
    {
        foreach (var other in room.Players.Values)
        {
            if (other.Id == fromId || other.Socket.State != WebSocketState.Open) continue;
            await other.Lock.WaitAsync(token);
            try
            {
                await other.Socket.SendAsync(payload, WebSocketMessageType.Text, true, token);
            }
            catch (WebSocketException) { }
            catch (OperationCanceledException) { }
            finally { other.Lock.Release(); }
        }
    }

    public static string Describe(Room room) =>
        $"{room.Name}: {room.Players.Count} player(s), map {room.Map}";

    public IEnumerable<object> List() => _rooms.Values.Select(r => new
    {
        name = r.Name,
        map = r.Map,
        players = r.Players.Count,
        hasEscapee = r.EscapeeId is not null,
    });

    public static Encoding Utf8 => Encoding.UTF8;
}
