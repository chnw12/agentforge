// Stand-in for claude.exe / codex.exe in tests (compiled with csc, then copied to both names).
// Reads the prompt from stdin, waits for the LAST "SLEEP=<ms>" in it, appends a line to work_<agent>.txt in the
// current directory (so every run produces a commit) and answers in the format the real CLI emits.
// The LAST "FAIL=<n>" in the prompt (n != 0) makes it exit 1; verifier / reviewer prompts get the verdict line they require.
using System;
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;

class FakeAgent
{
    static int Main(string[] args)
    {
        string agent = Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]).ToLowerInvariant();
        if (Array.IndexOf(args, "--version") >= 0) { Console.WriteLine("fake-" + agent + " 0.0.0"); return 0; } // the app probes this at startup without feeding stdin
        string prompt = Console.In.ReadToEnd();

        int ms = 100;
        foreach (Match m in Regex.Matches(prompt, @"SLEEP=(\d+)")) ms = int.Parse(m.Groups[1].Value);
        int fail = 0;
        foreach (Match m in Regex.Matches(prompt, @"FAIL=(\d+)")) fail = int.Parse(m.Groups[1].Value);
        string note = "";
        int at = prompt.IndexOf("# Follow-up instruction from the user");
        if (at >= 0)
        {
            string rest = prompt.Substring(at);
            string[] lines = rest.Split('\n');
            note = lines.Length > 2 ? lines[2].Trim() : "";
        }

        Console.WriteLine("{\"type\":\"system\"}");
        Console.Out.Flush();
        Thread.Sleep(ms);
        if (fail != 0) { Console.Error.WriteLine("fake failure requested"); return 1; }

        File.AppendAllText("work_" + agent + ".txt", (note.Length == 0 ? "initial" : "follow:" + note) + "\n");
        string msg = "fake " + agent + (note.Length == 0 ? " finished" : " finished follow-up");
        if (prompt.Contains("VERIFIER (read-only)")) msg += " VERDICT: PASS";
        else if (prompt.Contains("CROSS-REVIEWER")) msg += " VERDICT: APPROVE";

        if (agent == "codex")
        {
            for (int i = 0; i < args.Length - 1; i++)
                if (args[i] == "-o") File.WriteAllText(args[i + 1], msg);
            Console.WriteLine("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"" + msg + "\"}}");
        }
        else
        {
            Console.WriteLine("{\"type\":\"result\",\"is_error\":false,\"result\":\"" + msg + "\"}");
        }
        return 0;
    }
}
