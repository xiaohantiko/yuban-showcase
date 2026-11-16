namespace Yuban.Windows;

internal sealed class ConnectionDialog : Form
{
    private readonly TextBox address = new() { Width = 420, AccessibleName = "云端管理台 HTTPS 地址" };
    private readonly Label error = new() { AutoSize = true, ForeColor = Color.Firebrick };

    internal Uri? Address { get; private set; }

    internal ConnectionDialog(Uri? saved)
    {
        Text = "云端连接";
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        ShowInTaskbar = false;
        MaximizeBox = MinimizeBox = false;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;

        address.Text = saved?.AbsoluteUri ?? "";
        address.PlaceholderText = "https://yuban.example.com";
        var connect = new Button { Text = "保存并连接", AutoSize = true };
        var cancel = new Button { Text = "取消", AutoSize = true, DialogResult = DialogResult.Cancel };
        connect.Click += (_, _) => Connect();
        AcceptButton = connect;
        CancelButton = cancel;

        var actions = new FlowLayoutPanel { AutoSize = true, WrapContents = false };
        actions.Controls.AddRange([connect, cancel]);
        var layout = new FlowLayoutPanel
        {
            AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, FlowDirection = FlowDirection.TopDown,
            WrapContents = false, Padding = new Padding(18), Dock = DockStyle.Fill,
        };
        layout.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(420, 0), Text = "填写宇伴云端的 HTTPS 根地址，连接后即可注册或登录。" });
        layout.Controls.Add(address);
        layout.Controls.Add(actions);
        layout.Controls.Add(error);
        Controls.Add(layout);
        ActiveControl = address;
    }

    private void Connect()
    {
        var origin = ConsoleOrigin.Parse(address.Text);
        if (origin is null)
        {
            error.Text = "请输入有效的 HTTPS 根地址。";
            return;
        }
        Address = origin;
        DialogResult = DialogResult.OK;
    }
}
