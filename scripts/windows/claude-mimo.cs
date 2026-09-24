// Build beside claude.exe with:
// csc.exe /nologo /target:exe /out:<bin>/claude-mimo.exe scripts/windows/claude-mimo.cs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

internal static class ClaudeMimo
{
    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        var slashes = 0;
        foreach (var ch in value)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"')
            {
                result.Append('\\', slashes * 2 + 1).Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes).Append(ch);
            slashes = 0;
        }
        result.Append('\\', slashes * 2).Append('"');
        return result.ToString();
    }

    private static int Main(string[] args)
    {
        var bin = Path.GetDirectoryName(typeof(ClaudeMimo).Assembly.Location);
        var claude = Path.Combine(bin, "claude.exe");
        var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude-mimo");
        if (!File.Exists(claude) || !File.Exists(Path.Combine(profile, "settings.json")))
        {
            Console.Error.WriteLine("claude-mimo requires claude.exe beside the launcher and a ~/.claude-mimo/settings.json profile.");
            return 78;
        }
        var start = new ProcessStartInfo(claude, String.Join(" ", Array.ConvertAll(args, Quote)));
        start.UseShellExecute = false;
        var inherited = new List<string>();
        foreach (string key in start.EnvironmentVariables.Keys)
        {
            if (key.StartsWith("ANTHROPIC_", StringComparison.OrdinalIgnoreCase)
                || key.StartsWith("CLAUDE_CODE_USE_", StringComparison.OrdinalIgnoreCase)
                || key.Equals("CLAUDE_CONFIG_DIR", StringComparison.OrdinalIgnoreCase)
                || key.Equals("CLAUDE_CODE_OAUTH_TOKEN", StringComparison.OrdinalIgnoreCase)) inherited.Add(key);
        }
        foreach (var key in inherited) start.EnvironmentVariables.Remove(key);
        start.EnvironmentVariables["CLAUDE_CONFIG_DIR"] = profile;
        try
        {
            using (var child = Process.Start(start))
            {
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("claude-mimo could not start Claude Code: " + error.Message);
            return 1;
        }
    }
}
