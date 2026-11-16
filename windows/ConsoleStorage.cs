using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Yuban.Windows;

internal static partial class ConsoleOrigin
{
    internal static Uri? Parse(string? value)
    {
        var text = value?.Trim() ?? "";
        if (text.Length > 2048 || !RootAddress().IsMatch(text)
            || !Uri.TryCreate(text, UriKind.Absolute, out var uri) || !uri.IsWellFormedOriginalString()
            || uri.UserInfo.Length != 0 || uri.IdnHost.Length == 0 || uri.Port is < 1 or > 65535
            || IsRetiredPreview(uri))
            return null;

        return new UriBuilder(Uri.UriSchemeHttps, uri.IdnHost.ToLowerInvariant(), uri.IsDefaultPort ? -1 : uri.Port, "/").Uri;
    }

    internal static bool Contains(Uri origin, Uri candidate) => candidate.IsAbsoluteUri
        && candidate.Scheme == Uri.UriSchemeHttps && candidate.UserInfo.Length == 0
        && origin.IdnHost.Equals(candidate.IdnHost, StringComparison.OrdinalIgnoreCase)
        && origin.Port == candidate.Port;

    internal static bool IsRetiredPreview(Uri uri) => uri.IdnHost.TrimEnd('.')
        .Equals("yuban-preview.invalid", StringComparison.OrdinalIgnoreCase);

    [GeneratedRegex(@"\A(?i:https)://[^/?#\\\s@]+/?\z", RegexOptions.CultureInvariant)]
    private static partial Regex RootAddress();
}

internal static class ConsoleConnection
{
    private const string NotEnabled = "此地址尚未启用宇伴多人账号。请确认部署已更新并开启账号功能。";
    private const string InvalidStatus = "此地址未返回有效的宇伴账号状态。请检查云端地址和部署。";
    private const int StatusLimit = 4096;
    private static readonly HttpClient Client = new(new HttpClientHandler
    {
        AllowAutoRedirect = false, UseCookies = false, UseDefaultCredentials = false,
    }) { Timeout = Timeout.InfiniteTimeSpan };

    internal static async Task<string?> CheckAsync(Uri origin, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(8));
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(origin, "/api/auth/status"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.CacheControl = new CacheControlHeaderValue { NoCache = true, NoStore = true };
        try
        {
            using var response = await Client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            return await CheckResponseAsync(response, timeout.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return "连接超时。请检查云端地址和网络，然后重试。";
        }
        catch (HttpRequestException error) when (error.HttpRequestError == HttpRequestError.SecureConnectionError)
        {
            return "无法验证服务器的 HTTPS 证书。请检查云端地址和证书配置。";
        }
        catch (HttpRequestException) { return "无法连接云端。请检查云端地址、网络和服务状态。"; }
        catch (IOException) { return "连接中断。请检查网络和云端服务，然后重试。"; }
    }

    internal static async Task<string?> CheckResponseAsync(HttpResponseMessage response, CancellationToken cancellationToken)
    {
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Forbidden or HttpStatusCode.Unauthorized)
            return NotEnabled;
        if ((int)response.StatusCode is >= 300 and < 400)
            return "账号检查被重定向。请填写最终的 HTTPS 根地址。";
        if (response.StatusCode != HttpStatusCode.OK)
            return $"账号服务返回 HTTP {(int)response.StatusCode}。请检查云端服务，然后重试。";
        if (!string.Equals(response.Content.Headers.ContentType?.MediaType, "application/json", StringComparison.OrdinalIgnoreCase)
            || response.Content.Headers.ContentLength > StatusLimit) return InvalidStatus;

        var bytes = new byte[StatusLimit + 1];
        using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        var count = await input.ReadAtLeastAsync(bytes, bytes.Length, false, cancellationToken);
        if (count > StatusLimit) return InvalidStatus;
        try
        {
            using var document = JsonDocument.Parse(bytes.AsMemory(0, count));
            var value = document.RootElement;
            if (value.ValueKind != JsonValueKind.Object) return InvalidStatus;
            return value.TryGetProperty("multi", out var multi) && multi.ValueKind == JsonValueKind.True ? null : NotEnabled;
        }
        catch (JsonException) { return InvalidStatus; }
    }
}

