using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Yuban.Windows;

internal sealed class MainForm : Form
{
    private static readonly Uri RuntimeDownload = new("https://developer.microsoft.com/microsoft-edge/webview2/#download-section");
    private readonly ConsoleStorage storage = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly Panel content = new() { Dock = DockStyle.Fill };
    private readonly Panel overlay = new() { Dock = DockStyle.Fill, BackColor = SystemColors.Window };
    private readonly Label message = new() { AutoSize = true, MaximumSize = new Size(590, 0) };
    private readonly Button runtimeHelp = new() { AutoSize = true, Text = "打开 Microsoft WebView2 下载页", Visible = false };
    private readonly ToolStripButton connectButton = new("云端连接");
    private readonly ToolStripButton retryButton = new("重试");
    private readonly ToolStripStatusLabel status = new();
    private Uri? savedOrigin;
    private BrowserSession? session;
    private bool switching;
    private bool connectionDialogOpen;
    private bool closed;

    internal MainForm()
    {
        Text = "宇伴";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1150, 780);
        MinimumSize = new Size(690, 550);
        AutoScaleMode = AutoScaleMode.Dpi;
        Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath);

        var toolbar = new ToolStrip { GripStyle = ToolStripGripStyle.Hidden, Dock = DockStyle.Top };
        toolbar.Items.AddRange([connectButton, retryButton]);
        connectButton.Click += (_, _) => OpenCloudConnection();
        retryButton.Click += (_, _) => OpenOrConnect();
        var statusBar = new StatusStrip { SizingGrip = false };
        statusBar.Items.Add(status);

        var overlayContent = new FlowLayoutPanel
        {
            AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false,
            Dock = DockStyle.Top, Padding = new Padding(28),
        };
        runtimeHelp.Click += (_, _) => OpenExternal(RuntimeDownload);
        overlayContent.Controls.AddRange([message, runtimeHelp]);
        overlay.Controls.Add(overlayContent);
        content.Controls.Add(overlay);
        Controls.Add(content);
        Controls.Add(toolbar);
        Controls.Add(statusBar);

        savedOrigin = storage.ReadOrigin() ?? ConsoleStorage.ReadBundledOrigin(AppContext.BaseDirectory);
        Shown += (_, _) => Post(OpenOrConnect);
        FormClosed += (_, _) =>
        {
            closed = true;
            lifetime.Cancel();
            CloseSession();
            lifetime.Dispose();
        };
    }

    private async void OpenOrConnect()
    {
        if (savedOrigin is Uri origin) await LoadConsoleAsync(origin);
        else
        {
            ShowMessage("请在「云端连接」中填写宇伴的 HTTPS 地址。", "等待连接");
            OpenCloudConnection();
        }
    }

    private async void OpenCloudConnection()
    {
        if (closed || switching || connectionDialogOpen) return;
        connectionDialogOpen = true;
        using var dialog = new ConnectionDialog(savedOrigin);
        Uri? origin;
        try { origin = dialog.ShowDialog(this) == DialogResult.OK ? dialog.Address : null; }
        finally { connectionDialogOpen = false; }
        if (origin is null || closed) return;

        savedOrigin = origin;
        if (!storage.SaveOrigin(origin))
            MessageBox.Show(this, "无法保存此地址。仍可连接，下次打开时需要重新填写。", "宇伴", MessageBoxButtons.OK, MessageBoxIcon.Information);
        await LoadConsoleAsync(origin);
    }

    private async Task LoadConsoleAsync(Uri origin)
    {
        if (switching || closed) return;
        switching = true;
        connectButton.Enabled = retryButton.Enabled = false;
        CloseSession();
        ShowMessage("正在检查云端账号服务…", "正在连接云端");
        try
        {
            var error = await ConsoleConnection.CheckAsync(origin, lifetime.Token);
            if (closed) return;
            if (error is not null)
            {
                ShowMessage(error, "云端连接失败");
                return;
            }

            var folder = Directory.CreateTempSubdirectory("YuBan-WebView2-").FullName;
            var next = new BrowserSession(new WebView2 { Dock = DockStyle.Fill, Visible = false }, folder, origin);
            session = next;
            content.Controls.Add(next.View);
            overlay.BringToFront();

            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: folder);
            if (!IsCurrent(next)) { DeleteBrowserFolder(folder); return; }
            environment.BrowserProcessExited += (_, _) => DeleteBrowserFolder(folder);
            var options = environment.CreateCoreWebView2ControllerOptions();
            options.IsInPrivateModeEnabled = true;
            await next.View.EnsureCoreWebView2Async(environment, options);
            if (!IsCurrent(next)) return;

            var core = next.View.CoreWebView2;
            ConfigureBrowser(next, core);
            core.Navigate(new Uri(origin, "/login").AbsoluteUri);
        }
        catch (OperationCanceledException) when (closed) { }
        catch (WebView2RuntimeNotFoundException)
        {
            CloseSession();
            ShowMessage("本机缺少 Microsoft Edge WebView2 Runtime。安装后点击「重试」。", "等待安装 WebView2", missingRuntime: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException
            or InvalidOperationException or NotSupportedException or System.Runtime.InteropServices.COMException)
        {
            CloseSession();
            ShowMessage("无法启动内置网页。请检查 WebView2 Runtime 和本机存储权限，然后重试。", "无法打开宇伴");
        }
        finally
        {
            switching = false;
            if (!closed) connectButton.Enabled = retryButton.Enabled = true;
        }
    }

    private void ConfigureBrowser(BrowserSession current, CoreWebView2 core)
    {
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.Settings.IsWebMessageEnabled = true;

        core.NavigationStarting += (_, args) =>
        {
            if (!IsCurrent(current) || !Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri))
            {
                args.Cancel = true;
                return;
            }
            if (!ConsoleOrigin.Contains(current.Origin, uri))
            {
                args.Cancel = true;
                if (args.IsUserInitiated && !args.IsRedirected)
                    Post(() => { if (IsCurrent(current)) OpenExternal(uri); });
                else if (!current.Ready) ShowMessage("管理台跳转到了另一个地址。请检查云端连接设置。", "云端连接失败");
                return;
            }
            current.NavigationId = args.NavigationId;
            current.LoginDocumentId = null;
            current.LoadingLoginId = null;
            current.PendingCredentialLoad = null;
        };
        core.FrameNavigationStarting += (_, args) =>
        {
            if (!IsCurrent(current) || LoginCredentialRequest.IsLoginPage(current.Origin, core.Source)
                || !Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri) || !ConsoleOrigin.Contains(current.Origin, uri))
                args.Cancel = true;
        };
        core.SourceChanged += (_, _) =>
        {
            if (!IsCurrent(current) || LoginCredentialRequest.IsLoginPage(current.Origin, core.Source)) return;
            current.LoginDocumentId = null;
            current.LoadingLoginId = null;
            current.PendingCredentialLoad = null;
        };
        core.ContentLoading += (_, args) =>
        {
            if (IsCurrent(current) && current.NavigationId == args.NavigationId && !args.IsErrorPage
                && LoginCredentialRequest.IsLoginPage(current.Origin, core.Source)) current.LoadingLoginId = args.NavigationId;
        };
        // CoreWebView2's event is for the top-level document. Frame message events are not subscribed.
        core.WebMessageReceived += (_, args) => ReceiveLoginCredential(current, core, args);
        core.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            if (!IsCurrent(current) || !args.IsUserInitiated || !Uri.TryCreate(args.Uri, UriKind.Absolute, out var uri)) return;
            Post(() =>
            {
                if (!IsCurrent(current)) return;
                if (ConsoleOrigin.Contains(current.Origin, uri)) core.Navigate(uri.AbsoluteUri);
                else OpenExternal(uri);
            });
        };
        core.PermissionRequested += (_, args) => args.State = CoreWebView2PermissionState.Deny;
        core.DownloadStarting += (_, args) => args.Cancel = true;
        core.BasicAuthenticationRequested += (_, args) => args.Cancel = true;
        core.ServerCertificateErrorDetected += (_, args) => args.Action = CoreWebView2ServerCertificateErrorAction.Cancel;
        core.NavigationCompleted += (_, args) => CompleteNavigation(current, core, args);
        core.ProcessFailed += (_, _) =>
        {
            if (!IsCurrent(current)) return;
            current.LoginDocumentId = null;
            current.LoadingLoginId = null;
            current.PendingCredentialLoad = null;
            ShowMessage("内置网页意外关闭。请点击「重试」。", "需要重试");
        };
    }

    private void ReceiveLoginCredential(BrowserSession current, CoreWebView2 core, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (!IsCurrent(current) || !LoginCredentialRequest.IsLoginPage(current.Origin, args.Source)
            || !LoginCredentialRequest.IsLoginPage(current.Origin, core.Source)) return;
        var request = LoginCredentialRequest.Parse(args.WebMessageAsJson);
        if (request is null) return;
        if (current.LoginDocumentId is ulong documentId && current.NavigationId == documentId)
            ReplyToLoginCredential(current, core, documentId, request);
        else if (request.Action == "load" && current.LoadingLoginId is ulong loadingId && current.NavigationId == loadingId)
            current.PendingCredentialLoad ??= request;
    }

    private void ReplyToLoginCredential(BrowserSession current, CoreWebView2 core, ulong documentId, LoginCredentialRequest request)
    {
        try
        {
            if (!IsCurrentLoginDocument(current, core, documentId)) return;
            var reply = request.Respond(current.Origin);
            if (IsCurrentLoginDocument(current, core, documentId)) core.PostWebMessageAsJson(reply);
        }
        catch (Exception error) when (error is InvalidOperationException or COMException) { }
    }

    private bool IsCurrentLoginDocument(BrowserSession current, CoreWebView2 core, ulong documentId) =>
        IsCurrent(current) && current.LoginDocumentId == documentId && current.NavigationId == documentId
        && LoginCredentialRequest.IsLoginPage(current.Origin, core.Source);

    private void CompleteNavigation(BrowserSession current, CoreWebView2 core, CoreWebView2NavigationCompletedEventArgs args)
    {
        if (!IsCurrent(current) || current.NavigationId != args.NavigationId) return;
        var pendingCredentialLoad = current.LoadingLoginId == args.NavigationId ? current.PendingCredentialLoad : null;
        current.PendingCredentialLoad = null;
        current.LoadingLoginId = null;
        var code = args.HttpStatusCode;
        if (args.IsSuccess && code is >= 200 and < 300
            && Uri.TryCreate(core.Source, UriKind.Absolute, out var destination) && ConsoleOrigin.Contains(current.Origin, destination))
        {
            if (LoginCredentialRequest.IsLoginPage(current.Origin, core.Source))
            {
                current.LoginDocumentId = args.NavigationId;
                if (pendingCredentialLoad is not null) ReplyToLoginCredential(current, core, args.NavigationId, pendingCredentialLoad);
            }
            current.Ready = true;
            overlay.Visible = false;
            current.View.Visible = true;
            status.Text = "已连接云端";
            return;
        }

        if (code == 401)
            ShowMessage("此地址要求旧版管理口令。请确认云端已启用宇伴多人账号。", "账号服务不可用");
        else if (args.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
            ShowMessage(code >= 400 ? $"管理台返回 HTTP {code}。请检查部署状态和连接地址。"
                : "无法打开云端页面。请检查网络、连接地址和 HTTPS 证书，然后重试。", "云端连接失败");
    }

    private bool IsCurrent(BrowserSession candidate) => !closed && ReferenceEquals(session, candidate);

    private void ShowMessage(string text, string statusText, bool missingRuntime = false)
    {
        if (closed) return;
        if (session is not null) session.View.Visible = false;
        message.Text = text;
        status.Text = statusText;
        runtimeHelp.Visible = missingRuntime;
        overlay.Visible = true;
        overlay.BringToFront();
    }

    private void Post(Action action)
    {
        if (!closed && IsHandleCreated) BeginInvoke(action);
    }

    private static void OpenExternal(Uri uri)
    {
        if (uri.Scheme is not ("http" or "https") || uri.UserInfo.Length != 0 || ConsoleOrigin.IsRetiredPreview(uri)) return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (System.ComponentModel.Win32Exception) { }
    }

    private void CloseSession()
    {
        var previous = session;
        session = null;
        if (previous is null) return;
        content.Controls.Remove(previous.View);
        previous.View.Dispose();
        DeleteBrowserFolder(previous.Folder);
    }

    private static void DeleteBrowserFolder(string folder)
    {
        try { Directory.Delete(folder, recursive: true); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private sealed class BrowserSession(WebView2 view, string folder, Uri origin)
    {
        internal WebView2 View { get; } = view;
        internal string Folder { get; } = folder;
        internal Uri Origin { get; } = origin;
        internal bool Ready { get; set; }
        internal ulong? NavigationId { get; set; }
        internal ulong? LoadingLoginId { get; set; }
        internal ulong? LoginDocumentId { get; set; }
        internal LoginCredentialRequest? PendingCredentialLoad { get; set; }
    }
}
