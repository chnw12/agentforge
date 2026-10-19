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
    static string JsonEsc(string s)
    {
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "").Replace("\n", "\\n");
    }

    static int Main(string[] args)
    {
        string agent = Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]).ToLowerInvariant();
        if (Array.IndexOf(args, "--version") >= 0) { Console.WriteLine("fake-" + agent + " 0.0.0"); return 0; } // the app probes this at startup without feeding stdin
        // read stdin as UTF-8 bytes: Console.In would decode with the console code page (CP949 on Korean Windows) and mangle Korean text
        string prompt;
        using (Stream stdin = Console.OpenStandardInput())
        using (MemoryStream buf = new MemoryStream())
        {
            stdin.CopyTo(buf);
            prompt = new System.Text.UTF8Encoding(false).GetString(buf.ToArray());
        }

        int ms = 100;
        foreach (Match m in Regex.Matches(prompt, @"SLEEP=(\d+)")) ms = int.Parse(m.Groups[1].Value);
        int fail = 0;
        foreach (Match m in Regex.Matches(prompt, @"FAIL=(\d+)")) fail = int.Parse(m.Groups[1].Value);
        // Planner request (ASCII markers only, the prompt itself is Korean): never writes files, answers with a proposal block.
        // Goal keywords: PROPOSE_PIPELINE -> mode pipeline (default best-of-n), NO_PROPOSAL -> no block, BAD_PROPOSAL -> broken JSON.
        // The reply echoes how many earlier turns ("### " sections) and context items it received, and its own command line.
        if (prompt.Contains("af-proposal"))
        {
            int turns = 0;
            foreach (string line in prompt.Split('\n')) if (line.StartsWith("### ")) turns++;
            Console.WriteLine("{\"type\":\"system\"}");
            if (agent == "claude") Console.WriteLine("{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"reading the repository\"}]}}"); // a progress line like the real CLI emits
            Console.Out.Flush();
            Thread.Sleep(ms);
            if (fail != 0) { Console.Error.WriteLine("fake failure requested"); return 1; }
            string fence = "```";
            string text = "plan from " + agent + " turns=" + turns + " ctx=" + (prompt.Contains("<<<ITEM 1") ? "yes" : "no") + " args=" + string.Join(" ", args);
            string block;
            if (prompt.Contains("NO_PROPOSAL")) block = "";
            else if (prompt.Contains("BAD_PROPOSAL")) block = fence + "af-proposal\n{ not json\n" + fence;
            else
                block = fence + "af-proposal\n{\"title\":\"fake proposal\",\"mode\":\"" + (prompt.Contains("PROPOSE_PIPELINE") ? "pipeline" : "best-of-n") +
                        "\",\"modeReason\":\"fake reason\",\"slotAgents\":[\"claude\",\"codex\"],\"prompt\":\"fake prompt from " + agent +
                        "\",\"rationale\":\"fake rationale\",\"risks\":[\"fake risk\"],\"questions\":[\"fake question\"]}\n" + fence;
            string full = text + "\n" + block;
            if (agent == "codex")
            {
                for (int i = 0; i < args.Length - 1; i++)
                    if (args[i] == "-o") File.WriteAllText(args[i + 1], full);
                Console.WriteLine("{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"" + JsonEsc(full) + "\"}}");
            }
            else Console.WriteLine("{\"type\":\"result\",\"is_error\":false,\"result\":\"" + JsonEsc(full) + "\"}");
            return 0;
        }

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
