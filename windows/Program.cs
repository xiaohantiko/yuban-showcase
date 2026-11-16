namespace Yuban.Windows;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args is ["--self-test"])
        {
            var connection = ConsoleStorage.RunSelfTest();
            if (connection != 0) return connection;
            return LoginCredentials.RunSelfTest() ? 0 : 2;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
        return 0;
    }
}