internal sealed class ConsoleStorage
{
    private sealed record Preference(string? Address);
    private readonly string file;

    internal ConsoleStorage(string? folder = null)
    {
        var directory = folder ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "YuBanPublic");
        file = Path.Combine(directory, "connection.json");
    }

    internal Uri? ReadOrigin()
    {
        try
        {
            var preference = JsonSerializer.Deserialize<Preference>(File.ReadAllText(file));
            return ConsoleOrigin.Parse(preference?.Address);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException) { return null; }
    }

    internal static Uri? ReadBundledOrigin(string directory)
    {
        try
        {
            var item = new FileInfo(Path.Combine(directory, "connection-url.txt"));
            return item.Length <= 2_048 ? ConsoleOrigin.Parse(File.ReadAllText(item.FullName)) : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return null; }
    }

    internal bool SaveOrigin(Uri origin)
    {
        var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllBytes(temporary, JsonSerializer.SerializeToUtf8Bytes(new Preference(origin.AbsoluteUri)));
            File.Move(temporary, file, overwrite: true);
            return true;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return false; }
        finally
        {
            try { File.Delete(temporary); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    internal static int RunSelfTest()
    {
        string? temporary = null;
        try
        {
            temporary = Directory.CreateTempSubdirectory("YuBan-ConnectionTest-").FullName;
            var storage = new ConsoleStorage(temporary);
            var origin = ConsoleOrigin.Parse("https://EXAMPLE.invalid:443");
            var otherPort = ConsoleOrigin.Parse("https://example.invalid:8443/");
            if (origin?.AbsoluteUri != "https://example.invalid/" || otherPort is null
                || ConsoleOrigin.Parse("http://example.invalid") is not null
                || ConsoleOrigin.Parse("https://example.invalid/folder/..") is not null
                || ConsoleOrigin.Parse("https://yuban-preview.invalid") is not null
                || !ConsoleOrigin.Contains(origin, new Uri(origin, "/login")) || ConsoleOrigin.Contains(origin, otherPort)
                || storage.ReadOrigin() is not null || ReadBundledOrigin(temporary) is not null) return 1;

            var bundled = Path.Combine(temporary, "connection-url.txt");
            File.WriteAllText(bundled, "https://EXAMPLE.invalid:443/\n");
            if (ReadBundledOrigin(temporary) != origin) return 1;
            File.WriteAllText(bundled, "http://example.invalid/");
            if (ReadBundledOrigin(temporary) is not null) return 1;

            File.WriteAllText(Path.Combine(temporary, "connection.json"), "{\"Address\":\"https://example.invalid/\",\"OpenCloud\":false}");
            if (storage.ReadOrigin() != origin || !storage.SaveOrigin(otherPort) || storage.ReadOrigin() != otherPort) return 1;
            if (!AcceptStatus(HttpStatusCode.OK, "{\"multi\":true,\"registered\":false}")
                || AcceptStatus(HttpStatusCode.OK, "{\"multi\":false}")
                || AcceptStatus(HttpStatusCode.OK, "{\"multi\":\"true\"}")
                || AcceptStatus(HttpStatusCode.OK, "<html>login</html>")
                || AcceptStatus(HttpStatusCode.OK, "{\"multi\":true}", "text/plain")
                || AcceptStatus(HttpStatusCode.TemporaryRedirect, "{\"multi\":true}")
                || AcceptStatus(HttpStatusCode.Unauthorized, "{\"multi\":true}")
                || AcceptStatus(HttpStatusCode.OK, "{\"multi\":true}" + new string(' ', 4096))) return 1;
            return 0;
        }
        catch { return 1; }
        finally
        {
            if (temporary is not null)
            {
                try { Directory.Delete(temporary, recursive: true); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
    }

    private static bool AcceptStatus(HttpStatusCode status, string content, string mediaType = "application/json")
    {
        using var response = new HttpResponseMessage(status) { Content = new StringContent(content, Encoding.UTF8, mediaType) };
        return ConsoleConnection.CheckResponseAsync(response, CancellationToken.None).GetAwaiter().GetResult() is null;
    }
}
