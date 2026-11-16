using System.Buffers;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Yuban.Windows;

internal sealed record SavedLogin(string Username, string Password)
{
    internal static SavedLogin? Validate(string? username, string? password)
    {
        if (username is null || username.Length is < 2 or > 32 || !SingleLine(username, allowSpaces: false)
            || password is null || password.Length is < 8 or > 128 || !SingleLine(password, allowSpaces: true)
            || !password.Any(char.IsAsciiLetter) || !password.Any(char.IsAsciiDigit)) return null;
        return new SavedLogin(username, password);
    }

    private static bool SingleLine(string text, bool allowSpaces)
    {
        var remaining = text.AsSpan();
        while (!remaining.IsEmpty)
        {
            if (Rune.DecodeFromUtf16(remaining, out var rune, out var consumed) != OperationStatus.Done
                || Rune.GetUnicodeCategory(rune) is UnicodeCategory.Control or UnicodeCategory.Format or UnicodeCategory.PrivateUse
                    or UnicodeCategory.OtherNotAssigned or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator
                || (!allowSpaces && Rune.IsWhiteSpace(rune))) return false;
            remaining = remaining[consumed..];
        }
        return true;
    }
}

internal static class LoginCredentials
{
    private const uint Generic = 1;
    private const uint LocalMachine = 2;
    private const int NotFound = 1168;
    private const int MaxBlobSize = 1024;

    private static string Target(Uri origin)
    {
        var canonical = origin.GetLeftPart(UriPartial.Authority);
        return "YuBanPublic/Login/v1/" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)));
    }

    internal static bool TryLoad(Uri origin, out SavedLogin? login)
    {
        login = null;
        if (!CredRead(Target(origin), Generic, 0, out var pointer)) return Marshal.GetLastPInvokeError() == NotFound;

        try
        {
            var credential = Marshal.PtrToStructure<NativeCredential>(pointer);
            if (credential.Blob == IntPtr.Zero || credential.BlobSize is 0 or > MaxBlobSize) return false;
            var bytes = new byte[credential.BlobSize];
            try
            {
                Marshal.Copy(credential.Blob, bytes, 0, bytes.Length);
                var stored = JsonSerializer.Deserialize<SavedLogin>(bytes);
                login = SavedLogin.Validate(stored?.Username, stored?.Password);
                return login is not null;
            }
            catch (JsonException) { return false; }
            finally { CryptographicOperations.ZeroMemory(bytes); }
        }
        finally { CredFree(pointer); }
    }

    internal static bool Save(Uri origin, SavedLogin login)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(login);
        var pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try
        {
            if (bytes.Length > MaxBlobSize) return false;
            var credential = new NativeCredential
            {
                Type = Generic, TargetName = Target(origin), BlobSize = (uint)bytes.Length,
                Blob = pinned.AddrOfPinnedObject(), Persist = LocalMachine,
            };
            return CredWrite(ref credential, 0);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(bytes);
            pinned.Free();
        }
    }

    internal static bool Forget(Uri origin) => CredDelete(Target(origin), Generic, 0) || Marshal.GetLastPInvokeError() == NotFound;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NativeCredential
    {
        internal uint Flags;
        internal uint Type;
        internal string? TargetName;
        internal string? Comment;
        internal FILETIME LastWritten;
        internal uint BlobSize;
        internal IntPtr Blob;
        internal uint Persist;
        internal uint AttributeCount;
        internal IntPtr Attributes;
        internal string? TargetAlias;
        internal string? UserName;
    }

    [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredWrite(ref NativeCredential credential, uint flags);

    [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("Advapi32.dll", ExactSpelling = true)]
    private static extern void CredFree(IntPtr credential);

    internal static bool RunSelfTest()
    {
        var host = $"{Guid.NewGuid():N}.invalid";
        var origin = ConsoleOrigin.Parse($"https://{host}")!;
        var equivalent = ConsoleOrigin.Parse($"https://{host.ToUpperInvariant()}:443/")!;
        var differentPort = ConsoleOrigin.Parse($"https://{host}:8443/")!;
        var login = SavedLogin.Validate("测试账号", $"Fixture1😀{Guid.NewGuid():N}")!;
        var replacement = SavedLogin.Validate("另一个账号", $"Fixture2-{Guid.NewGuid():N}")!;
        try
        {
            return LoginCredentialRequest.IsLoginPage(origin, new Uri(origin, "/login").AbsoluteUri)
                && !LoginCredentialRequest.IsLoginPage(origin, new Uri(origin, "/login?next=/").AbsoluteUri)
                && !LoginCredentialRequest.IsLoginPage(origin, new Uri(origin, "/login#fragment").AbsoluteUri)
                && !LoginCredentialRequest.IsLoginPage(origin, origin.AbsoluteUri + "log%69n")
                && !LoginCredentialRequest.IsLoginPage(origin, new Uri(differentPort, "/login").AbsoluteUri)
                && LoginCredentialRequest.Parse("{\"kind\":\"yubanLoginCredential\",\"id\":\"probe-1\",\"action\":\"load\"}")?.Action == "load"
                && LoginCredentialRequest.Parse("{\"kind\":\"yubanLoginCredential\",\"id\":\"probe-1\",\"action\":\"unknown\"}") is null
                && SavedLogin.Validate("name\nother", "FixturePassword1") is null
                && TryLoad(origin, out var initial) && initial is null
                && Save(origin, login) && TryLoad(equivalent, out var stored) && stored == login
                && TryLoad(differentPort, out var isolated) && isolated is null
                && Save(equivalent, replacement) && TryLoad(origin, out stored) && stored == replacement
                && Forget(origin) && Forget(origin) && TryLoad(origin, out stored) && stored is null;
        }
        catch { return false; }
        finally { _ = Forget(origin); }
    }
}

internal sealed record LoginCredentialRequest(string Id, string Action, SavedLogin? Login)
{
    private const string Kind = "yubanLoginCredential";
    private static readonly JsonSerializerOptions ReplyOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    internal static bool IsLoginPage(Uri origin, string source) =>
        string.Equals(source, new Uri(origin, "/login").AbsoluteUri, StringComparison.Ordinal);

    internal static LoginCredentialRequest? Parse(string json)
    {
        if (json.Length > 2048) return null;
        try
        {
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 4 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || ReadString(root, "kind") != Kind) return null;
            var id = ReadString(root, "id");
            var action = ReadString(root, "action");
            if (id is null || id.Length is 0 or > 128 || !id.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_' or '.' or ':')
                || action is not ("load" or "save" or "forget")) return null;
            var login = action == "save" ? SavedLogin.Validate(ReadString(root, "username"), ReadString(root, "password")) : null;
            return new LoginCredentialRequest(id, action, login);
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException) { return null; }
    }

    private static string? ReadString(JsonElement root, string name) =>
        root.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() : null;

    internal string Respond(Uri origin)
    {
        SavedLogin? saved = null;
        var ok = Action switch
        {
            "load" => LoginCredentials.TryLoad(origin, out saved),
            "save" => Login is not null && LoginCredentials.Save(origin, Login),
            "forget" => LoginCredentials.Forget(origin),
            _ => false,
        };
        return JsonSerializer.Serialize(new { kind = Kind, id = Id, ok, username = saved?.Username, password = saved?.Password }, ReplyOptions);
    }
}
